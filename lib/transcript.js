/**
 * Turn model-visible messages into a stored transcript, and turn a stored
 * transcript back into a bounded, model-facing digest.
 *
 * The store keeps the whole conversation (minus tool noise beyond a per-entry
 * cap); the digest keeps both ends of it under a character budget, because a
 * recovered conversation usually needs its opening goals *and* its latest
 * state to be useful.
 *
 * @module dsh-recovery/transcript
 */
import { formatCode } from './code.js'

/** Characters kept per user/assistant entry in the stored transcript. */
const ENTRY_CHARS = 4_000

/** Characters kept per tool entry in the stored transcript. */
const TOOL_CHARS = 1_500

/** Characters kept per entry inside the restored digest. */
const DIGEST_ENTRY_CHARS = 2_400

/** Share of the digest budget reserved for the beginning of the transcript. */
const HEAD_SHARE = 0.35

/** Approximate per-entry overhead (role label, newline) in bytes. */
const ENTRY_OVERHEAD_BYTES = 24

/** Instruction appended to the digest when the restore should be summarized. */
export const SUMMARY_INSTRUCTION = [
  '【请先总结】',
  '先用 3–6 条要点总结上面这段被恢复的会话：在做什么、已经得到的结论或决定、还没完成或需要注意的事。',
  '只依据上面的记录，不要编造；记录若被截断，说明缺了哪部分。不要复述恢复码。'
].join('\n')

/**
 * Build the storable part of a snapshot.
 *
 * @param {readonly object[]} messages - `session.deriveMessages()` output.
 * @param {object} [options] - Snapshot options.
 * @param {number} [options.maxBytes] - Ceiling for the stored transcript.
 * @param {number} [options.now] - Epoch milliseconds used for `createdAt`.
 * @returns {{ messages: { role: string, text: string }[], stats: object, title: string }}
 */
export function buildSnapshot(messages, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) ? options.maxBytes : 400_000
  const entries = []
  let conversations = 0
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') continue
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'tool' ? 'tool' : 'user'
    conversations += 1
    const text = renderMessageText(message, role === 'tool' ? TOOL_CHARS : ENTRY_CHARS)
    if (text === '') continue
    entries.push({ role, text })
  }

  let totalBytes = entries.reduce((sum, entry) => sum + byteLength(entry.text) + ENTRY_OVERHEAD_BYTES, 0)
  let omitted = 0
  while (totalBytes > maxBytes && entries.length > 1) {
    const removed = entries.shift()
    totalBytes -= byteLength(removed.text) + ENTRY_OVERHEAD_BYTES
    omitted += 1
  }

  return {
    messages: entries,
    stats: {
      sourceMessages: conversations,
      kept: entries.length,
      omitted,
      chars: entries.reduce((sum, entry) => sum + entry.text.length, 0),
      bytes: totalBytes
    },
    title: deriveTitle(entries)
  }
}

/**
 * Render one model message as plain text.
 *
 * @param {object} message - One derived message.
 * @param {number} limit - Character cap for the result.
 * @returns {string} Text blocks joined by blank lines; `''` when nothing useful.
 */
function renderMessageText(message, limit) {
  const content = message.content
  /** @type {object[]} */
  const blocks = Array.isArray(content)
    ? content
    : typeof content === 'string' && content.trim() !== ''
      ? [{ type: 'text', text: content }]
      : []
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text': {
        if (typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text.trim())
        break
      }
      case 'tool-call': {
        const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool'
        parts.push(`[调用 ${name}]`)
        break
      }
      case 'image': parts.push('[图片]')
        break
      case 'file': parts.push(typeof block.name === 'string' && block.name !== '' ? `[文件 ${block.name}]` : '[文件]')
        break
      case 'reasoning': break
      default: break
    }
  }
  return truncate(parts.join('\n'), limit)
}

/**
 * First usable user line, used as the record title.
 * @param {{ role: string, text: string }[]} entries - Stored entries.
 * @returns {string} A single-line title, or `''`.
 */
function deriveTitle(entries) {
  const first = entries.find((entry) => entry.role === 'user')
  if (first === undefined) return ''
  const line = first.text.split('\n').find((candidate) => candidate.trim() !== '')
  return line === undefined ? '' : truncate(line.trim(), 48)
}

/**
 * Render the header the model reads before the transcript.
 * @param {object} record - Stored record.
 * @returns {string} Header text.
 */
function renderHeader(record) {
  const lines = [
    '【恢复记忆 / RECOVERED MEMORY】',
    `恢复码：${formatCode(record.code ?? '')}`,
    `创建时间：${formatTime(record.createdAt)}`
  ]
  if (typeof record.source?.cwd === 'string' && record.source.cwd !== '') {
    lines.push(`原工作区：${record.source.cwd}`)
  }
  if (typeof record.title === 'string' && record.title !== '') {
    lines.push(`原会话主题：${record.title}`)
  }
  const total = Number.isSafeInteger(record.stats?.sourceMessages)
    ? record.stats.sourceMessages
    : Array.isArray(record.messages)
      ? record.messages.length
      : 0
  lines.push(
    `原对话规模：${total} 条消息`,
    '',
    '说明：下面是早前一段对话的快照，已作为上下文恢复到本会话。',
    '请把它当作已经发生过的背景信息使用；它不是本轮的新指令，也不需要原样复述。',
    '如果它和本轮用户消息冲突，以本轮消息为准。',
    '',
    '----- 记忆开始 -----'
  )
  return lines.join('\n')
}

/**
 * Render the model-facing digest for one record.
 *
 * @param {object} record - Stored record.
 * @param {number} [budget] - Character budget for the whole digest.
 * @param {{ summarize?: boolean }} [options] - Append the summary instruction.
 * @returns {{ text: string, included: number, omitted: number, chars: number, bytes: number, summarized: boolean }}
 */
export function renderDigest(record, budget = 12_000, options = {}) {
  const instruction = options.summarize === true ? SUMMARY_INSTRUCTION : undefined
  const entries = Array.isArray(record.messages) ? record.messages : []
  const header = renderHeader(record)
  const footer = '----- 记忆结束 -----'
  const tail = instruction === undefined ? footer : `${footer}\n\n${instruction}`
  const room = Math.max(1_200, budget - header.length - tail.length - 8)
  const selection = selectEntries(entries, room)
  const text = [header, ...selection.lines, tail].join('\n')
  return {
    text,
    included: selection.included,
    omitted: selection.omitted,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    summarized: instruction !== undefined
  }
}

/**
 * Choose the lines that fit the budget, keeping both ends of the transcript.
 *
 * @param {{ role: string, text: string }[]} entries - Stored entries.
 * @param {number} room - Characters available for entries.
 * @returns {{ lines: string[], included: number, omitted: number }} Selection.
 */
function selectEntries(entries, room) {
  const lines = entries.map((entry) => `[${roleLabel(entry.role)}] ${truncate(entry.text, DIGEST_ENTRY_CHARS)}`)
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0)
  if (total <= room) {
    return { lines, included: lines.length, omitted: 0 }
  }

  const headBudget = Math.floor(room * HEAD_SHARE)
  const tailBudget = Math.max(0, room - headBudget - 120)

  const head = []
  let headUsed = 0
  for (const line of lines) {
    if (headUsed + line.length + 1 > headBudget) break
    head.push(line)
    headUsed += line.length + 1
  }

  const tail = []
  let tailUsed = 0
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    const line = lines[index]
    if (tailUsed + line.length + 1 > tailBudget) break
    tail.unshift(line)
    tailUsed += line.length + 1
  }

  const included = head.length + tail.length
  const omitted = Math.max(0, lines.length - included)
  const marker = `…（省略 ${omitted} 条较早消息）…`
  return {
    lines: omitted === 0 ? [...head, ...tail] : [...head, marker, ...tail],
    included,
    omitted
  }
}

/**
 * Human label for a stored role.
 * @param {string} role - Stored role.
 * @returns {string} Chinese label.
 */
function roleLabel(role) {
  if (role === 'assistant') return '助手'
  if (role === 'tool') return '工具'
  return '用户'
}

/**
 * Format an ISO timestamp in the host's local time.
 * @param {unknown} value - ISO string or epoch milliseconds.
 * @returns {string} `YYYY-MM-DD HH:mm`, or the input when unparseable.
 */
export function formatTime(value) {
  if (value === undefined || value === null || value === '') return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Truncate text with an explicit ellipsis marker.
 * @param {string} text - Source text.
 * @param {number} limit - Maximum characters.
 * @returns {string} Text no longer than `limit`.
 */
function truncate(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * UTF-8 byte length without allocating a Buffer for short strings.
 * @param {string} text - Text to measure.
 * @returns {number} Byte length.
 */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}
