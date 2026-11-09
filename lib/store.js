/**
 * Durable storage for recovery records.
 *
 * One JSON file per code under `$DSH_HOME/recovery/<CODE>.json`. Writes are
 * atomic (temp file + rename) and the directory/file modes are 0700/0600:
 * a recovered transcript is as private as the conversation it came from.
 *
 * @module dsh-recovery/store
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { generateCode, normalizeCode } from './code.js'

/** Schema version written into every record. */
export const RECORD_VERSION = 1

/** `<CODE>.json`, the only filenames this store owns. */
const CODE_FILE = /^([A-Z]{20})\.json$/u

/** Default ceiling for one stored transcript, in bytes. */
export const DEFAULT_MAX_RECORD_BYTES = 400_000

/** Default model-facing digest budget, in characters. */
export const DEFAULT_RESTORE_CHARS = 12_000

/**
 * Resolve the DeepSeek Harness home the same way `@deepseek-ai/dsh-home-paths`
 * does — explicit `$DSH_HOME` first, then `~/.dsh` — without importing it, so
 * this plugin stays dependency-free and resolvable from any profile.
 *
 * @param {Record<string, string | undefined>} [env] - Environment to read.
 * @returns {string} Absolute harness home.
 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  if (configured !== undefined && configured !== '') {
    return configured === '~' ? homedir() : resolve(homedir(), configured)
  }
  return join(homedir(), '.dsh')
}

/** Recovery records for one harness home. */
export class RecoveryStore {
  /**
   * @param {object} [config] - Plugin configuration.
   * @param {string} [config.dir] - Override the record directory.
   * @param {number} [config.maxRecordBytes] - Ceiling for one stored transcript.
   * @param {number} [config.restoreChars] - Model-facing digest budget.
   */
  constructor(config = {}) {
    this.config = config
    const dir = typeof config.dir === 'string' ? config.dir.trim() : ''
    this.dir = dir === '' ? join(resolveDshHome(), 'recovery') : resolve(dir)
  }

  /** @returns {number} Byte ceiling for one stored record. */
  get maxRecordBytes() {
    const configured = this.config.maxRecordBytes
    return Number.isSafeInteger(configured) && configured > 10_000 ? configured : DEFAULT_MAX_RECORD_BYTES
  }

  /** @returns {number} Character budget for one restored digest. */
  get restoreChars() {
    const configured = this.config.restoreChars
    return Number.isSafeInteger(configured) && configured > 1_000 ? configured : DEFAULT_RESTORE_CHARS
  }

  /**
   * Path of the record backing one validated code.
   * @param {string} code - Canonical 20-letter code.
   * @returns {string} Absolute file path.
   */
  fileFor(code) {
    const normalized = normalizeCode(code)
    if (!normalized.ok) throw new Error(`invalid recovery code: ${normalized.reason}`)
    return join(this.dir, `${normalized.code}.json`)
  }

  /** Create the record directory with owner-only permissions. */
  async ensureDir() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  /**
   * @param {string} code - Canonical code.
   * @returns {Promise<boolean>} Whether a record file exists.
   */
  async exists(code) {
    try {
      await readFile(this.fileFor(code), 'utf8')
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Persist one record atomically.
   * @param {object} record - Complete record, already carrying its code.
   * @returns {Promise<void>}
   */
  async write(record) {
    await this.ensureDir()
    const file = this.fileFor(record.code)
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    const body = `${JSON.stringify(record, undefined, 2)}\n`
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  }

  /**
   * Create a record under a fresh, unused code.
   *
   * @param {(code: string) => object} build - Builds the record for a code.
   * @returns {Promise<object>} The record that was written.
   */
  async writeUnique(build) {
    await this.ensureDir()
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = generateCode()
      if (await this.exists(code)) continue
      const record = build(code)
      await this.write(record)
      return record
    }
    throw new Error('无法生成不重复的恢复码，请再试一次')
  }

  /**
   * Read one record.
   *
   * @param {string} code - Raw or canonical code.
   * @returns {Promise<object | undefined>} The record, or `undefined` when no
   *   file exists for the code.
   * @throws {Error} When the file exists but is not a valid record.
   */
  async read(code) {
    const normalized = normalizeCode(code)
    if (!normalized.ok) return undefined
    let body
    try {
      body = await readFile(this.fileFor(normalized.code), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    let record
    try {
      record = JSON.parse(body)
    } catch {
      throw new Error(`恢复记忆文件已损坏（${normalized.code}）`)
    }
    if (record === null || typeof record !== 'object' || !Array.isArray(record.messages)) {
      throw new Error(`恢复记忆文件已损坏（${normalized.code}）`)
    }
    return record
  }

  /**
   * List stored records, newest first.
   *
   * @returns {Promise<object[]>} Record summaries; unreadable files are skipped.
   */
  async list() {
    let entries
    try {
      entries = await readdir(this.dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = CODE_FILE.exec(entry.name)
      if (match === null) continue
      try {
        const record = await this.read(match[1])
        if (record !== undefined) records.push(record)
      } catch {
        // A damaged file is skipped by the listing rather than hiding the rest.
      }
      if (records.length >= 50) break
    }
    records.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
    return records
  }

  /**
   * Delete one record.
   *
   * @param {string} code - Raw or canonical code.
   * @returns {Promise<boolean>} Whether a record was removed.
   */
  async remove(code) {
    const normalized = normalizeCode(code)
    if (!normalized.ok) return false
    try {
      await unlink(this.fileFor(normalized.code))
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }
}
