/**
 * Recovery codes: 20 letters from a transcription-safe alphabet.
 *
 * `I` and `O` are excluded so a code can be read aloud, copied by hand, or
 * typed on a phone without being confused with `1` and `0`. Input is
 * normalised case-insensitively and separators (spaces, dashes, `+`, `:`) are
 * ignored, so `abcde-fghjk-lmnpq-rstuv`, `ABCDE FGHJK LMNPQ RSTUV` and
 * `ABCDEFGHJKLMNPQRSTUV` all name the same memory.
 *
 * @module dsh-recovery-memory/code
 */
import { randomInt as nodeRandomInt } from 'node:crypto'

/** Letters allowed in a code: the full alphabet minus the look-alikes I/O. */
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Exact number of letters in one code. */
export const CODE_LENGTH = 20

/** Separator used between display groups. */
export const GROUP_SEPARATOR = '-'

/** Letters per display group (4 × 5 = 20). */
export const GROUP_SIZE = 5

/** Everything a user may type between or around the letters. */
const SEPARATOR_CHARS = /[\s+:_-]/gu

/** A code body may only contain letters and the allowed separators. */
const CODE_PATTERN = /^[A-Z\s+:_-]+$/u

/**
 * Draw one uniform random code.
 *
 * @param {(max: number) => number} [randomInt] - Uniform integer source in
 *   `[0, max)`; defaults to `node:crypto.randomInt`. Injectable for tests.
 * @returns {string} 20 letters from {@link ALPHABET}.
 */
export function generateCode(randomInt = nodeRandomInt) {
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)]
  }
  return code
}

/**
 * Render a code in five dash-separated groups for display.
 *
 * @param {string} code - Raw or formatted code.
 * @returns {string} The grouped form, or the input unchanged when it is not a
 *   well-formed code.
 */
export function formatCode(code) {
  const normalized = normalizeCode(code)
  if (!normalized.ok) return String(code)
  return normalized.code.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'gu')).join(GROUP_SEPARATOR)
}

/**
 * Normalise user input into a canonical code.
 *
 * @param {unknown} raw - Whatever followed `memory`, including separators.
 * @returns {{ ok: true, code: string } | { ok: false, reason: string }}
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: '恢复码必须是文本' }
  const stripped = raw.trim()
  if (stripped === '') return { ok: false, reason: '没有给出恢复码' }
  const upper = stripped.toUpperCase()
  if (!CODE_PATTERN.test(upper)) {
    return { ok: false, reason: '恢复码只能包含字母（可以带空格、-、+ 或 : 分隔）' }
  }
  const compact = upper.replace(SEPARATOR_CHARS, '')
  if (compact.length !== CODE_LENGTH) {
    return { ok: false, reason: `恢复码是 ${CODE_LENGTH} 个字母，你给了 ${compact.length} 个` }
  }
  for (const letter of compact) {
    if (!ALPHABET.includes(letter)) {
      return { ok: false, reason: '恢复码不含字母 I 和 O（避免与数字 1/0 混淆）' }
    }
  }
  return { ok: true, code: compact }
}
