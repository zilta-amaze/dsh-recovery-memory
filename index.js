/**
 * dsh-recovery — conversation memory that survives a new conversation.
 *
 * `/recovery create` snapshots the current conversation, stores it under
 * `$DSH_HOME/recovery/`, and returns a 20-letter recovery code.
 * `/recovery memory <code>` in any other conversation injects that snapshot as
 * model-facing context, so the agent continues with the earlier background
 * instead of starting from zero.
 *
 * The plugin is deliberately dependency-free: it imports only Node built-ins,
 * so it loads from a linked profile without resolving any `@deepseek-ai/*`
 * package.
 *
 * @module dsh-recovery
 */
import { randomUUID } from 'node:crypto'
import { CODE_LENGTH, formatCode, normalizeCode } from './lib/code.js'
import { RECORD_VERSION, RecoveryStore } from './lib/store.js'
import { CLOSING, buildSnapshot, formatTime, renderDigest } from './lib/transcript.js'

/** Cordis plugin name. */
export const name = 'dsh-recovery'

/** Services this plugin needs composed before it starts. */
export const inject = ['commands']

const USAGE = [
  '用法：',
  '  /recovery create [备注]    把当前对话打包成 20 字母恢复码',
  '  /recovery memory <恢复码>  在新会话中恢复该对话的记忆',
  '  /recovery list             列出本机已保存的恢复码',
  '  /recovery delete <恢复码>  删除一条恢复记忆',
  '  /recovery where            查看记忆保存在哪个目录、怎么换位置',
  '',
  '恢复码是 20 个字母（不含 I/O，可带 - 分隔），例如 ABCDE-FGHJK-LMNPQ-RSTUV。',
  '',
  '恢复后会自动让模型总结上一段会话；加 --no-summary 可跳过这次总结。'
].join('\n')

/** The follow-up that makes the model summarize the restored conversation. */
const SUMMARY_REQUEST = '请按要求总结上面恢复的这段会话，最后一行写「记忆已恢复」。'

/**
 * Register the `/recovery` command.
 *
 * @param {object} ctx - Cordis context carrying the `commands` service.
 * @param {object} [config] - Plugin configuration.
 * @param {string} [config.dir] - Override the record directory.
 * @param {number} [config.maxRecordBytes] - Ceiling for one stored transcript.
 * @param {number} [config.restoreChars] - Model-facing digest budget.
 */
export function apply(ctx, config = {}) {
  const store = new RecoveryStore(config ?? {})
  ctx.commands.register({
    name: 'recovery',
    description: '把当前对话打包成 20 字母恢复码；在新会话用恢复码恢复记忆',
    input: {
      hint: 'create [备注] | memory <恢复码> [--no-summary] | list | delete <恢复码> | where'
    },
    handler: (invocation) => execute(invocation, store)
  })
}

/**
 * Dispatch one `/recovery` invocation.
 *
 * @param {object} invocation - Command invocation from the registry.
 * @param {RecoveryStore} store - Record store.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} UI result.
 */
async function execute(invocation, store) {
  const parsed = parseInput(invocation.rawInput)
  try {
    switch (parsed.kind) {
      case 'help':
        return { kind: 'success', text: USAGE }
      case 'create':
        return await createMemory(invocation, store, parsed.label)
      case 'restore':
        return await restoreMemory(invocation, store, parsed.code, parsed.noSummary)
      case 'list':
        return await listMemories(store)
      case 'where':
        return await whereMemories(store)
      case 'delete':
        return await deleteMemory(store, parsed.code)
      case 'missing-code':
        return {
          kind: 'error',
          text: `${parsed.action === 'delete' ? '删除' : '恢复'}需要给出恢复码，例如 /recovery ${parsed.action === 'delete' ? 'delete' : 'memory'} ABCDE-FGHJK-LMNPQ-RSTUV。`
        }
      default:
        return { kind: 'error', text: `无法识别这条指令。\n\n${USAGE}` }
    }
  } catch (error) {
    return { kind: 'error', text: `恢复记忆操作失败：${errorText(error)}` }
  }
}

/**
 * Snapshot the invoking conversation and persist it under a fresh code.
 *
 * @param {object} invocation - Command invocation.
 * @param {RecoveryStore} store - Record store.
 * @param {string} label - Optional user label.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} UI result.
 */
async function createMemory(invocation, store, label) {
  const session = invocation.agent?.session
  if (session === undefined || typeof session.deriveMessages !== 'function') {
    return { kind: 'error', text: '当前会话拿不到对话记录，无法生成恢复记忆。' }
  }

  const snapshot = buildSnapshot(session.deriveMessages(), { maxBytes: store.maxRecordBytes })
  if (snapshot.messages.length === 0) {
    return {
      kind: 'error',
      text: '当前对话还没有可以恢复的内容。先聊几轮，再执行 /recovery create。'
    }
  }

  const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : undefined
  const record = await store.writeUnique((code) => ({
    version: RECORD_VERSION,
    code,
    createdAt: new Date().toISOString(),
    label: typeof label === 'string' && label !== '' ? label : undefined,
    title: typeof label === 'string' && label !== '' ? label : snapshot.title,
    source: {
      sessionId: typeof session.id === 'string' ? session.id : undefined,
      cwd
    },
    stats: snapshot.stats,
    messages: snapshot.messages
  }))

  return { kind: 'success', text: renderCreated(record, snapshot.stats.omitted) }
}

/**
 * Inject one stored snapshot into the invoking conversation.
 *
 * @param {object} invocation - Command invocation.
 * @param {RecoveryStore} store - Record store.
 * @param {string} rawCode - Whatever the user typed for the code.
 * @param {boolean} [noSummary] - Skip the automatic summary for this restore.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} UI result.
 */
async function restoreMemory(invocation, store, rawCode, noSummary = false) {
  const normalized = normalizeCode(rawCode)
  if (!normalized.ok) {
    return {
      kind: 'error',
      text: `恢复码格式不正确：${normalized.reason}。\n恢复码是 ${CODE_LENGTH} 个字母（可用 - 分组），例如 ABCDE-FGHJK-LMNPQ-RSTUV。`
    }
  }

  const record = await store.read(normalized.code)
  if (record === undefined) {
    return {
      kind: 'error',
      text: `本机没有恢复码 ${formatCode(normalized.code)} 对应的记忆。\n用 /recovery list 查看已保存的恢复码。`
    }
  }

  const agent = invocation.agent
  if (agent === undefined || typeof agent.inject !== 'function') {
    return { kind: 'error', text: '当前客户端不支持注入恢复记忆。' }
  }

  const canFollowup = typeof agent.followup === 'function'
  const summarize = noSummary !== true && summaryEnabled(store) && canFollowup
  const digest = renderDigest(record, store.restoreChars, { summarize })
  agent.inject(createMemoryMessage(digest.text, normalized.code))

  let summaryStarted = false
  if (summarize) {
    try {
      agent.followup(createSummaryMessage())
      summaryStarted = true
    } catch {
      // The memory is already injected; a failed wake-up only loses the summary.
    }
  }
  return {
    kind: 'success',
    text: renderRestored(record, digest, { supported: canFollowup, started: summaryStarted })
  }
}

/**
 * Whether automatic post-restore summaries are enabled.
 * @param {RecoveryStore} store - Record store carrying the plugin config.
 * @returns {boolean} True unless the profile explicitly disabled it.
 */
function summaryEnabled(store) {
  return store.config?.autoSummary !== false
}

/**
 * Build the follow-up message that asks for the summary.
 * @returns {object} Frozen user-role message.
 */
function createSummaryMessage() {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: SUMMARY_REQUEST }],
    source: { kind: 'recovery', summary: true }
  })
}

/**
 * List the recovery records stored on this device.
 *
 * @param {RecoveryStore} store - Record store.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} UI result.
 */
async function listMemories(store) {
  const records = await store.list()
  if (records.length === 0) {
    return {
      kind: 'success',
      text: '本机还没有保存任何恢复记忆。\n在当前对话里执行 /recovery create 生成一个恢复码。'
    }
  }
  const lines = [`已保存的恢复记忆（共 ${records.length} 条，最新在前）：`, '']
  for (const record of records.slice(0, 10)) {
    const stats = record.stats ?? {}
    const size = formatBytes(Number.isSafeInteger(stats.bytes) ? stats.bytes : 0)
    const count = Number.isSafeInteger(stats.kept) ? stats.kept : record.messages.length
    const title = typeof record.title === 'string' && record.title !== '' ? `  ${record.title}` : ''
    lines.push(`  ${formatCode(record.code)}  ${formatTime(record.createdAt)}  ${count} 条 / ${size}${title}`)
  }
  if (records.length > 10) lines.push('', `还有 ${records.length - 10} 条没有显示。`)
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Show where records live and how to move them elsewhere.
 *
 * @param {RecoveryStore} store - Record store.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} UI result.
 */
async function whereMemories(store) {
  const info = await store.describe()
  const source = info.source === 'config'
    ? '配置项 dir'
    : info.source === 'env'
      ? '环境变量 DSH_RECOVERY_DIR'
      : '默认（$DSH_HOME/recovery）'
  const state = info.exists
    ? `${info.writable ? '可写' : '不可写'} · ${info.records} 条记忆`
    : '尚未创建（第一次 /recovery create 时自动建立）'
  return {
    kind: 'success',
    text: [
      `记忆目录：${info.dir}`,
      `来源：${source}`,
      `状态：${state}`,
      '',
      '换位置：在 profile 的 cordis.patch.yml 里给 dsh-recovery 加配置，例如',
      '  - id: dsh-recovery',
      '    config:',
      '      dir: /storage/emulated/0/Download/dsh-recovery',
      '支持 ~ 开头；相对路径按 $DSH_HOME 解析。改完需重启引擎。',
      '',
      '注意：换到共享存储/同步盘后，文件仍是明文 JSON，且 0600 权限在部分文件系统上',
      '不生效（本机实测 /storage/emulated/0 会退化成 0660）。'
    ].join('\n')
  }
}

/**
 * Delete one recovery record.
 *
 * @param {RecoveryStore} store - Record store.
 * @param {string} rawCode - Whatever the user typed for the code.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} UI result.
 */
async function deleteMemory(store, rawCode) {
  const normalized = normalizeCode(rawCode)
  if (!normalized.ok) {
    return { kind: 'error', text: `恢复码格式不正确：${normalized.reason}` }
  }
  const removed = await store.remove(normalized.code)
  return removed
    ? { kind: 'success', text: `已删除恢复记忆 ${formatCode(normalized.code)}。` }
    : { kind: 'error', text: `本机没有 ${formatCode(normalized.code)} 这条记忆，可能已经删除过。` }
}

/**
 * Build the model-facing message that carries a restored digest.
 *
 * The `recovery` source kind marks it as injected context rather than typed
 * user input, so the transcript renders it as a context block.
 *
 * @param {string} text - Digest text.
 * @param {string} code - Canonical code.
 * @returns {object} Frozen user-role message.
 */
function createMemoryMessage(text, code) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'recovery', code }
  })
}

/**
 * Render the `/recovery create` confirmation.
 *
 * @param {object} record - Written record.
 * @param {number} omitted - Entries dropped from the stored transcript.
 * @returns {string} Confirmation text.
 */
function renderCreated(record, omitted) {
  const stats = record.stats ?? {}
  const kept = Number.isSafeInteger(stats.kept) ? stats.kept : record.messages.length
  const size = formatBytes(Number.isSafeInteger(stats.bytes) ? stats.bytes : 0)
  const dropped = omitted > 0 ? `，省略 ${omitted} 条较早消息` : '，完整保存'
  const title = typeof record.title === 'string' && record.title !== '' ? [`  · 原会话：${record.title}`] : []
  const code = formatCode(record.code)
  return [
    '✅ 记忆已保存，恢复码：',
    '',
    `  ${code}`,
    '',
    `  · 抓取 ${stats.sourceMessages ?? kept} 条消息，保存 ${kept} 条（${size}）${dropped}`,
    `  · 生成于 ${formatTime(record.createdAt)}`,
    ...title,
    '',
    '在新对话里发送下面这行即可恢复：',
    `  /recovery memory ${code}`,
    '',
    '请把恢复码保存到安全的地方——它是这段记忆的唯一钥匙，不会自动同步。'
  ].join('\n')
}

/**
 * Render the `/recovery memory` confirmation.
 *
 * @param {object} record - Restored record.
 * @param {{ included: number, omitted: number, chars: number, bytes: number }} digest - Digest stats.
 * @param {{ supported: boolean, started: boolean }} [summary] - Summary capability and state.
 * @returns {string} Confirmation text.
 */
function renderRestored(record, digest, summary = { supported: false, started: false }) {
  const stats = record.stats ?? {}
  const total = Number.isSafeInteger(stats.sourceMessages) ? stats.sourceMessages : record.messages.length
  const stored = Array.isArray(record.messages) ? record.messages.length : total
  const loaded = digest.complete === true
    ? `本次完整载入 ${digest.included} 条（${formatBytes(digest.bytes)}）`
    : `本次载入 ${digest.included}/${stored} 条（${formatBytes(digest.bytes)}），其余 ${digest.omitted} 条仍在本机的完整记录里`
  const title = typeof record.title === 'string' && record.title !== '' ? [`  · 原会话：${record.title}`] : []
  const delivery = digest.complete === true ? '这段记忆已完整注入当前会话' : '这段记忆已作为上下文注入当前会话'
  return [
    `🧠 记忆载入完成：${formatCode(record.code)}`,
    '',
    `  · 来自 ${formatTime(record.createdAt)} 的对话（${total} 条消息）`,
    `  · ${loaded}`,
    ...title,
    '',
    summary.started === true
      ? `${delivery}，模型正据此总结上一段会话；你也可以直接接着提问。`
      : `${delivery}，从你下一条消息开始对模型生效。`,
    ...(summary.started !== true && summary.supported === false
      ? ['', '当前环境不支持自动总结，你可以直接问“刚才那个会话讲了什么”。']
      : []),
    '',
    CLOSING
  ].join('\n')
}

/**
 * Parse `/recovery` input.
 *
 * Control words are matched exactly; everything after them belongs to the
 * command. A bare 20-letter code is accepted as an implicit `memory`.
 *
 * @param {string} rawInput - Everything after `/recovery`.
 * @returns {{ kind: string, code?: string, label?: string, action?: string }} Parse result.
 */
function parseInput(rawInput) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/u).filter((token) => token !== '')
  const noSummary = tokens.some((token) => token === '--no-summary' || token === '-n')
  const input = tokens
    .filter((token) => token !== '--no-summary' && token !== '-n')
    .join(' ')
  if (input === '') return { kind: 'help' }
  const withFlag = (parsed) => ({ ...parsed, noSummary })

  const lower = input.toLowerCase()
  if (lower === 'create' || lower === 'new' || lower === 'save') return { kind: 'create', label: '' }
  if (lower === 'list' || lower === 'ls') return { kind: 'list' }
  if (lower === 'where' || lower === 'dir' || lower === 'path') return { kind: 'where' }
  if (lower === 'help' || lower === '?' || lower === '-h' || lower === '--help') return { kind: 'help' }
  if (lower === 'memory' || lower === 'restore' || lower === 'load') return { kind: 'missing-code', action: 'memory' }
  if (lower === 'delete' || lower === 'remove' || lower === 'rm' || lower === 'del') {
    return { kind: 'missing-code', action: 'delete' }
  }

  const [head, ...rest] = input.split(/\s+/u)
  const command = head.toLowerCase()
  const tail = rest.join(' ').trim()

  if (command === 'memory' || command === 'restore' || command === 'load') {
    return tail === ''
      ? { kind: 'missing-code', action: 'memory' }
      : withFlag({ kind: 'restore', code: stripSeparators(tail) })
  }
  if (command === 'create' || command === 'new' || command === 'save') {
    return { kind: 'create', label: tail }
  }
  if (command === 'delete' || command === 'remove' || command === 'rm' || command === 'del') {
    return tail === ''
      ? { kind: 'missing-code', action: 'delete' }
      : withFlag({ kind: 'delete', code: stripSeparators(tail) })
  }

  // A bare code is a shorthand for `memory <code>`.
  if (normalizeCode(input).ok) return withFlag({ kind: 'restore', code: input })

  // `memory<code>` / `delete<code>` with no separator, as in the short form
  // `/recovery memoryABCDEFGHJKLMNPQRSTUV`.
  for (const prefix of ['memory', 'restore', 'load']) {
    if (lower.startsWith(prefix) && input.length > prefix.length) {
      return withFlag({ kind: 'restore', code: stripSeparators(input.slice(prefix.length)) })
    }
  }
  for (const prefix of ['delete', 'remove']) {
    if (lower.startsWith(prefix) && input.length > prefix.length) {
      return withFlag({ kind: 'delete', code: stripSeparators(input.slice(prefix.length)) })
    }
  }

  return { kind: 'unknown' }
}

/**
 * Drop separator characters between a command word and a code.
 * @param {string} text - Raw suffix.
 * @returns {string} Suffix without leading separators.
 */
function stripSeparators(text) {
  return text.replace(/^[\s+:_-]+/u, '').trim()
}

/**
 * Render a byte count for humans.
 * @param {number} bytes - Byte count.
 * @returns {string} `812 B`, `18.2 KB`, or `1.4 MB`.
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Normalise an unexpected failure for display.
 * @param {unknown} error - Thrown value.
 * @returns {string} Human-readable message.
 */
function errorText(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * Deep-freeze a message the way the harness message constructors do.
 * @template T
 * @param {T} value - Value to freeze.
 * @returns {T} The same value, frozen recursively.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}
