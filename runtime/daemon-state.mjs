/**
 * State helpers for the ClawBot runtime.
 * @module dsh-wechat-clawbot-access/runtime/daemon-state
 */
import { DEFAULT_BASE_URL, STATE_VERSION } from './common.mjs'
import { getAccessInfo } from './access-info.mjs'

/** @param {string} baseUrl - default iLink base URL. @returns {object} fresh empty state. */
export function emptyState(baseUrl) {
  return {
    version: STATE_VERSION,
    token: '',
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    loginAt: 0,
    loginConfirmedAt: 0,
    botUserId: '',
    syncBuf: '',
    ownerId: '',
    pendingOwner: null,
    pendingPush: null,
    users: {},
    watch: null,
    updatedAt: 0,
  }
}

/** @returns {object} fresh empty runtime status. */
export function emptyStatus() {
  return {
    version: STATE_VERSION,
    pid: 0,
    phase: 'stopped',
    connected: false,
    loginAt: 0,
    loginConfirmedAt: 0,
    ownerId: '',
    pendingOwner: null,
    pendingPush: null,
    qr: null,
    lastError: null,
    lastMessageAt: 0,
    lastReplyAt: 0,
    lastInfo: null,
    lastInfoMessage: '',
    lastPushAt: 0,
    lastPushResult: null,
    nextPushAt: 0,
    startedAt: 0,
    heartbeatAt: 0,
    users: [],
    stats: { messages: 0, replies: 0, pushes: 0 },
    logPath: '',
    pushEnabled: true,
    pushHour: 15,
    pushMinute: 0,
    ipv6WatchMinutes: 60,
    nextIpv6CheckAt: 0,
    lastIpv6CheckAt: 0,
    lastIpv6ProbeMs: 0,
    lastIpv6ProbeVia: '',
    watchedIpv6: '',
    lastIpv6ChangeAt: 0,
    ipv6WatchPending: false,
  }
}

/**
 * Run the access-info script safely, never throwing from a status/UI path.
 * @param {string} stateDir - state directory.
 * @returns {Promise<object|null>} info or null.
 */
export async function safeAccessInfo(stateDir, extra = {}) {
  try {
    return await getAccessInfo({ stateDir, ...extra })
  } catch {
    return null
  }
}

/**
 * Reduce an access info snapshot to the fields the UI needs.
 * @param {object|null} info - full access info.
 * @returns {object|null} summary.
 */
export function summarizeInfo(info) {
  if (!info || typeof info !== 'object') return null
  return {
    ok: Boolean(info.ok),
    checkedAt: info.checkedAt ?? '',
    ipv6: info.ipv6
      ? { address: info.ipv6.address, source: info.ipv6.source, interface: info.ipv6.interface ?? '' }
      : null,
    urls: info.urls ?? { ipv6: null, local: null },
    ssh: info.ssh && typeof info.ssh === 'object'
      ? {
          user: info.ssh.user,
          host: info.ssh.host,
          port: info.ssh.port,
          localPort: info.ssh.localPort,
          loginCommand: info.ssh.loginCommand,
          tunnelCommand: info.ssh.tunnelCommand,
          localUrl: info.ssh.localUrl,
          fingerprint: Array.isArray(info.ssh.hostKeys) ? info.ssh.hostKeys[0]?.fingerprint ?? '' : '',
        }
      : null,
    warnings: Array.isArray(info.warnings) ? info.warnings.map((row) => row?.code).filter(Boolean) : [],
    errors: Array.isArray(info.errors) ? info.errors.map((row) => row?.code).filter(Boolean) : [],
  }
}

/** @param {object|null} info - access info. @returns {string} first error message or ''. */
export function firstErrorText(info) {
  const errors = Array.isArray(info?.errors) ? info.errors : []
  return errors.length > 0 ? String(errors[0]?.message ?? errors[0]?.code ?? '') : ''
}

