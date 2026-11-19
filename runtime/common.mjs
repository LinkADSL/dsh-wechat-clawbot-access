/**
 * Shared filesystem, logging and naming helpers for the pure-script WeChat
 * ClawBot runtime.
 *
 * The runtime (daemon + one-shot commands) never imports DeepSeek Harness
 * packages: it is a plain Node program that reads and writes a small state
 * directory. The Host half of the bundle only spawns it and reads its state.
 *
 * @module dsh-wechat-clawbot-access/runtime/common
 */
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

/** Default state directory: `~/.dsh/wechat-clawbot`. */
export const DEFAULT_STATE_DIR = path.join(homedir(), '.dsh', 'wechat-clawbot')

/** Default iLink ClawBot base URL. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** iLink protocol channel version sent with every request. */
export const CHANNEL_VERSION = '1.0.2'

/** Current on-disk state schema version. */
export const STATE_VERSION = 3

/** Rotate the runtime log after this many bytes (0 disables rotation). */
export const LOG_MAX_BYTES = 2 * 1024 * 1024

/** Keep the current log plus this many rotated backups. */
export const LOG_MAX_BACKUPS = 3

/** File names inside the state directory. */
export const FILES = {
  state: 'state.json',
  status: 'status.json',
  dshWeb: 'dsh-web.json',
  routeSecret: 'route-secret',
  log: 'clawbot.log',
  commands: 'commands',
  logs: 'logs',
}

/**
 * Resolve the configured state directory.
 * @param value - explicit path from the Host config; empty means the default.
 * @returns {string} absolute state directory.
 */
export function resolveStateDir(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text) return path.resolve(text)
  return DEFAULT_STATE_DIR
}

/**
 * Create the state directory layout (0700) and the log directory.
 * @param {string} stateDir - absolute state directory.
 */
export async function ensureStateLayout(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await mkdir(path.join(stateDir, FILES.logs), { recursive: true, mode: 0o700 })
  await mkdir(path.join(stateDir, FILES.commands), { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700).catch(() => {})
}

/**
 * Read and parse one JSON file.
 * @param {string} file - absolute file path.
 * @param {unknown} fallback - value returned when the file is missing or unreadable JSON.
 * @returns {Promise<never|any>} parsed JSON or the fallback.
 */
export async function readJson(file, fallback = null) {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Atomically replace one JSON file: write a private temp file, then rename.
 * @param {string} file - destination path.
 * @param {unknown} value - JSON-serializable value.
 * @param {number} [mode] - file mode applied to the temp file (default 0600).
 */
export async function writeJsonAtomic(file, value, mode = 0o600) {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode })
  await rename(temporary, file)
  await chmod(file, mode).catch(() => {})
}

/** @returns {string} a short random identifier for command files. */
export function randomId() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/**
 * Check whether a pid currently belongs to a live process.
 * @param {unknown} pid - process id to test.
 * @returns {boolean} true when `/proc/<pid>` exists.
 */
export function processAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Read the first `arg` string of a process command line (used to avoid treating
 * a reused pid as the runtime).
 * @param {unknown} pid - process id.
 * @returns {Promise<string>} joined command line, or '' when unreadable.
 */
export async function processCommandLine(pid) {
  const value = Number(pid)
  try {
    const raw = await readFile(`/proc/${value}/cmdline`)
    return raw.toString('utf8').replace(/\0+/g, ' ').trim()
  } catch {
    // Linux without /proc, or a non-Linux host: fall back to ps where available.
  }
  if (process.platform === 'win32') return ''
  try {
    const { stdout } = await promisify(execFile)('ps', ['-p', String(value), '-o', 'command='], {
      timeout: 2000,
      maxBuffer: 128 * 1024,
    })
    return String(stdout ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * Read the persisted status object.
 * @param {string} stateDir - state directory.
 * @returns {Promise<object|null>} status or null.
 */
export async function readStatus(stateDir) {
  const value = await readJson(path.join(stateDir, FILES.status), null)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * Persist the status object.
 * @param {string} stateDir - state directory.
 * @param {object} status - status value.
 */
export async function writeStatus(stateDir, status) {
  await writeJsonAtomic(path.join(stateDir, FILES.status), status, 0o600)
}

/**
 * Write the `dsh-web.json` snapshot consumed by the access-info script.
 * @param {string} stateDir - state directory.
 * @param {{url: string, origin: string, port: number, token: string, pid?: number}} snapshot
 *   token-bearing DSH Web URL for the current DSH process.
 */
export async function writeDshWebSnapshot(stateDir, snapshot) {
  await writeJsonAtomic(
    path.join(stateDir, FILES.dshWeb),
    {
      url: snapshot.url,
      origin: snapshot.origin,
      port: snapshot.port,
      token: snapshot.token,
      pid: snapshot.pid ?? process.pid,
      at: Date.now(),
    },
    0o600,
  )
}

/**
 * Queue one control command for a running daemon. The daemon consumes the
 * directory in name order and deletes each file after handling it.
 * @param {string} stateDir - state directory.
 * @param {string} action - daemon action name.
 * @param {object} [args] - extra action arguments.
 * @returns {Promise<string>} the command file base name.
 */
export async function enqueueCommand(stateDir, action, args = {}) {
  const id = randomId()
  await writeJsonAtomic(
    path.join(stateDir, FILES.commands, `${id}.json`),
    { id, action: String(action), args: args && typeof args === 'object' ? args : {}, at: Date.now() },
    0o600,
  )
  return id
}

/**
 * List queued control commands in creation order.
 * @param {string} stateDir - state directory.
 * @returns {Promise<Array<{name: string, file: string, value: object}>>} queued commands.
 */
export async function listCommands(stateDir) {
  const directory = path.join(stateDir, FILES.commands)
  let names
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const rows = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const file = path.join(directory, name)
    const value = await readJson(file, null)
    if (value && typeof value === 'object' && typeof value.action === 'string') {
      rows.push({ name, file, value })
    } else {
      // Unreadable or partial command files are discarded so they cannot loop.
      await unlink(file).catch(() => {})
    }
  }
  return rows
}

/**
 * Delete one consumed control command.
 * @param {string} file - absolute command file path.
 */
export async function removeCommand(file) {
  await unlink(file).catch(() => {})
}

/**
 * Abort-aware delay.
 * @param {number} ms - milliseconds to wait.
 * @param {AbortSignal} [signal] - optional cancellation.
 * @returns {Promise<void>} resolves early when the signal aborts.
 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Split text into protocol-sized chunks, preferring paragraph boundaries.
 * @param {string} text - full message text.
 * @param {number} max - maximum characters per chunk.
 * @returns {string[]} non-empty chunks.
 */
export function chunkText(text, max) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim()
  const limit = Math.max(100, Math.floor(Number(max) || 1800))
  if (normalized.length <= limit) return normalized ? [normalized] : []
  const chunks = []
  let rest = normalized
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit * 0.4)) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.trim()) chunks.push(rest.trim())
  return chunks
}

/**
 * Extract the first text item from one iLink message.
 * @param {object} message - raw iLink message.
 * @returns {string} text, or '' when none is present.
 */
export function firstText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : []
  for (const item of items) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') return item.text_item.text
  }
  return ''
}

/** @param {unknown} error - any thrown value. @returns {string} its message. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Format one timestamp as a local ISO 8601 string with numeric offset.
 * @param {number} [time] - epoch milliseconds.
 * @returns {string} formatted timestamp.
 */
export function isoLocal(time = Date.now()) {
  const date = new Date(time)
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0')
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hours}:${minutes}`
}

/**
 * File logger with size-based rotation: `clawbot.log`, `.1`, `.2`, `.3`.
 * Messages are also mirrored to stderr so `journalctl` sees daemon activity.
 */
export class Logger {
  /**
   * @param {string} stateDir - state directory.
   * @param {{level?: string}} [options] - minimum level (debug|info|warn|error).
   */
  constructor(stateDir, options = {}) {
    this.file = path.join(stateDir, FILES.logs, FILES.log)
    this.levels = { debug: 10, info: 20, warn: 30, error: 40 }
    this.minimum = this.levels[options.level] ?? this.levels.info
    this.chain = Promise.resolve()
    this.appends = 0
  }

  /**
   * Append one log line.
   * @param {'debug'|'info'|'warn'|'error'} level - severity.
   * @param {string} message - text to append.
   */
  log(level, message) {
    const numeric = this.levels[level] ?? this.levels.info
    const line = `[${isoLocal()}] ${level.toUpperCase()} ${message}`
    if (numeric < this.minimum) return
    if (numeric >= this.levels.warn) process.stderr.write(`${line}\n`)
    this.chain = this.chain
      .then(async () => {
        await this.rotateIfNeeded()
        await writeFile(this.file, `${line}\n`, { flag: 'a', mode: 0o600 })
      })
      .catch(() => {})
  }

  /**
   * Rotate when the current log grows past {@link LOG_MAX_BYTES}.
   * Checking every 20 appends keeps tiny lines cheap while bounding growth.
   */
  async rotateIfNeeded() {
    this.appends += 1
    if (this.appends % 20 !== 0) return
    let info
    try {
      info = await stat(this.file)
    } catch {
      return
    }
    if (info.size <= LOG_MAX_BYTES) return
    // Shift oldest backups first, then move the current log one step back.
    for (let index = LOG_MAX_BACKUPS - 1; index >= 1; index -= 1) {
      await rename(`${this.file}.${index}`, `${this.file}.${index + 1}`).catch(() => {})
    }
    await rename(this.file, `${this.file}.1`).catch(() => {})
  }

  debug(message) {
    this.log('debug', message)
  }

  info(message) {
    this.log('info', message)
  }

  warn(message) {
    this.log('warn', message)
  }

  error(message) {
    this.log('error', message)
  }

  /** Wait until queued appends settle. */
  async flush() {
    await this.chain.catch(() => {})
  }
}
