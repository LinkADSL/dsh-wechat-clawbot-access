/**
 * Command-line parsing for the ClawBot runtime.
 * @module dsh-wechat-clawbot-access/runtime/daemon-options
 */
import { CHANNEL_VERSION, DEFAULT_BASE_URL } from './common.mjs'

/** Default maximum characters per WeChat message. */
export const DEFAULT_MAX_SEND_CHARS = 1800

/**
 * Parse daemon / one-shot command-line options.
 * @param {string[]} argv - process arguments after the script path.
 * @returns {object} normalized options.
 */
export function parseArgs(argv) {
  const options = {
    mode: 'daemon',
    stateDir: '',
    ownerPid: 0,
    ownerInstance: '',
    baseUrl: DEFAULT_BASE_URL,
    channelVersion: CHANNEL_VERSION,
    pushHour: 15,
    pushMinute: 0,
    pushEnabled: true,
    allowedUsers: [],
    maxSendChars: DEFAULT_MAX_SEND_CHARS,
    reuseTokenDays: 30,
    ipv6WatchMinutes: 60,
    sshPort: 22,
    qrTtlSeconds: 300,
    qrAutoRefresh: true,
    qrMaxAttempts: 12,
    retryDelayMs: 3000,
    logLevel: 'info',
  }
  const take = (index, inline) => {
    if (inline !== undefined) return { value: inline, next: index }
    const value = argv[index + 1]
    return { value, next: index + 1 }
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      if (['status', 'push', 'qr', 'probe', 'daemon'].includes(token)) options.mode = token
      continue
    }
    const equal = token.indexOf('=')
    const name = equal >= 0 ? token.slice(0, equal) : token
    const inline = equal >= 0 ? token.slice(equal + 1) : undefined
    const grab = () => {
      const taken = take(index, inline)
      index = taken.next
      return taken.value
    }
    switch (name) {
      case '--state-dir':
        options.stateDir = String(grab() ?? '')
        break
      case '--owner-pid':
        options.ownerPid = Math.max(0, Math.floor(Number(grab()) || 0))
        break
      case '--owner-instance':
        options.ownerInstance = String(grab() ?? '').trim()
        break
      case '--base-url':
        options.baseUrl = String(grab() ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL
        break
      case '--channel-version':
        options.channelVersion = String(grab() ?? CHANNEL_VERSION).trim() || CHANNEL_VERSION
        break
      case '--push-hour':
        options.pushHour = clampInteger(grab(), 0, 23, 15)
        break
      case '--push-minute':
        options.pushMinute = clampInteger(grab(), 0, 59, 0)
        break
      case '--no-push':
        options.pushEnabled = false
        break
      case '--allowed-users': {
        const raw = String(grab() ?? '').trim()
        options.allowedUsers = raw
          ? raw
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
          : []
        break
      }
      case '--max-send-chars':
        options.maxSendChars = clampInteger(grab(), 200, 4000, DEFAULT_MAX_SEND_CHARS)
        break
      case '--reuse-token-days':
        options.reuseTokenDays = clampInteger(grab(), 0, 3650, 30)
        break
      case '--ipv6-watch-minutes':
        options.ipv6WatchMinutes = clampInteger(grab(), 0, 1440, 60)
        break
      case '--ssh-port':
        options.sshPort = clampInteger(grab(), 1, 65535, 22)
        break
      case '--qr-ttl-seconds':
        options.qrTtlSeconds = clampInteger(grab(), 30, 1800, 300)
        break
      case '--no-qr-refresh':
        options.qrAutoRefresh = false
        break
      case '--qr-max-attempts':
        options.qrMaxAttempts = clampInteger(grab(), 1, 240, 12)
        break
      case '--retry-delay-ms':
        options.retryDelayMs = clampInteger(grab(), 500, 60000, 3000)
        break
      case '--log-level': {
        const level = String(grab() ?? '')
        options.logLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info'
        break
      }
      default:
        break
    }
  }
  return options
}

/**
 * Clamp a numeric option.
 * @param {unknown} value - raw value.
 * @param {number} min - minimum.
 * @param {number} max - maximum.
 * @param {number} fallback - default.
 * @returns {number} clamped integer.
 */
function clampInteger(value, min, max, fallback) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}


