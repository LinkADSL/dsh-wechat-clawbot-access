#!/usr/bin/env node
/**
 * WeChat ClawBot pure-script runtime for DeepSeek Harness.
 *
 * This program is deliberately standalone: it speaks the official WeChat
 * ClawBot channel (iLink, `ilinkai.weixin.qq.com`) directly, long-polls for
 * messages, answers the owner with the latest IPv6 / token-bearing DSH Web URL,
 * and pushes the same information every day at 15:00. It never imports a
 * Harness package, never starts an Agent and never consumes a model token.
 *
 * The Harness Host plugin only spawns this script, reads `status.json` and
 * queues tiny JSON command files in `commands/`.
 *
 * Modes:
 *   node clawbot.mjs                  run the daemon
 *   node clawbot.mjs status           print daemon status + access info
 *   node clawbot.mjs push             compute the info and send it once
 *   node clawbot.mjs qr               request one login QR and print it
 *
 * @module dsh-wechat-clawbot-access/runtime/clawbot
 */
import process from 'node:process'
import path from 'node:path'
import {
  DEFAULT_BASE_URL,
  FILES,
  Logger,
  chunkText,
  ensureStateLayout,
  firstText,
  isoLocal,
  listCommands,
  messageOf,
  processAlive,
  processCommandLine,
  randomId,
  readJson,
  readStatus,
  removeCommand,
  resolveStateDir,
  sleep,
  writeJsonAtomic,
  writeStatus,
} from './common.mjs'
import { createQrMatrix, toAscii } from './qr.mjs'
import { formatMessage, getAccessInfo, probeIpv6Fast } from './access-info.mjs'
import { parseArgs } from './daemon-options.mjs'
import { emptyState, emptyStatus, firstErrorText, safeAccessInfo, summarizeInfo } from './daemon-state.mjs'
import { classifySender, maskId } from './sender-policy.mjs'

const QR_TIMEOUT_MS = 5 * 60 * 1000
const MAX_STORED_USERS = 200
const DENIAL_WINDOW_MS = 10 * 60 * 1000
const DENIAL_MAX_PER_WINDOW = 30
const PUSH_RETRY_MAX_ATTEMPTS = 8

const UNAUTHORIZED_TEXT = '⚠️ 该微信号尚未绑定本机 DSH ClawBot 插件，已拒绝。'
const PAIRING_TEXT =
  '🔐 已收到绑定请求，但尚未在 DSH 插件页确认。请打开 DSH → 插件 → 微信 ClawBot 页面，' +
  '在「待确认绑定」中允许该微信号；确认前不会发送任何访问信息。'
const PAIRING_REMIND_TEXT = '⏳ 绑定请求仍在等待 DSH 插件页确认，请在插件页点击「允许绑定」。'
const INFO_FAILED_PREFIX = '⚠️ 获取 DSH 访问信息失败：'
const START_HINT = 'DSH ClawBot 运行时已就绪，本消息由纯脚本自动回复。'

/** One ClawBot protocol failure with a machine-readable kind preserved. */
class ClawbotError extends Error {
  /**
   * @param {string} message - readable description.
   * @param {string} code - error kind: auth|network|timeout|http|json|ret|aborted|config.
   */
  constructor(message, code) {
    super(message)
    this.name = 'ClawbotError'
    this.code = code
  }
}

/** @param {unknown} value - text to shorten. @param {number} limit - maximum length. @returns {string} clipped text. */
function clip(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * One running ClawBot runtime.
 */
class ClawbotRuntime {
  /**
   * @param {object} options - parsed options from {@link parseArgs}.
   */
  constructor(options) {
    this.options = options
    this.stateDir = resolveStateDir(options.stateDir)
    this.statePath = path.join(this.stateDir, FILES.state)
    this.statusPath = path.join(this.stateDir, FILES.status)
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL
    this.maxSendChars = options.maxSendChars
    this.retryDelayMs = options.retryDelayMs
    this.qrTtlMs = options.qrTtlSeconds * 1000
    this.allowedUsers = options.allowedUsers
    this.logger = new Logger(this.stateDir, { level: options.logLevel })

    /** @type {{version:number, token:string, baseUrl:string, loginAt:number, loginConfirmedAt:number, botUserId:string, syncBuf:string, ownerId:string, users:Record<string, object>, updatedAt:number}} */
    this.state = emptyState(this.baseUrl)
    /** @type {object} */
    this.status = emptyStatus()
    this.statusChain = Promise.resolve()
    this.saveTimer = null
    this.saveChain = Promise.resolve()
    this.pollAbort = null
    this.loginAbort = null
    this.loginTask = null
    this.controlTimer = null
    this.ownerTimer = null
    this.pushTimer = null
    this.stopping = false
    this.started = false
    this.resolveFinished = null
    /** @type {Map<string, Promise<void>>} per-contact reply queues */
    this.queues = new Map()
    /** @type {{at:number, value:object, message:string}|null} */
    this.infoCache = null
    /** @type {Set<string>} recently seen message ids */
    this.seenMessages = new Set()
    /** @type {number} current QR attempt within one login session */
    this.qrAttempts = 0
    /** @type {NodeJS.Timeout|null} delayed automatic QR regeneration */
    this.qrRefreshTimer = null
    /** @type {NodeJS.Timeout|null} hourly IPv6 change watcher */
    this.watchTimer = null
    /** @type {NodeJS.Timeout|null} pending-notification retry after a fresh reply context */
    this.pendingFlushTimer = null
    /** @type {boolean} guard against overlapping IPv6 probes */
    this.watchBusy = false
    /** Sliding window for inbound denial replies (anti-spam). */
    this.denyState = { at: 0, count: 0 }
    /** Timer for retrying a failed daily/push delivery. */
    this.pushRetryTimer = null
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve
    })
  }

  // ----------------------------------------------------------------- lifecycle

  /** Run the requested mode. */
  async run() {
    await ensureStateLayout(this.stateDir)
    if (this.options.mode === 'status') return this.runStatusMode()
    if (this.options.mode === 'push') return this.runPushMode()
    if (this.options.mode === 'qr') return this.runQrMode()
    if (this.options.mode === 'probe') return this.runProbeMode()
    return this.runDaemon()
  }

  /** Daemon mode: run until stopped or the owning Host process exits. */
  async runDaemon() {
    if (await this.alreadyRunning()) {
      this.logger.info(`another ClawBot runtime is already running; exiting (pid ${process.pid})`)
      return
    }
    await this.loadState()
    this.status = emptyStatus()
    this.status.pid = process.pid
    this.status.phase = 'starting'
    this.status.startedAt = Date.now()
    this.status.heartbeatAt = Date.now()
    this.status.logPath = path.join(this.stateDir, FILES.logs, FILES.log)
    this.status.pushEnabled = this.options.pushEnabled
    this.status.pushHour = this.options.pushHour
    this.status.pushMinute = this.options.pushMinute
    this.status.users = this.publicUsers()
    this.status.ownerId = this.state.ownerId
    this.status.pendingOwner = this.state.pendingOwner ?? null
    this.status.pendingPush = this.state.pendingPush ?? null
    await this.flushStatus(true)
    this.logger.info(
      `runtime starting: stateDir=${this.stateDir} token=${this.state.token ? 'present' : 'missing'} ` +
        `push=${this.options.pushEnabled ? `${this.options.pushHour}:${String(this.options.pushMinute).padStart(2, '0')}` : 'off'}`,
    )

    const onSignal = (signal) => {
      void this.requestStop(`received ${signal}`)
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)

    this.started = true
    await this.pruneStaleCommands()
    this.startControlWatcher()
    this.startOwnerWatchdog()
    this.scheduleNextPush()
    this.startIpv6Watch()
    if (this.state.pendingPush) this.schedulePendingPushRetry(60_000)
    void this.tickleLogin().catch((error) => this.logger.error(`startup login failed: ${messageOf(error)}`))

    await this.finished
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    this.logger.info('runtime stopped')
  }

  /** Decide whether to reuse a fresh token or request a new QR login. */
  async tickleLogin() {
    const confirmedAt = Number(this.state.loginConfirmedAt) || 0
    const maxAge = this.options.reuseTokenDays * 24 * 60 * 60 * 1000
    const fresh = Boolean(this.state.token) && confirmedAt > 0 && Date.now() - confirmedAt < maxAge
    if (fresh) {
      this.logger.info('reusing the persisted ClawBot token')
      this.startPolling()
      return
    }
    if (this.state.token) {
      this.logger.info('persisted token is stale or has never been confirmed by this version; starting QR login')
    } else {
      this.logger.info('no ClawBot token yet; starting QR login')
    }
    await this.beginLogin()
  }

  /** Stop everything gracefully. */
  async requestStop(reason) {
    if (this.stopping) return
    this.stopping = true
    this.logger.info(`stopping runtime: ${reason}`)
    this.stopPolling()
    this.loginAbort?.abort()
    for (const timer of [this.controlTimer, this.ownerTimer, this.pushTimer]) {
      if (timer) clearInterval(timer)
    }
    if (this.qrRefreshTimer) clearTimeout(this.qrRefreshTimer)
    this.qrRefreshTimer = null
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    if (this.pendingFlushTimer) clearTimeout(this.pendingFlushTimer)
    this.pendingFlushTimer = null
    if (this.pushRetryTimer) clearTimeout(this.pushRetryTimer)
    this.pushRetryTimer = null
    this.controlTimer = null
    this.ownerTimer = null
    this.pushTimer = null
    try {
      await this.saveStateNow()
    } catch (error) {
      this.logger.warn(`could not persist state on shutdown: ${messageOf(error)}`)
    }
    this.status.phase = 'stopped'
    this.status.pid = 0
    this.status.connected = false
    this.status.qr = null
    this.status.heartbeatAt = Date.now()
    await this.flushStatus(true)
    this.logger.info('runtime stopped cleanly')
    this.resolveFinished?.()
  }

  /** @returns {Promise<boolean>} true when another identical runtime is alive. */
  async alreadyRunning() {
    const status = await readStatus(this.stateDir)
    const pid = Number(status?.pid)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
    if (!processAlive(pid)) return false
    const command = await processCommandLine(pid)
    return command.includes('clawbot.mjs')
  }

  // ---------------------------------------------------------------- one-shots

  /** `status` mode: print status + a fresh info snapshot. */
  async runStatusMode() {
    await this.loadState()
    const status = (await readStatus(this.stateDir)) ?? emptyStatus()
    const info = await safeAccessInfo(this.stateDir, { sshPort: this.options.sshPort })
    const value = {
      daemon: {
        running: Boolean(status.pid) && processAlive(status.pid),
        pid: status.pid ?? 0,
        phase: status.phase ?? 'unknown',
      },
      state: {
        connected: Boolean(this.state.token),
        loginAt: this.state.loginAt,
        loginConfirmedAt: this.state.loginConfirmedAt,
        ownerId: this.state.ownerId,
        users: Object.values(this.state.users).map((user) => ({
          id: user.id,
          lastSeen: user.lastSeen,
          hasContext: Boolean(user.contextToken),
        })),
      },
      accessInfo: info,
      status,
    }
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  }

  /** `push` mode: compute the info message and send it once to known contacts. */
  async runPushMode() {
    await this.loadState()
    const result = await this.pushInfo({ manual: true })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  }

  /** `qr` mode: request one QR code, print its link and an ASCII rendering. */
  async runQrMode() {
    await this.loadState()
    const result = await this.request('ilink/bot/get_bot_qrcode?bot_type=3', {
      method: 'GET',
      auth: false,
      timeoutMs: 20000,
    })
    const qrcode = String(result.qrcode ?? '')
    const link = String(result.qrcode_img_content ?? result.qrcode_url ?? '')
    process.stdout.write(`qrcode: ${qrcode}\nopen in WeChat: ${link}\n`)
    if (link) {
      try {
        const qr = createQrMatrix(link, { ecc: 'M' })
        process.stdout.write(`version=${qr.version} size=${qr.size}\n${toAscii(qr)}\n`)
      } catch (error) {
        this.logger.warn(`could not render QR: ${messageOf(error)}`)
      }
    }
  }

  /** `probe` mode: print one fast IPv6 probe result (no token/network work). */
  async runProbeMode() {
    await this.loadState()
    const probe = await probeIpv6Fast({ cachedStable: this.state.watch?.windowsStable ?? '' })
    process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`)
    if (!probe.address) process.exitCode = 1
  }

  // ------------------------------------------------------------------- state

  /** Load persisted runtime state (tolerating the old plugin's schema). */
  async loadState() {
    const raw = await readJson(this.statePath, null)
    const state = emptyState(this.baseUrl)
    if (raw && typeof raw === 'object') {
      if (typeof raw.token === 'string') state.token = raw.token
      if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) state.baseUrl = raw.baseUrl.trim()
      if (Number.isFinite(raw.loginAt)) state.loginAt = Number(raw.loginAt)
      if (Number.isFinite(raw.loginConfirmedAt)) state.loginConfirmedAt = Number(raw.loginConfirmedAt)
      if (typeof raw.botUserId === 'string') state.botUserId = raw.botUserId
      if (typeof raw.syncBuf === 'string') state.syncBuf = raw.syncBuf
      if (typeof raw.ownerId === 'string') state.ownerId = raw.ownerId
      if (raw.pendingOwner && typeof raw.pendingOwner === 'object' && !Array.isArray(raw.pendingOwner)) {
        if (typeof raw.pendingOwner.id === 'string' && raw.pendingOwner.id) {
          state.pendingOwner = {
            id: raw.pendingOwner.id,
            at: Number.isFinite(raw.pendingOwner.at) ? Number(raw.pendingOwner.at) : Date.now(),
          }
        }
      }
      if (raw.pendingPush && typeof raw.pendingPush === 'object' && !Array.isArray(raw.pendingPush)) {
        state.pendingPush = {
          at: Number.isFinite(raw.pendingPush.at) ? Number(raw.pendingPush.at) : 0,
          attempts: Number.isFinite(raw.pendingPush.attempts) ? Number(raw.pendingPush.attempts) : 0,
          reason: typeof raw.pendingPush.reason === 'string' ? raw.pendingPush.reason : 'push-failed',
        }
      }
      if (raw.watch && typeof raw.watch === 'object' && !Array.isArray(raw.watch)) {
        state.watch = {
          ipv6: typeof raw.watch.ipv6 === 'string' ? raw.watch.ipv6 : '',
          candidates: Array.isArray(raw.watch.candidates)
            ? raw.watch.candidates.filter((row) => typeof row === 'string').slice(0, 16)
            : [],
          windowsStable: typeof raw.watch.windowsStable === 'string' ? raw.watch.windowsStable : '',
          at: Number.isFinite(raw.watch.at) ? Number(raw.watch.at) : 0,
          lastSentAt: Number.isFinite(raw.watch.lastSentAt) ? Number(raw.watch.lastSentAt) : 0,
          pendingNotify: raw.watch.pendingNotify === true,
          lastChangeAt: Number.isFinite(raw.watch.lastChangeAt) ? Number(raw.watch.lastChangeAt) : 0,
          lastCheckAt: Number.isFinite(raw.watch.lastCheckAt) ? Number(raw.watch.lastCheckAt) : 0,
          lastProbeMs: Number.isFinite(raw.watch.lastProbeMs) ? Number(raw.watch.lastProbeMs) : 0,
          lastProbeVia: typeof raw.watch.lastProbeVia === 'string' ? raw.watch.lastProbeVia : '',
        }
      }
      if (raw.users && typeof raw.users === 'object' && !Array.isArray(raw.users)) {
        for (const [id, value] of Object.entries(raw.users)) {
          if (!id || !value || typeof value !== 'object') continue
          state.users[id] = {
            id,
            contextToken: typeof value.contextToken === 'string' ? value.contextToken : '',
            firstSeen: Number.isFinite(value.firstSeen) ? Number(value.firstSeen) : 0,
            lastSeen: Number.isFinite(value.lastSeen) ? Number(value.lastSeen) : 0,
            deniedAt: Number.isFinite(value.deniedAt) ? Number(value.deniedAt) : 0,
          }
        }
      }
    }
    // The previous plugin kept no owner field; adopt the most recent known
    // contact so a single-user installation keeps working without extra setup.
    if (!state.ownerId && this.allowedUsers.length === 0) {
      const known = Object.values(state.users).sort((left, right) => (right.lastSeen || 0) - (left.lastSeen || 0))[0]
      if (known) state.ownerId = known.id
    }
    this.state = state
    this.trimUsers()
    this.baseUrl = state.baseUrl || this.baseUrl
  }

  /** Schedule a debounced state write. */
  queueSave() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveStateNow().catch((error) => this.logger.warn(`could not save state: ${messageOf(error)}`))
    }, 400)
  }

  /** Write the state file now through a serialized atomic path. */
  saveStateNow() {
    this.state.updatedAt = Date.now()
    const payload = JSON.stringify(this.state, null, 2)
    const run = this.saveChain.then(async () => {
      await writeJsonAtomic(this.statePath, JSON.parse(payload), 0o600)
    })
    this.saveChain = run.catch((error) => this.logger.warn(`could not save state: ${messageOf(error)}`))
    return this.saveChain
  }

  /** Keep the persisted contact table bounded. */
  trimUsers() {
    const entries = Object.values(this.state.users)
    if (entries.length <= MAX_STORED_USERS) return
    entries
      .sort((left, right) => (left.lastSeen || 0) - (right.lastSeen || 0))
      .slice(0, entries.length - MAX_STORED_USERS)
      .forEach((record) => delete this.state.users[record.id])
  }

  // ------------------------------------------------------------------ status

  /**
   * Merge a status patch and persist it. This is the ONLY path that writes
   * status.json; there is deliberately no periodic heartbeat. `heartbeatAt`
   * therefore means "last status persistence", and liveness is determined from
   * the PID by the Host route.
   * @param {object} patch - status fields to merge.
   * @param {boolean} [immediate] - write now instead of scheduling.
   */
  async updateStatus(patch, immediate = false) {
    Object.assign(this.status, patch)
    this.status.heartbeatAt = Date.now()
    if (immediate) return this.flushStatus(true)
    return this.flushStatus()
  }

  /** Serialize status writes. @param {boolean} [force] - write even when recently written. */
  flushStatus(force = false) {
    const now = Date.now()
    if (!force && this.lastStatusWrite && now - this.lastStatusWrite < 1000) return this.statusChain
    this.lastStatusWrite = now
    const payload = JSON.parse(JSON.stringify(this.status))
    const run = this.statusChain.then(() => writeStatus(this.stateDir, payload))
    this.statusChain = run.catch((error) => this.logger.warn(`could not write status: ${messageOf(error)}`))
    return this.statusChain
  }

  /** @returns {Array<{id: string, lastSeen: number, hasContext: boolean}>} users for the UI. */
  publicUsers() {
    return Object.values(this.state.users)
      .sort((left, right) => (right.lastSeen || 0) - (left.lastSeen || 0))
      .slice(0, 20)
      .map((user) => ({ id: user.id, lastSeen: user.lastSeen || 0, hasContext: Boolean(user.contextToken) }))
  }

  /**
   * Drop command files addressed to a previous Host plugin instance. A plugin
   * hot-reload stops the old daemon, and a command enqueued during that handoff
   * must not reach the freshly spawned runtime.
   */
  async pruneStaleCommands() {
    if (!this.options.ownerInstance) return
    const commands = await listCommands(this.stateDir)
    for (const command of commands) {
      const target = command.value.args?.ownerInstance
      if (target && target !== this.options.ownerInstance) {
        await removeCommand(command.file)
        this.logger.info(`discarded a command from a previous Host instance: ${command.value.action}`)
      }
    }
  }

  /** Start consuming queued control commands from the Host plugin. */
  startControlWatcher() {
    let busy = false
    this.controlTimer = setInterval(() => {
      if (this.stopping || busy) return
      busy = true
      void this.consumeCommands()
        .catch((error) => this.logger.warn(`control command failed: ${messageOf(error)}`))
        .finally(() => {
          busy = false
        })
    }, 1000)
  }

  /**
   * Handle every queued control command once. Long-running flows (a fresh QR
   * login, a WeChat push) are dispatched in the background so one slow action
   * never blocks the rest of the queue.
   */
  async consumeCommands() {
    const commands = await listCommands(this.stateDir)
    for (const command of commands) {
      await removeCommand(command.file)
      if (this.stopping) return
      const action = command.value.action
      const targetInstance = command.value.args?.ownerInstance
      if (targetInstance && targetInstance !== this.options.ownerInstance) {
        this.logger.info(`ignoring a command for another Host instance: ${action}`)
        continue
      }
      this.logger.info(`control action: ${action}`)
      if (action === 'stop') {
        await this.requestStop('control command')
        return
      }
      void this.runControl(action, command.value.args ?? {}).catch(async (error) => {
        this.logger.warn(`control action ${action} failed: ${messageOf(error)}`)
        await this.updateStatus(
          { lastError: { code: 'control-failed', message: `${action}: ${messageOf(error)}`, at: Date.now() } },
          true,
        )
      })
    }
  }

  /**
   * Execute one control action.
   * @param {string} action - action name from the UI.
   */
  async runControl(action) {
    if (action === 'relogin' || action === 'login' || action === 'refresh-qr') {
      this.qrAttempts = 0
      await this.beginLogin()
      return
    }
    if (action === 'logout') {
      this.loginAbort?.abort()
      await this.waitLoginTask()
      this.stopPolling()
      this.state.token = ''
      this.state.loginAt = 0
      this.state.loginConfirmedAt = 0
      this.state.syncBuf = ''
      await this.saveStateNow()
      await this.updateStatus(
        { phase: 'login-needed', connected: false, qr: null, lastError: null, loginAt: 0, loginConfirmedAt: 0 },
        true,
      )
      return
    }
    if (action === 'send-info') {
      await this.pushInfo({ manual: true })
      return
    }
    if (action === 'clear-owner') {
      this.state.ownerId = ''
      this.state.pendingOwner = null
      await this.saveStateNow()
      await this.updateStatus({ ownerId: '', pendingOwner: null, users: this.publicUsers() }, true)
      return
    }
    if (action === 'approve-owner') {
      const pending = this.state.pendingOwner
      if (!pending?.id || this.state.ownerId) {
        await this.updateStatus(
          { lastError: { code: 'no-pending-owner', message: '没有等待确认的绑定请求', at: Date.now() } },
          true,
        )
        return
      }
      this.state.ownerId = pending.id
      this.state.pendingOwner = null
      await this.saveStateNow()
      await this.updateStatus(
        { ownerId: this.state.ownerId, pendingOwner: null, users: this.publicUsers(), lastError: null },
        true,
      )
      this.logger.info(`owner pairing approved for ${maskId(pending.id)}`)
      void this.pushInfo({ manual: true, reason: 'owner-approved' }).catch((error) =>
        this.logger.warn(`could not push info after owner approval: ${messageOf(error)}`),
      )
      return
    }
    if (action === 'reject-owner') {
      const pending = this.state.pendingOwner
      this.state.pendingOwner = null
      await this.saveStateNow()
      await this.updateStatus({ pendingOwner: null, users: this.publicUsers() }, true)
      if (pending?.id) this.logger.info(`owner pairing rejected for ${maskId(pending.id)}`)
      return
    }
    if (action === 'check-ipv6') {
      await this.checkIpv6Watch({ manual: true })
      return
    }
    if (action === 'refresh-status') {
      await this.flushStatus(true)
      return
    }
    this.logger.warn(`unknown control action: ${action}`)
  }

  /** Restart the process when the owning Harness Host dies (avoids orphans). */
  startOwnerWatchdog() {
    const ownerPid = this.options.ownerPid
    if (!ownerPid) return
    this.ownerTimer = setInterval(() => {
      if (this.stopping) return
      if (!processAlive(ownerPid)) {
        void this.requestStop(`owning DSH process ${ownerPid} exited`)
      }
    }, 2000)
  }

  // ------------------------------------------------------------------- login

  /** Request a QR code and wait until it is confirmed, expired or cancelled. */
  async beginLogin() {
    this.loginAbort?.abort()
    if (this.qrRefreshTimer) clearTimeout(this.qrRefreshTimer)
    this.qrRefreshTimer = null
    await this.waitLoginTask()
    if (this.stopping) return
    this.qrAttempts += 1
    const run = this.loginFlow()
    this.loginTask = run
    try {
      await run
    } finally {
      if (this.loginTask === run) this.loginTask = null
    }
  }

  /** Wait for a running login flow to settle. */
  async waitLoginTask() {
    const task = this.loginTask
    if (!task) return
    try {
      await task
    } catch {
      // The flow reports its own errors.
    }
  }

  /** One complete QR login attempt. */
  async loginFlow() {
    this.stopPolling()
    const controller = new AbortController()
    this.loginAbort = controller
    await this.updateStatus({ phase: 'login-qr', connected: false, qr: null, lastError: null }, true)
    let payload
    try {
      payload = await this.request('ilink/bot/get_bot_qrcode?bot_type=3', {
        method: 'GET',
        auth: false,
        timeoutMs: 20000,
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      this.logger.warn(`could not request a login QR code: ${messageOf(error)}`)
      await this.updateStatus(
        {
          phase: this.state.token ? 'polling' : 'login-needed',
          lastError: { code: 'qr-request-failed', message: messageOf(error), at: Date.now() },
        },
        true,
      )
      if (this.state.token) this.startPolling()
      return
    }
    const qrcodeId = String(payload.qrcode ?? '')
    const link = String(payload.qrcode_img_content ?? payload.qrcode_url ?? '')
    if (!qrcodeId) {
      await this.updateStatus(
        {
          phase: this.state.token ? 'polling' : 'login-needed',
          lastError: { code: 'qr-missing', message: 'ClawBot did not return a QR code', at: Date.now() },
        },
        true,
      )
      if (this.state.token) this.startPolling()
      return
    }
    let matrix = null
    let matrixError = ''
    if (link) {
      try {
        const qr = createQrMatrix(link, { ecc: 'M' })
        matrix = { size: qr.size, modules: qr.modules, version: qr.version }
      } catch (error) {
        matrixError = messageOf(error)
        this.logger.warn(`could not encode the QR code: ${matrixError}`)
      }
    }
    const startedAt = Date.now()
    const expiresAt = startedAt + this.qrTtlMs
    this.pendingQr = { qrcode: qrcodeId, link, startedAt, expiresAt }
    this.logger.info(`login QR ready; expires in ${Math.round(this.qrTtlMs / 1000)}s`)
    await this.updateStatus(
      {
        phase: 'login-waiting',
        connected: false,
        qr: {
          qrcode: qrcodeId,
          link,
          startedAt,
          expiresAt,
          ...(matrix ? matrix : { size: 0, modules: null, version: 0 }),
          ...(matrixError ? { error: matrixError } : {}),
        },
      },
      true,
    )
    await this.pollQr({ qrcode: qrcodeId, link, startedAt, expiresAt }, controller.signal)
  }

  /**
   * Poll one QR code until confirmed, expired or timed out.
   * @param {{qrcode: string, link: string, startedAt: number, expiresAt: number}} pending - login attempt.
   * @param {AbortSignal} signal - cancellation.
   */
  async pollQr(pending, signal) {
    while (!this.stopping && !signal.aborted && Date.now() < pending.expiresAt) {
      await sleep(1500, signal)
      if (this.stopping || signal.aborted) return
      let result
      try {
        result = await this.request(
          `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(pending.qrcode)}`,
          { method: 'GET', auth: false, timeoutMs: 15000, signal },
        )
      } catch (error) {
        if (signal.aborted) return
        this.logger.debug(`QR status poll failed: ${messageOf(error)}`)
        continue
      }
      const state = String(result.status ?? '')
      if (state === 'confirmed') {
        if (typeof result.bot_token !== 'string' || !result.bot_token) {
          await this.updateStatus(
            {
              phase: 'login-needed',
              lastError: { code: 'qr-confirmed-without-token', message: 'login confirmed without a bot token', at: Date.now() },
            },
            true,
          )
          return
        }
        this.state.token = result.bot_token
        if (typeof result.baseurl === 'string' && result.baseurl.trim()) this.state.baseUrl = result.baseurl.trim()
        if (typeof result.bot_user_id === 'string') this.state.botUserId = result.bot_user_id
        this.state.loginAt = Date.now()
        this.state.loginConfirmedAt = Date.now()
        this.state.syncBuf = ''
        this.pendingQr = null
        this.qrAttempts = 0
        this.baseUrl = this.state.baseUrl || this.baseUrl
        await this.saveStateNow()
        this.logger.info('WeChat login confirmed; listening for messages')
        await this.updateStatus(
          {
            phase: 'polling',
            connected: true,
            qr: null,
            loginAt: this.state.loginAt,
            loginConfirmedAt: this.state.loginConfirmedAt,
            lastError: null,
          },
          true,
        )
        this.startPolling()
        this.schedulePendingWatchFlush()
        return
      }
      if (state === 'expired' || state === 'canceled' || state === 'cancelled') {
        await this.finishExpiredLogin(`QR ${state}`)
        return
      }
    }
    if (!this.stopping && !signal.aborted) await this.finishExpiredLogin('QR login timed out')
  }

  /**
   * Handle an expired or cancelled QR attempt.
   * @param {string} reason - readable reason.
   */
  async finishExpiredLogin(reason) {
    this.pendingQr = null
    this.logger.warn(reason)
    const fallbackToToken = Boolean(this.state.token)
    const canRefresh =
      !fallbackToToken &&
      !this.stopping &&
      this.options.qrAutoRefresh &&
      this.qrAttempts < this.options.qrMaxAttempts
    await this.updateStatus(
      {
        phase: fallbackToToken ? 'polling' : canRefresh ? 'login-qr' : 'login-needed',
        connected: fallbackToToken,
        qr: null,
        lastError: { code: 'qr-expired', message: reason, at: Date.now() },
      },
      true,
    )
    if (fallbackToToken) {
      this.startPolling()
      return
    }
    if (canRefresh) {
      this.logger.info(`regenerating the login QR automatically (attempt ${this.qrAttempts + 1}/${this.options.qrMaxAttempts})`)
      this.qrRefreshTimer = setTimeout(() => {
        this.qrRefreshTimer = null
        if (!this.stopping) void this.beginLogin().catch((error) => this.logger.warn(`QR refresh failed: ${messageOf(error)}`))
      }, 2500)
    }
  }

  // ----------------------------------------------------------------- polling

  /** Start (or restart) the long-poll loop. */
  startPolling() {
    if (this.stopping || !this.state.token) return
    this.pollAbort?.abort()
    const controller = new AbortController()
    this.pollAbort = controller
    void this.pollLoop(controller.signal).catch((error) => {
      if (!controller.signal.aborted) this.logger.warn(`message loop stopped: ${messageOf(error)}`)
    })
    this.logger.info(`listening for WeChat messages via ${this.state.baseUrl}`)
    void this.updateStatus({ phase: 'polling', connected: true }, true)
  }

  /** Stop the long-poll loop. */
  stopPolling() {
    this.pollAbort?.abort()
    this.pollAbort = null
  }

  /**
   * Long-poll `getupdates` until cancelled.
   * @param {AbortSignal} signal - loop lifetime.
   */
  async pollLoop(signal) {
    let failures = 0
    while (!this.stopping && !signal.aborted) {
      let result
      try {
        result = await this.request('ilink/bot/getupdates', {
          body: {
            get_updates_buf: this.state.syncBuf,
            base_info: { channel_version: this.options.channelVersion },
          },
          signal,
          timeoutMs: 90000,
        })
        failures = 0
      } catch (error) {
        if (this.stopping || signal.aborted) return
        if (error?.code === 'auth') {
          this.logger.warn(`ClawBot session expired (${messageOf(error)}); requesting a new login QR`)
          this.state.token = ''
          this.state.loginConfirmedAt = 0
          this.state.syncBuf = ''
          await this.saveStateNow()
          this.pollAbort = null
          if (!this.stopping) await this.beginLogin()
          return
        }
        failures += 1
        this.logger.warn(`getupdates failed (${failures}): ${messageOf(error)}`)
        await this.updateStatus(
          { lastError: { code: 'poll-failed', message: messageOf(error), at: Date.now() } },
          false,
        )
        await sleep(Math.min(this.retryDelayMs * 2 ** Math.min(failures, 4), 30000), signal)
        continue
      }
      if (this.stopping || signal.aborted) return
      if (typeof result.get_updates_buf === 'string' && result.get_updates_buf) {
        this.state.syncBuf = result.get_updates_buf
        this.queueSave()
      }
      const messages = Array.isArray(result.msgs) ? result.msgs : []
      for (const message of messages) {
        if (this.stopping) return
        this.acceptMessage(message)
      }
    }
  }

  // ---------------------------------------------------------------- messages

  /**
   * Admit one raw iLink message: persist the contact, lock the owner, enqueue a reply.
   * @param {object} message - one entry of `getupdates().msgs`.
   */
  acceptMessage(message) {
    if (!message || typeof message !== 'object') return
    const fromId = typeof message.from_user_id === 'string' ? message.from_user_id : ''
    const contextToken = typeof message.context_token === 'string' ? message.context_token : ''
    if (!fromId) return
    const messageId = String(
      message.msg_id ?? message.message_id ?? message.msgid ?? message.msg_svr_id ?? message.client_msg_id ?? '',
    )
    if (messageId) {
      if (this.seenMessages.has(messageId)) {
        this.logger.debug(`skipping duplicate message ${messageId}`)
        return
      }
      this.seenMessages.add(messageId)
      if (this.seenMessages.size > 500) {
        const oldest = this.seenMessages.values().next().value
        if (oldest !== undefined) this.seenMessages.delete(oldest)
      }
    }
    const record = this.recordFor(fromId)
    if (contextToken) record.contextToken = contextToken
    record.lastSeen = Date.now()
    this.status.lastMessageAt = record.lastSeen
    if (contextToken) this.schedulePendingWatchFlush()
    this.status.stats.messages = (this.status.stats.messages || 0) + 1
    this.queueSave()
    void this.updateStatus(
      {
        lastMessageAt: record.lastSeen,
        users: this.publicUsers(),
        ownerId: this.state.ownerId,
        stats: this.status.stats,
      },
      false,
    )

    const policy = classifySender({
      fromId,
      ownerId: this.state.ownerId,
      allowedUsers: this.allowedUsers,
      pendingOwner: this.state.pendingOwner,
    })

    if (policy.action === 'pending-new') {
      this.state.pendingOwner = { id: fromId, at: Date.now() }
      this.queueSave()
      void this.updateStatus({ pendingOwner: this.state.pendingOwner, users: this.publicUsers() }, true)
      this.logger.warn(`new contact ${maskId(fromId)} requested owner pairing; waiting for panel approval`)
      if (this.canSendDenial() && record.contextToken) {
        this.enqueueReply(fromId, async () => {
          if (!record.contextToken) return
          await this.sendText(fromId, record.contextToken, PAIRING_TEXT)
        })
      }
      return
    }
    if (policy.action === 'pending-remind') {
      if (this.canSendDenial() && record.contextToken) {
        this.enqueueReply(fromId, async () => {
          if (!record.contextToken) return
          await this.sendText(fromId, record.contextToken, PAIRING_REMIND_TEXT)
        })
      }
      return
    }
    if (policy.action === 'deny') {
      if (!this.canSendDenial()) return
      this.logger.warn(`rejected a WeChat message from unauthorized contact ${maskId(fromId)}`)
      const recentlyDenied = record.deniedAt && Date.now() - record.deniedAt < 10 * 60 * 1000
      if (!recentlyDenied) {
        record.deniedAt = Date.now()
        this.queueSave()
        this.enqueueReply(fromId, async () => {
          if (!record.contextToken) return
          await this.sendText(fromId, record.contextToken, UNAUTHORIZED_TEXT)
        })
      }
      return
    }
    if (policy.action === 'allowed-new-owner') {
      this.state.ownerId = fromId
      this.state.pendingOwner = null
      this.logger.info(`owner locked to allow-listed contact ${maskId(fromId)}`)
      this.queueSave()
      void this.updateStatus({ ownerId: this.state.ownerId, users: this.publicUsers() }, false)
    }
    if (!record.contextToken) {
      this.logger.warn(`message from ${maskId(fromId)} carried no context token; cannot reply`)
      return
    }
    const text = firstText(message).trim()
    const verbose = this.options.logLevel === 'debug'
    this.logger.info(`received a WeChat message from ${maskId(fromId)}${text ? ` (${text.length} chars)` : ' (non-text)'}`)
    if (verbose && text) this.logger.debug(`message text: ${clip(text, 120)}`)
    if (this.state.pendingPush) this.schedulePendingPushRetry(30_000)
    this.enqueueReply(fromId, async () => {
      const reply = await this.buildInfoReply()
      await this.sendText(fromId, record.contextToken, reply)
      this.status.stats.replies = (this.status.stats.replies || 0) + 1
      this.status.lastReplyAt = Date.now()
      void this.updateStatus({ stats: this.status.stats, lastReplyAt: this.status.lastReplyAt }, false)
    })
  }

  /**
   * Return (and lazily create) the persisted record for one WeChat contact.
   * @param {string} fromId - WeChat user id.
   * @returns {object} contact record.
   */
  recordFor(fromId) {
    let record = this.state.users[fromId]
    if (!record) {
      record = { id: fromId, contextToken: '', firstSeen: Date.now(), lastSeen: 0, deniedAt: 0 }
      this.state.users[fromId] = record
      this.trimUsers()
      this.logger.info(`new WeChat contact ${maskId(fromId)}`)
    }
    return record
  }

  /** @param {string} fromId - WeChat user id. @returns {boolean} whether the contact may use the bot. */
  isAllowed(fromId) {
    if (this.allowedUsers.length > 0) return this.allowedUsers.includes(fromId)
    if (this.state.ownerId) return this.state.ownerId === fromId
    return false
  }

  /**
   * Sliding-window limiter for automatic denial/pairing replies: without it any
   * WeChat account could make the bot emit messages indefinitely.
   * @returns {boolean} whether one more automatic denial reply may be sent.
   */
  canSendDenial() {
    const now = Date.now()
    if (!this.denyState || now - this.denyState.at > DENIAL_WINDOW_MS) {
      this.denyState = { at: now, count: 0 }
    }
    if (this.denyState.count >= DENIAL_MAX_PER_WINDOW) return false
    this.denyState.count += 1
    return true
  }

  /**
   * Serialize reply work per contact so messages keep their order.
   * @param {string} fromId - queue key.
   * @param {() => Promise<void>} task - reply work.
   */
  enqueueReply(fromId, task) {
    const previous = this.queues.get(fromId) ?? Promise.resolve()
    const next = previous
      .then(task)
      .catch((error) => {
        this.logger.error(`reply to ${fromId} failed: ${messageOf(error)}`)
      })
    this.queues.set(fromId, next)
    void next.finally(() => {
      if (this.queues.get(fromId) === next) this.queues.delete(fromId)
    })
  }

  // -------------------------------------------------------------------- info

  /**
   * Compute the reply text: latest IPv6 + token-bearing DSH Web URL.
   * @returns {Promise<string>} WeChat-ready message.
   */
  async buildInfoReply() {
    const cached = this.infoCache
    if (cached && Date.now() - cached.at < 5000) return cached.message
    let info = null
    let message = ''
    try {
      info = await getAccessInfo({ stateDir: this.stateDir, sshPort: this.options.sshPort })
      message = formatMessage(info)
    } catch (error) {
      this.logger.error(`access info failed: ${messageOf(error)}`)
      message = `${INFO_FAILED_PREFIX}${messageOf(error)}`
    }
    this.infoCache = { at: Date.now(), value: info, message }
    this.status.lastInfo = summarizeInfo(info)
    this.status.lastInfoMessage = message
    await this.updateStatus(
      { lastInfo: this.status.lastInfo, lastInfoMessage: message, lastError: info && !info.ok ? { code: 'info-incomplete', message: firstErrorText(info), at: Date.now() } : this.status.lastError },
      false,
    )
    return message
  }

  // -------------------------------------------------------------------- push

  /** Schedule the next daily 15:00 (local time) push. */
  scheduleNextPush() {
    if (!this.options.pushEnabled || this.stopping) {
      this.status.nextPushAt = 0
      void this.flushStatus(true)
      return
    }
    const now = new Date()
    const next = new Date(now.getTime())
    next.setHours(this.options.pushHour, this.options.pushMinute, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    const delay = Math.max(1000, next.getTime() - now.getTime())
    this.status.nextPushAt = next.getTime()
    void this.flushStatus(true)
    this.pushTimer = setTimeout(() => {
      if (this.stopping) return
      void this.pushInfo({ manual: false })
        .catch((error) => this.logger.warn(`daily push failed: ${messageOf(error)}`))
        .finally(() => this.scheduleNextPush())
    }, delay)
    this.logger.info(`next daily push scheduled at ${isoLocal(next.getTime())}`)
  }

  // ------------------------------------------------------- ipv6 change watch

  /** Start the hourly IPv6 change watcher (disabled by `ipv6WatchMinutes: 0`). */
  startIpv6Watch() {
    const minutes = Math.max(0, Math.floor(Number(this.options.ipv6WatchMinutes) || 0))
    this.status.ipv6WatchMinutes = minutes
    if (!minutes || this.stopping) {
      this.status.nextIpv6CheckAt = 0
      void this.flushStatus(true)
      return
    }
    const intervalMs = minutes * 60000
    const firstDelay = Math.min(15000, intervalMs)
    const schedule = (delay) => {
      if (this.stopping) return
      this.status.nextIpv6CheckAt = Date.now() + delay
      void this.flushStatus(true)
      this.watchTimer = setTimeout(async () => {
        this.watchTimer = null
        this.logger.debug(`IPv6 watch timer fired (interval ${intervalMs}ms)`)
        if (this.stopping) return
        try {
          await this.checkIpv6Watch()
        } catch (error) {
          this.logger.warn(`IPv6 watch failed: ${messageOf(error)}`)
        }
        schedule(intervalMs)
      }, delay)
    }
    schedule(firstDelay)
    this.logger.info(
      `IPv6 change watcher enabled: every ${minutes} min, first check in ${Math.round(firstDelay / 1000)}s`,
    )
  }

  /**
   * Probe the machine IPv6 and notify WeChat only when the stable address changed.
   * @param {{manual?: boolean}} [options] - manual runs come from the plugin page.
   * @returns {Promise<object>} watch result summary.
   */
  async checkIpv6Watch(options = {}) {
    if (this.watchBusy) return { skipped: true, reason: 'busy' }
    this.watchBusy = true
    const startedAt = Date.now()
    try {
      const previous = this.state.watch && typeof this.state.watch === 'object' ? this.state.watch : null
      const probe = await probeIpv6Fast({
        cachedStable: previous?.windowsStable ?? '',
        timeoutMs: 6000,
      })
      const now = Date.now()
      const current = typeof probe.address === 'string' ? probe.address : ''
      const candidates = Array.isArray(probe.candidates) ? probe.candidates.slice(0, 12) : []
      const hadBaseline = Boolean(previous && typeof previous.ipv6 === 'string' && Number(previous.at) > 0)
      const changed = hadBaseline && previous.ipv6 !== current
      const watch = {
        ipv6: current,
        candidates,
        windowsStable:
          probe.source === 'windows' && probe.stable && current ? current : previous?.windowsStable ?? '',
        at: now,
        lastSentAt: Number(previous?.lastSentAt) || 0,
        pendingNotify: Boolean(previous?.pendingNotify),
        lastChangeAt: Number(previous?.lastChangeAt) || 0,
        lastCheckAt: now,
        lastProbeMs: probe.durationMs,
        lastProbeVia: probe.via,
      }
      let notifyReason = ''
      if (!hadBaseline) {
        watch.pendingNotify = false
        this.logger.info(`IPv6 watch baseline set: ${current || '<none>'} (via ${probe.via}, ${probe.durationMs}ms)`)
      } else if (changed) {
        watch.lastChangeAt = now
        watch.pendingNotify = true
        notifyReason = current ? 'ipv6-changed' : 'ipv6-lost'
        this.logger.info(
          `IPv6 watch detected a change: ${previous.ipv6 || '<none>'} -> ${current || '<none>'} ` +
            `(via ${probe.via}, ${probe.durationMs}ms)`,
        )
      } else if (watch.pendingNotify) {
        notifyReason = 'ipv6-pending-retry'
      }
      let pushResult = null
      if (notifyReason) {
        const prefix =
          notifyReason === 'ipv6-changed'
            ? '🔁 自动监控：电脑 IPv6 已更新\n'
            : notifyReason === 'ipv6-lost'
              ? '⚠️ 自动监控：电脑全局 IPv6 已丢失\n'
              : ''
        pushResult = await this.pushInfo({ manual: Boolean(options.manual), prefix, reason: notifyReason })
        if (pushResult.ok) {
          watch.pendingNotify = false
          watch.lastSentAt = Date.now()
        } else {
          watch.pendingNotify = true
        }
      }
      this.state.watch = watch
      await this.saveStateNow()
      await this.updateStatus(
        {
          ipv6WatchMinutes: this.options.ipv6WatchMinutes,
          lastIpv6CheckAt: now,
          lastIpv6ProbeMs: probe.durationMs,
          lastIpv6ProbeVia: probe.via,
          watchedIpv6: current,
          ipv6Candidates: candidates,
          lastIpv6ChangeAt: watch.lastChangeAt,
          ipv6WatchPending: watch.pendingNotify,
        },
        true,
      )
      const result = {
        ok: Boolean(probe.address) || changed,
        changed,
        previous: previous?.ipv6 ?? null,
        current,
        via: probe.via,
        durationMs: probe.durationMs,
        candidates,
        notified: pushResult?.sent ?? 0,
        pendingNotify: watch.pendingNotify,
        manual: Boolean(options.manual),
        totalMs: Date.now() - startedAt,
      }
      this.logger.info(
        `IPv6 watch: via=${probe.via} ${probe.durationMs}ms changed=${changed} notified=${result.notified} ` +
          `pending=${result.pendingNotify}`,
      )
      return result
    } finally {
      this.watchBusy = false
    }
  }

  /** Retry a pending IPv6 notification once a fresh reply context is available. */
  schedulePendingWatchFlush() {
    if (!this.state.watch?.pendingNotify || this.pendingFlushTimer || this.stopping) return
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = null
      if (this.stopping || !this.state.watch?.pendingNotify) return
      void this.checkIpv6Watch().catch((error) => this.logger.warn(`IPv6 pending notify failed: ${messageOf(error)}`))
    }, 5000)
  }

  /** @returns {Array<object>} contacts that may receive pushed messages. */
  recipients() {
    const users = Object.values(this.state.users)
    if (this.state.ownerId) {
      // Only the approved owner may receive the token-bearing push. Never fall
      // back to another allow-listed contact when the owner has no context yet.
      const owner = users.find((user) => user.id === this.state.ownerId)
      return owner?.contextToken && this.isAllowed(owner.id) ? [owner] : []
    }
    return users
      .filter((user) => user.contextToken && this.isAllowed(user.id))
      .sort((left, right) => (right.lastSeen || 0) - (left.lastSeen || 0))
      .slice(0, 5)
  }

  /**
   * Compute the latest access info and send it to the known owner contact(s).
   * @param {{manual?: boolean}} [options] - whether this was requested from the UI.
   * @returns {Promise<{ok: boolean, sent: number, failed: number, message: string, errors: object[]}>} delivery result.
   */
  async pushInfo(options = {}) {
    const prefix = typeof options.prefix === 'string' ? options.prefix : ''
    const reason = typeof options.reason === 'string' && options.reason
      ? options.reason
      : options.manual
        ? 'manual'
        : 'daily'
    const recipients = this.recipients()
    let message
    let info = null
    let infoOk = false
    try {
      info = await getAccessInfo({ stateDir: this.stateDir, sshPort: this.options.sshPort })
      infoOk = Boolean(info?.ok)
      message = `${prefix}${formatMessage(info)}`
    } catch (error) {
      this.logger.error(`access info failed: ${messageOf(error)}`)
      message = `${prefix}${INFO_FAILED_PREFIX}${messageOf(error)}`
    }
    this.infoCache = { at: Date.now(), value: info, message }
    const result = {
      ok: false,
      sent: 0,
      failed: 0,
      message,
      infoOk,
      manual: Boolean(options.manual),
      reason,
      recipients: recipients.length,
      errors: [],
      at: Date.now(),
    }
    if (!this.state.token) {
      result.errors.push({ code: 'not-logged-in', message: '微信尚未登录，无法发送' })
    } else if (recipients.length === 0) {
      result.errors.push({
        code: 'no-recipient',
        message: '没有可发送的联系人：请先在微信里给 bot 发一条消息，以保存回复上下文',
      })
    } else {
      for (const recipient of recipients) {
        try {
          await this.sendText(recipient.id, recipient.contextToken, message)
          result.sent += 1
          this.logger.info(`pushed access info to ${maskId(recipient.id)}`)
        } catch (error) {
          result.failed += 1
          result.errors.push({ code: 'send-failed', message: `${maskId(recipient.id)}: ${messageOf(error)}` })
          this.logger.warn(`could not push access info to ${maskId(recipient.id)}: ${messageOf(error)}`)
        }
      }
    }
    result.ok = infoOk && result.sent > 0
    // Durable delivery compensation: if nothing was delivered (not logged in,
    // no reply context yet, or a send error), retry later instead of waiting a
    // whole day for the next scheduled push.
    const previousPending = this.state.pendingPush
    if (result.sent > 0) {
      this.state.pendingPush = null
      if (this.pushRetryTimer) {
        clearTimeout(this.pushRetryTimer)
        this.pushRetryTimer = null
      }
    } else {
      const attempts = Math.max(0, Number(previousPending?.attempts) || 0) + 1
      this.state.pendingPush = { at: Date.now(), attempts, reason }
      this.queueSave()
      if (attempts <= PUSH_RETRY_MAX_ATTEMPTS) this.schedulePendingPushRetry()
      else this.logger.warn(`push delivery failed ${attempts} times; waiting for the next message or restart`)
    }
    this.status.lastPushAt = result.at
    this.status.lastPushResult = result
    this.status.lastInfo = summarizeInfo(info)
    this.status.lastInfoMessage = message
    this.status.pendingPush = this.state.pendingPush
    this.status.stats.pushes = (this.status.stats.pushes || 0) + 1
    await this.updateStatus(
      {
        lastPushAt: result.at,
        lastPushResult: result,
        lastInfo: this.status.lastInfo,
        lastInfoMessage: message,
        pendingPush: this.state.pendingPush,
        stats: this.status.stats,
      },
      true,
    )
    return result
  }

  /**
   * Schedule one backed-off retry for a failed push delivery. A successful
   * message reply/daily push clears `pendingPush`; this timer only exists while
   * the last delivery actually failed.
   * @param {number} [delayOverride] - explicit delay in milliseconds.
   */
  schedulePendingPushRetry(delayOverride) {
    if (!this.state.pendingPush || this.stopping || this.pushRetryTimer) return
    const attempts = Math.max(0, Number(this.state.pendingPush.attempts) || 0)
    if (attempts > PUSH_RETRY_MAX_ATTEMPTS) return
    const delay = Number.isFinite(delayOverride)
      ? Math.max(1000, Number(delayOverride))
      : Math.min(60 * 60 * 1000, 5 * 60 * 1000 * 2 ** Math.max(0, attempts - 1))
    this.pushRetryTimer = setTimeout(() => {
      this.pushRetryTimer = null
      if (this.stopping || !this.state.pendingPush) return
      this.pushInfo({ manual: false, reason: 'retry' }).catch((error) => {
        this.logger.warn(`push retry failed: ${messageOf(error)}`)
        this.schedulePendingPushRetry()
      })
    }, delay)
  }

  // ------------------------------------------------------------- wechat I/O

  /**
   * Send one text message, split into protocol-sized chunks.
   * @param {string} toUserId - recipient WeChat user id.
   * @param {string} contextToken - context token from that contact's latest message.
   * @param {string} text - message body.
   */
  async sendText(toUserId, contextToken, text) {
    if (!this.state.token) throw new ClawbotError('WeChat is not logged in', 'auth')
    if (!contextToken) throw new ClawbotError(`no context token for ${toUserId}`, 'config')
    const chunks = chunkText(text, this.maxSendChars)
    for (const chunk of chunks) {
      await this.request('ilink/bot/sendmessage', {
        body: {
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: `openclaw-weixin-${randomId()}`,
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{ type: 1, text_item: { text: chunk } }],
          },
          base_info: { channel_version: this.options.channelVersion },
        },
        timeoutMs: 30000,
      })
    }
  }

  /**
   * Call one ClawBot iLink endpoint with the protocol headers.
   * @param {string} pathname - endpoint path below the base URL.
   * @param {{method?: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal, auth?: boolean}} [options]
   *   request options.
   * @returns {Promise<object>} parsed JSON response.
   */
  async request(pathname, options = {}) {
    const { method = 'POST', body, timeoutMs = 30000, signal, auth = true } = options
    const base = (this.state.baseUrl || this.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    const timeout = AbortSignal.timeout(timeoutMs)
    const composed = signal && !signal.aborted ? AbortSignal.any([signal, timeout]) : timeout
    const headers = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64'),
    }
    if (auth && this.state.token) headers.Authorization = `Bearer ${this.state.token}`
    let response
    try {
      response = await fetch(`${base}/${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: composed,
      })
    } catch (error) {
      if (signal?.aborted) throw new ClawbotError('request aborted', 'aborted')
      if (timeout.aborted) throw new ClawbotError(`ClawBot ${pathname} timed out after ${timeoutMs}ms`, 'timeout')
      throw new ClawbotError(`ClawBot ${pathname} request failed: ${messageOf(error)}`, 'network')
    }
    const raw = await response.text().catch(() => '')
    if (!response.ok) {
      const authFailure = response.status === 401 || response.status === 403
      throw new ClawbotError(
        `ClawBot ${pathname} returned HTTP ${response.status}: ${clip(raw, 240)}`,
        authFailure ? 'auth' : 'http',
      )
    }
    let parsed
    try {
      parsed = raw ? JSON.parse(raw) : {}
    } catch {
      throw new ClawbotError(`ClawBot ${pathname} returned invalid JSON: ${clip(raw, 240)}`, 'json')
    }
    if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
      const authFailure = parsed.errcode === -14 || /session timeout|token/i.test(String(parsed.errmsg ?? ''))
      throw new ClawbotError(
        `ClawBot ${pathname} failed: errcode=${parsed.errcode}${parsed.errmsg ? ` (${parsed.errmsg})` : ''}`,
        authFailure ? 'auth' : 'ret',
      )
    }
    if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
      throw new ClawbotError(
        `ClawBot ${pathname} failed with ret=${parsed.ret}${parsed.errmsg ? `: ${parsed.errmsg}` : ''}`,
        'ret',
      )
    }
    return parsed
  }
}

// -------------------------------------------------------------------- helpers

// ---------------------------------------------------------------------- main

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  const runtime = new ClawbotRuntime(parseArgs(process.argv.slice(2)))
  runtime
    .run()
    .then(async () => {
      await runtime.logger.flush()
      process.exitCode = 0
    })
    .catch(async (error) => {
      runtime.logger.error(`fatal: ${messageOf(error)}`)
      const status = (await readStatus(runtime.stateDir).catch(() => null)) ?? {}
      await writeStatus(runtime.stateDir, {
        ...status,
        phase: 'error',
        pid: 0,
        connected: false,
        qr: null,
        lastError: { code: 'fatal', message: messageOf(error), at: Date.now() },
        heartbeatAt: Date.now(),
      }).catch(() => {})
      await runtime.logger.flush()
      process.exitCode = 1
    })
}

export { ClawbotRuntime, parseArgs }
