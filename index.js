/**
 * Host half of the WeChat ClawBot bundle.
 *
 * The Host half is a thin control plane: it registers the same-origin JSON
 * routes the plugin page uses, writes the token-bearing DSH Web snapshot the
 * scripts read, and supervises the standalone runtime process
 * (`runtime/clawbot.mjs`). All WeChat work — QR login, long polling, automatic
 * replies and the daily 15:00 push — happens inside that pure Node script and
 * never goes through an Agent, a Session or an LLM request.
 *
 * @module dsh-wechat-clawbot-access
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_BASE_URL,
  FILES,
  ensureStateLayout,
  enqueueCommand,
  messageOf,
  processAlive,
  processCommandLine,
  readStatus,
  resolveStateDir,
  writeDshWebSnapshot,
} from './runtime/common.mjs'

/** Stable Loader identity. */
export const name = 'wechat-clawbot'

/** Bundle version reported by the status route. */
export const version = '2.6.0'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_SCRIPT = path.join(PLUGIN_DIR, 'runtime', 'clawbot.mjs')
const ACCESS_INFO_SCRIPT = path.join(PLUGIN_DIR, 'runtime', 'access-info.mjs')

const ROUTES = {
  status: '/wechat-clawbot/status',
  action: '/wechat-clawbot/action',
  info: '/wechat-clawbot/info',
}

const ACTION_ACTIONS = new Set([
  'start',
  'stop',
  'relogin',
  'logout',
  'send-info',
  'refresh-qr',
  'clear-owner',
  'approve-owner',
  'reject-owner',
  'check-ipv6',
  'run-info',
  'refresh',
])

/**
 * Deployment defaults. A local bundle cannot import the Harness's own packages,
 * so this plugin validates its own config instead of exporting a `Config` schema.
 */
const DEFAULT_CONFIG = {
  baseUrl: DEFAULT_BASE_URL,
  stateDir: '',
  allowedUsers: [],
  autoStart: true,
  pushEnabled: true,
  pushHour: 15,
  pushMinute: 0,
  ipv6WatchMinutes: 60,
  sshPort: 22,
  reuseTokenDays: 30,
  maxSendChars: 1800,
  logLevel: 'info',
}

/**
 * Loader-visible configuration schema. This lets the plugin manager render and
 * validate the row config instead of treating it as opaque YAML.
 * @type {object}
 */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  stateDir: z.string().default(''),
  allowedUsers: z.array(z.string()).default([]),
  autoStart: z.boolean().default(true),
  pushEnabled: z.boolean().default(true),
  pushHour: z.natural().min(0).max(23).default(15),
  pushMinute: z.natural().min(0).max(59).default(0),
  ipv6WatchMinutes: z.natural().min(0).max(1440).default(60),
  sshPort: z.natural().min(1).max(65535).default(22),
  reuseTokenDays: z.natural().min(0).max(3650).default(30),
  maxSendChars: z.natural().min(200).max(4000).default(1800),
  logLevel: z.string().default('info'),
})

/**
 * Merge one raw Loader config over {@link DEFAULT_CONFIG}, keeping types sane.
 * @param {unknown} raw - config object supplied by the patch row.
 * @returns {object} normalized config.
 */
function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  const clamp = (value, min, max, fallback) => {
    const number = Math.floor(Number(value))
    if (!Number.isFinite(number)) return fallback
    return Math.max(min, Math.min(max, number))
  }
  return {
    baseUrl: typeof config.baseUrl === 'string' && config.baseUrl.trim() ? config.baseUrl.trim() : DEFAULT_BASE_URL,
    stateDir: typeof config.stateDir === 'string' ? config.stateDir.trim() : '',
    allowedUsers: Array.isArray(config.allowedUsers)
      ? config.allowedUsers.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
      : [],
    autoStart: config.autoStart !== false,
    pushEnabled: config.pushEnabled !== false,
    pushHour: clamp(config.pushHour, 0, 23, 15),
    pushMinute: clamp(config.pushMinute, 0, 59, 0),
    ipv6WatchMinutes: clamp(config.ipv6WatchMinutes, 0, 1440, 60),
    sshPort: clamp(config.sshPort, 1, 65535, 22),
    reuseTokenDays: clamp(config.reuseTokenDays, 0, 3650, 30),
    maxSendChars: clamp(config.maxSendChars, 200, 4000, 1800),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(config.logLevel) ? config.logLevel : 'info',
  }
}

/**
 * Load (or create) the persistent per-state-directory route secret.
 *
 * Custom web routes are outside the Harness browser-auth fence, so the plugin
 * proves same-origin page requests with a random secret injected into the
 * authenticated index HTML. Persisting it under the 0700 state directory keeps
 * already-open pages working across plugin hot reloads and DSH restarts; the
 * Client half can also re-read the current value from `/` when a stale page
 * still holds an older one.
 *
 * @param {string} stateDir - state directory (0700).
 * @param {object} ctx - Host plugin context for logging.
 * @returns {string} route secret.
 */
function loadRouteSecret(stateDir, ctx) {
  const file = path.join(stateDir, FILES.routeSecret)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing
  } catch {}
  const secret = randomBytes(18).toString('base64url')
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(file, secret, { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch (error) {
    ctx?.logger?.warn(`wechat-clawbot: could not persist route-secret: ${messageOf(error)}`)
  }
  return secret
}

/**
 * Mount the control plane.
 * @param {object} ctx - Host plugin context.
 * @param {unknown} rawConfig - deployment configuration from the Loader.
 */
export function apply(ctx, rawConfig) {
  const host = new ClawbotHost(ctx, normalizeConfig(rawConfig))
  host.install()
}

/**
 * Everything the Host half owns for one Harness process.
 */
class ClawbotHost {
  /**
   * @param {object} ctx - Host plugin context.
   * @param {object} config - normalized config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.stateDir = resolveStateDir(config.stateDir)
    this.child = null
    this.stopping = false
    this.stoppedByUser = false
    this.restartTimer = null
    this.restartCount = 0
    this.spawnedAt = 0
    this.infoCache = null
    this.snapshotTimer = null
    this.ready = null
    /** False when the web server cannot inject the per-process route secret. */
    this.routesAvailable = true
    /**
     * Per-process secret injected into the authenticated index page and echoed
     * by the client half. Custom routes are not covered by the Harness browser
     * fence, so this is what keeps status/info (which contain the DSH token URL)
     * from being readable by anything that can merely reach the port.
     */
    this.routeSecret = loadRouteSecret(this.stateDir, this.ctx)
    /** Identifies this plugin instance so a reloaded Host cannot inherit stale commands. */
    this.instanceId = randomBytes(8).toString('base64url')
  }

  /** Register routes and start supervision. */
  install() {
    this.ctx.effect(() => {
      const disposers = []
      const webServer = this.ctx.get('webServer')
      if (webServer) {
        disposers.push(
          webServer.register({
            kind: 'exact',
            path: ROUTES.status,
            handler: (req, res) => this.handleStatusRoute(req, res),
          }),
          webServer.register({
            kind: 'exact',
            path: ROUTES.action,
            handler: (req, res) => this.handleActionRoute(req, res),
          }),
          webServer.register({
            kind: 'exact',
            path: ROUTES.info,
            handler: (req, res) => this.handleInfoRoute(req, res),
          }),
        )
        if (typeof webServer.tapIndex === 'function') {
          disposers.push(
            webServer.tapIndex((html) => {
              const tag = `<script>window.__DSH_WECHAT_CLAWBOT__=${JSON.stringify(this.routeSecret)}</script>`
              return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${html}\n${tag}`
            }),
          )
        } else {
          // Custom routes carry the DSH token URL, so never degrade to a
          // predictable header when the Host cannot inject a real secret.
          this.routesAvailable = false
          this.ctx.logger.error(
            'wechat-clawbot: webServer.tapIndex is unavailable; the custom routes are disabled (fail closed)',
          )
        }
      } else {
        this.ctx.logger.debug('wechat-clawbot: no web server; the plugin page cannot load')
      }
      this.snapshotTimer = setInterval(() => {
        if (this.stopping) return
        this.updateDshWebSnapshot()
      }, 60_000)
      this.snapshotTimer.unref?.()
      this.ready = this.start().catch((error) => {
        this.ctx.logger.error(`wechat-clawbot: startup failed: ${messageOf(error)}`)
      })
      return () => {
        this.stopping = true
        if (this.snapshotTimer) clearInterval(this.snapshotTimer)
        this.snapshotTimer = null
        if (this.restartTimer) clearTimeout(this.restartTimer)
        this.restartTimer = null
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {}
        }
        void this.shutdown()
      }
    })
  }

  /** Ensure the state layout, publish the DSH URL snapshot and start the runtime. */
  async start() {
    await ensureStateLayout(this.stateDir)
    this.ctx.logger.info(`wechat-clawbot: state directory ${this.stateDir}`)
    this.updateDshWebSnapshot()
    if (this.config.autoStart) {
      await this.ensureDaemon()
    } else {
      this.ctx.logger.info('wechat-clawbot: autoStart is off; start the runtime from the plugin page')
    }
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Make sure exactly one runtime owned by this Harness process is running.
   * @returns {Promise<'running'|'started'|'stopped'>} the outcome.
   */
  async ensureDaemon() {
    if (this.stopping) return 'stopped'
    const existing = await this.findLiveDaemon()
    if (existing.alive) {
      if (existing.owned) return 'running'
      this.ctx.logger.warn(`wechat-clawbot: stopping a stale runtime owned by pid ${existing.pid}`)
      await enqueueCommand(this.stateDir, 'stop')
      await waitForPidGone(existing.pid, 4000)
    }
    this.spawnDaemon()
    return 'started'
  }

  /** @returns {Promise<{alive: boolean, owned: boolean, pid: number}>} live runtime facts. */
  async findLiveDaemon() {
    const status = await readStatus(this.stateDir)
    const pid = Number(status?.pid)
    if (!Number.isInteger(pid) || pid <= 0) return { alive: false, owned: false, pid: 0 }
    if (!processAlive(pid)) return { alive: false, owned: false, pid }
    const command = await processCommandLine(pid)
    if (!command.includes('clawbot.mjs')) return { alive: false, owned: false, pid }
    const owned = command.includes(`--owner-pid ${process.pid}`) || command.includes(`--owner-pid=${process.pid}`)
    return { alive: true, owned, pid }
  }

  /** Spawn the detached pure-script runtime. */
  spawnDaemon() {
    if (this.stopping) return
    const args = [
      RUNTIME_SCRIPT,
      'daemon',
      '--state-dir',
      this.stateDir,
      '--owner-pid',
      String(process.pid),
      '--owner-instance',
      this.instanceId,
      '--push-hour',
      String(this.config.pushHour),
      '--push-minute',
      String(this.config.pushMinute),
      '--reuse-token-days',
      String(this.config.reuseTokenDays),
      '--ipv6-watch-minutes',
      String(this.config.ipv6WatchMinutes),
      '--ssh-port',
      String(this.config.sshPort),
      '--max-send-chars',
      String(this.config.maxSendChars),
      '--log-level',
      this.config.logLevel,
    ]
    if (!this.config.pushEnabled) args.push('--no-push')
    if (this.config.allowedUsers.length > 0) args.push('--allowed-users', this.config.allowedUsers.join(','))
    if (this.config.baseUrl) args.push('--base-url', this.config.baseUrl)
    let child
    try {
      child = spawn(process.execPath, args, {
        cwd: PLUGIN_DIR,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      })
    } catch (error) {
      this.ctx.logger.error(`wechat-clawbot: could not spawn the runtime: ${messageOf(error)}`)
      return
    }
    this.child = child
    this.spawnedAt = Date.now()
    this.ctx.logger.info(`wechat-clawbot: runtime spawned (pid ${child.pid ?? 'unknown'})`)
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (this.stopping) return
      const ranFor = Date.now() - this.spawnedAt
      if (this.stoppedByUser) {
        this.ctx.logger.info('wechat-clawbot: runtime stopped by user; automatic restart suppressed')
        return
      }
      this.ctx.logger.warn(`wechat-clawbot: runtime exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`)
      if (ranFor > 60_000) this.restartCount = 0
      this.restartCount += 1
      if (this.restartCount > 20) {
        this.ctx.logger.error('wechat-clawbot: runtime keeps exiting; automatic restart disabled')
        return
      }
      const delay = Math.min(60_000, 5000 * this.restartCount)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (!this.stopping) void this.ensureDaemon()
      }, delay)
      this.restartTimer.unref?.()
    })
    child.once('error', (error) => {
      this.ctx.logger.error(`wechat-clawbot: runtime process error: ${messageOf(error)}`)
    })
  }

  /** Stop the runtime and release resources. */
  async shutdown() {
    this.stopping = true
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.snapshotTimer = null
    this.restartTimer = null
    await enqueueCommand(this.stateDir, 'stop').catch(() => {})
    const child = this.child
    this.child = null
    if (child && child.pid) {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
    this.ctx.logger.info('wechat-clawbot: host control plane stopped')
  }

  // ----------------------------------------------------------------- helpers

  /** Publish the token-bearing URL of this DSH Web process for the scripts. */
  updateDshWebSnapshot() {
    const connection = this.ctx.get('connection')
    const webApp = this.ctx.get('webApp')
    if (!connection?.authenticatedUrl || !webApp?.getAdvertisedUrl) {
      this.ctx.logger.debug('wechat-clawbot: connection/webApp services unavailable; scripts fall back to journalctl')
      return false
    }
    try {
      const baseUrl = webApp.getAdvertisedUrl()
      const authenticated = connection.authenticatedUrl(baseUrl)
      const parsed = new URL(authenticated)
      const token = parsed.searchParams.get('token') ?? ''
      const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
      if (!token || !port) return false
      void writeDshWebSnapshot(this.stateDir, {
        url: authenticated,
        origin: parsed.origin,
        port,
        token,
        pid: process.pid,
      }).catch((error) => this.ctx.logger.debug(`wechat-clawbot: could not write dsh-web.json: ${messageOf(error)}`))
      return true
    } catch (error) {
      this.ctx.logger.debug(`wechat-clawbot: could not build the authenticated URL: ${messageOf(error)}`)
      return false
    }
  }

  /**
   * Queue one runtime command.
   * @param {string} action - runtime action name.
   * @returns {Promise<string>} command id.
   */
  async sendCommand(action) {
    if (action === 'start') {
      const outcome = await this.ensureDaemon()
      return outcome
    }
    return enqueueCommand(this.stateDir, action, {
      ownerInstance: this.instanceId,
      targetOwnerPid: process.pid,
    })
  }

  /**
   * Run the access-info script and return its JSON result.
   * @param {{fresh?: boolean}} [options] - bypass the 10s cache.
   * @returns {Promise<object>} parsed access info.
   */
  async runAccessInfo(options = {}) {
    if (!options.fresh && this.infoCache && Date.now() - this.infoCache.at < 10_000) {
      return this.infoCache.value
    }
    const args = [ACCESS_INFO_SCRIPT, '--json', '--state-dir', this.stateDir, '--ssh-port', String(this.config.sshPort)]
    const child = spawn(process.execPath, args, { cwd: PLUGIN_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const kill = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 30_000)
    kill.unref?.()
    const value = await new Promise((resolve) => {
      child.once('error', (error) => {
        resolve({
          ok: false,
          checkedAt: new Date().toISOString(),
          ipv6: null,
          dsh: null,
          urls: { ipv6: null, local: null },
          warnings: [],
          errors: [{ code: 'info-script-failed', message: messageOf(error) }],
        })
      })
      child.once('close', () => {
        clearTimeout(kill)
        const text = Buffer.concat(stdout).toString('utf8').trim()
        const diagnostic = Buffer.concat(stderr).toString('utf8').trim()
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          resolve({
            ok: false,
            checkedAt: new Date().toISOString(),
            ipv6: null,
            dsh: null,
            urls: { ipv6: null, local: null },
            warnings: [],
            errors: [
              {
                code: 'info-script-invalid-json',
                message: `${messageOf(error)}${diagnostic ? `: ${diagnostic.slice(0, 300)}` : ''}`,
              },
            ],
          })
        }
      })
    })
    this.infoCache = { at: Date.now(), value }
    return value
  }

  // ------------------------------------------------------------------ routes

  /**
   * Answer one status request.
   * @param {object} req - Node request.
   * @param {object} res - Node response.
   */
  async handleStatusRoute(req, res) {
    if (!this.admitRoute(req, res, 'GET')) return
    try {
      await this.ready
      this.updateDshWebSnapshot()
      const status = (await readStatus(this.stateDir)) ?? null
      const daemonRunning = Boolean(status?.pid) && processAlive(status.pid)
      const info = await this.runAccessInfo()
      sendJson(res, 200, {
        ok: true,
        plugin: { id: name, version },
        config: {
          stateDir: this.stateDir,
          autoStart: this.config.autoStart,
          pushEnabled: this.config.pushEnabled,
          pushHour: this.config.pushHour,
          pushMinute: this.config.pushMinute,
          ipv6WatchMinutes: this.config.ipv6WatchMinutes,
          sshPort: this.config.sshPort,
          allowedUsers: this.config.allowedUsers,
          reuseTokenDays: this.config.reuseTokenDays,
        },
        daemon: {
          running: daemonRunning,
          pid: daemonRunning ? status.pid : 0,
          phase: daemonRunning ? (status.phase ?? 'unknown') : 'stopped',
          logPath: path.join(this.stateDir, FILES.logs, FILES.log),
        },
        status,
        info,
      })
    } catch (error) {
      this.ctx.logger.warn(`wechat-clawbot: status route failed: ${messageOf(error)}`)
      sendJson(res, 500, { ok: false, message: messageOf(error) })
    }
  }

  /**
   * Answer one control request.
   * @param {object} req - Node request.
   * @param {object} res - Node response.
   */
  async handleActionRoute(req, res) {
    if (!this.admitRoute(req, res, 'POST')) return
    try {
      await this.ready
      const body = await readJsonBody(req, 16 * 1024)
      const action = String(body?.action ?? '')
      if (!ACTION_ACTIONS.has(action)) {
        sendJson(res, 400, { ok: false, message: `unknown action "${action}"` })
        return
      }
      if (action === 'refresh') {
        sendJson(res, 200, { ok: true, action, message: '已刷新' })
        return
      }
      if (action === 'run-info') {
        const info = await this.runAccessInfo({ fresh: true })
        sendJson(res, 200, { ok: true, action, info, message: info?.ok ? '已获取最新访问信息' : '访问信息不完整，请查看提示' })
        return
      }
      if (action === 'start') {
        this.stoppedByUser = false
        const outcome = await this.ensureDaemon()
        sendJson(res, 200, {
          ok: true,
          action,
          message: outcome === 'running' ? '运行时已在运行' : '运行时已启动',
        })
        return
      }
      if (action === 'stop') this.stoppedByUser = true
      await this.sendCommand(action)
      sendJson(res, 200, { ok: true, action, message: '指令已发送' })
    } catch (error) {
      this.ctx.logger.warn(`wechat-clawbot: action route failed: ${messageOf(error)}`)
      sendJson(res, 500, { ok: false, message: messageOf(error) })
    }
  }

  /**
   * Answer one fresh access-info request.
   * @param {object} req - Node request.
   * @param {object} res - Node response.
   */
  async handleInfoRoute(req, res) {
    if (!this.admitRoute(req, res, 'GET')) return
    try {
      const info = await this.runAccessInfo({ fresh: true })
      sendJson(res, 200, { ok: Boolean(info?.ok), info })
    } catch (error) {
      sendJson(res, 500, { ok: false, message: messageOf(error) })
    }
  }

  /**
   * Same-origin + custom-header fence shared by every route.
   * @param {object} req - Node request.
   * @param {object} res - Node response.
   * @param {'GET'|'POST'} method - required method.
   * @returns {boolean} true when the request may proceed.
   */
  admitRoute(req, res, method) {
    if (req.method !== method) {
      sendJson(res, 405, { ok: false, message: 'method not allowed' })
      return false
    }
    if (!this.routesAvailable) {
      sendJson(res, 503, { ok: false, message: 'wechat-clawbot routes are disabled: no route secret available' })
      return false
    }
    if (!this.routeSecret || req.headers['x-wechat-clawbot'] !== this.routeSecret) {
      sendJson(res, 403, { ok: false, message: 'forbidden' })
      return false
    }
    const origin = req.headers.origin
    if (origin) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === req.headers.host
      } catch {}
      if (!sameOrigin) {
        sendJson(res, 403, { ok: false, message: 'cross-origin request rejected' })
        return false
      }
    }
    return true
  }
}

// -------------------------------------------------------------------- helpers

/**
 * Read and parse a bounded JSON request body.
 * @param {object} req - Node request.
 * @param {number} limit - maximum accepted byte length.
 * @returns {Promise<object>} parsed body.
 */
async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

/**
 * Send one JSON response.
 * @param {object} res - Node response.
 * @param {number} status - HTTP status code.
 * @param {object} value - JSON-serializable body.
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/**
 * Wait until a pid disappears.
 * @param {number} pid - process id.
 * @param {number} timeoutMs - maximum wait.
 * @returns {Promise<boolean>} true when the process is gone.
 */
async function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return !processAlive(pid)
}
