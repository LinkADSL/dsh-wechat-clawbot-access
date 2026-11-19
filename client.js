/**
 * Client half of the WeChat ClawBot bundle.
 *
 * Two seats, one shared status feed:
 * - `plugins.bundle.config` (key `dsh-wechat-clawbot-access`): the control panel on
 *   the bundle page — status, latest IPv6 / token URL, and the runtime actions.
 * - `shell.overlay`: the frame-wide login modal. Whenever the pure-script
 *   runtime waits for a WeChat QR confirmation, the modal appears with a real
 *   scannable QR code so the user can (re)connect the bot.
 *
 * All state comes from the Host half's same-origin JSON routes; nothing here
 * starts an Agent or talks to WeChat directly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-clawbot-access',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'wechat-clawbot'
    const STATUS_ROUTE = '/wechat-clawbot/status'
    const ACTION_ROUTE = '/wechat-clawbot/action'

    /**
     * Secret the Host injected into the authenticated index page. The custom
     * routes are not behind the Harness browser fence, so this value proves the
     * request comes from the authenticated plugin page. It is mutable: a page
     * opened before a plugin update can re-read the current value from `/`.
     */
    let routeSecret =
      typeof window !== 'undefined' &&
      typeof window.__DSH_WECHAT_CLAWBOT__ === 'string' &&
      window.__DSH_WECHAT_CLAWBOT__
        ? window.__DSH_WECHAT_CLAWBOT__
        : ''

    /**
     * Re-read the current route secret from the authenticated index page.
     * @returns {Promise<boolean>} whether a secret was obtained.
     */
    async function refreshRouteSecret() {
      try {
        const response = await fetch('/', { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) return false
        const html = await response.text()
        const match = html.match(/__DSH_WECHAT_CLAWBOT__=("(?:[^"\\]|\\.)*")/)
        if (!match) return false
        const value = JSON.parse(match[1])
        if (typeof value === 'string' && value) {
          routeSecret = value
          return true
        }
      } catch {}
      return false
    }

    /**
     * Same-origin request with the route secret; on 403 re-reads the secret from
     * the authenticated page and retries once (recovers from plugin updates).
     * @param {string} url - route URL.
     * @param {object} options - fetch options.
     * @returns {Promise<Response>} final response.
     */
    async function requestRoute(url, options = {}) {
      const headers = { ...(options.headers || {}) }
      if (routeSecret) headers['x-wechat-clawbot'] = routeSecret
      let response = await fetch(url, { ...options, headers })
      if (response.status === 403 && routeSecret) {
        if (await refreshRouteSecret()) {
          headers['x-wechat-clawbot'] = routeSecret
          response = await fetch(url, { ...options, headers })
        }
      }
      return response
    }

    const zh = {
      'panel.title': 'DSH 微信 ClawBot 访问桥',
      'panel.subtitle':
        '纯脚本运行时：扫码登录、收到任何微信消息自动回复、每天 15:00 推送访问信息。全程不经过模型，不消耗对话 token。',
      'state.running': '运行中',
      'state.connected': '已连接',
      'state.waitingQr': '等待扫码',
      'state.loginNeeded': '需要登录',
      'state.stopped': '未运行',
      'state.error': '异常',
      'field.phase': '状态',
      'field.owner': '绑定的微信号',
      'field.loginAt': '登录时间',
      'field.lastMessage': '最近消息',
      'field.nextPush': '下次自动推送',
      'field.lastPush': '上次推送',
      'field.ipv6Watch': 'IPv6 监控',
      'field.watchedIpv6': '已记录 IPv6',
      'field.lastIpv6Check': '上次 IPv6 检测',
      'field.nextIpv6Check': '下次 IPv6 检测',
      'field.probe': '检测方式/耗时',
      'probe.format': '每 {minutes} 分钟 · {ms} ms · {via}',
      'probe.off': '监控已关闭',
      'field.pid': '运行时 PID',
      'field.users': '已知联系人',
      'field.info': '最新访问信息',
      'field.ipv6': 'IPv6',
      'field.pendingOwner': '待确认绑定',
      'field.pendingPush': '待重试发送',
      'field.ssh': 'SSH 连接',
      'field.fingerprint': '主机指纹',
      'field.urlLocal': '隧道后网页',
      'field.log': '运行日志',
      'value.none': '—',
      'value.missing': '未获取到',
      'action.start': '启动运行时',
      'action.stop': '停止运行时',
      'action.relogin': '重新扫码登录',
      'action.logout': '退出登录',
      'action.sendInfo': '立即发送信息',
      'action.runInfo': '获取访问信息',
      'action.checkIpv6': '检测 IPv6',
      'action.clearOwner': '解除绑定',
      'action.approveOwner': '允许绑定',
      'action.rejectOwner': '拒绝绑定',
      'action.copy': '复制',
      'action.copied': '已复制',
      'action.close': '关闭',
      'action.refreshQr': '重新生成二维码',
      'action.refreshing': '处理中…',
      'qr.title': '扫码登录微信 ClawBot',
      'qr.subtitle': '请用手机微信扫描下方二维码，并在手机上确认连接。登录成功后本窗口会自动关闭。',
      'qr.expires': '二维码 {time} 后过期',
      'qr.expired': '二维码已过期，请重新生成',
      'qr.openLink': '在手机微信中打开登录链接',
      'qr.hint': '也可以点下面的按钮把登录链接发送到手机微信打开。',
      'qr.waitingConfirm': '已扫码？请在手机上点击确认…',
      'info.failed': '访问信息获取失败',
      'info.notReady': '正在获取访问信息…',
      'warn.title': '手机访问提示',
      'warn.ipv6-portproxy-missing':
        'Windows 尚未把 3080 端口的 IPv6 流量转发到 WSL：需要在管理员 PowerShell 中执行 netsh interface portproxy add v6tov4，否则手机打不开 IPv6 网页。',
      'warn.dsh-trusted-host-missing':
        'DSH 未信任该 IPv6 地址：需要在 dsh-web.service 的 ExecStart 加 --trusted-host "[IPv6]:端口" 并重启服务，否则浏览器无法调用后端。',
      'warn.dsh-unit-unknown': '无法确认 DSH 的 systemd 单元，请自行检查 --trusted-host 配置。',
      'warn.ipv6-missing': '未检测到可用的全局 IPv6。',
      'warn.generic': '存在影响手机访问的配置问题，详见运行日志。',
      'warn.ipv6Pending': '有一次 IPv6 变化通知未发送成功，会在微信回复上下文可用后自动重试。',
      'hint.ssh':
        'DSH 已不再对网络开放：电脑/手机先建立 SSH 隧道（本地 3080 → 127.0.0.1:3080），再打开「隧道后网页」。微信每次回复都会带完整 SSH 信息。',
      'hint.ipv6Watch':
        '每小时在本地检测一次 IPv6（WSL 读 /proc 零开销；Windows 走 netsh 约 80ms；只有地址真正变化才调用 PowerShell 建链并推送），变化时通过 bot 发送最新信息。',
      'empty.noQr': '当前没有待扫码的二维码。',
      'notice.startCommand': '已请求启动运行时',
      'notice.stopped': '已请求停止运行时',
      'notice.relogin': '已请求重新生成登录二维码',
      'notice.logout': '已退出微信登录',
      'notice.sendInfo': '已请求发送访问信息',
      'notice.checkIpv6': '已触发 IPv6 变化检测',
      'notice.cleared': '已解除微信绑定，下一条消息将重新申请绑定',
      'notice.ownerApproved': '已允许该微信号绑定',
      'notice.ownerRejected': '已拒绝该绑定请求',
      'notice.actionFailed': '操作失败：{message}',
      'notice.loadFailed': '无法读取插件状态：{message}',
      'notice.forbidden':
        '插件已更新或页面已过期（路由密钥不匹配）。请刷新页面；刷新后新版本会自动重新读取密钥，二维码弹窗也会出现。',
      'action.reloadPage': '刷新页面',
      'security.note':
        '安全提示：访问信息包含 DSH 的登录 token，只会回复给绑定你的微信；未授权联系人会被拒绝。',
      'runtime.note': '运行时脚本：runtime/clawbot.mjs，可由 systemd / 命令行独立运行，不依赖模型。',
      'action.confirmLogout': '确定退出微信登录？退出后需要重新扫码。',
    }

    const en = {
      'panel.title': 'DSH WeChat ClawBot Access Bridge',
      'panel.subtitle':
        'Pure-script runtime: QR login, auto-reply to every WeChat message, and a daily 15:00 push of access info. No model is involved and no conversation tokens are consumed.',
      'state.running': 'Running',
      'state.connected': 'Connected',
      'state.waitingQr': 'Waiting for QR scan',
      'state.loginNeeded': 'Login required',
      'state.stopped': 'Stopped',
      'state.error': 'Error',
      'field.phase': 'Status',
      'field.owner': 'Bound WeChat contact',
      'field.loginAt': 'Logged in at',
      'field.lastMessage': 'Last message',
      'field.nextPush': 'Next auto push',
      'field.lastPush': 'Last push',
      'field.ipv6Watch': 'IPv6 watch',
      'field.watchedIpv6': 'Tracked IPv6',
      'field.lastIpv6Check': 'Last IPv6 check',
      'field.nextIpv6Check': 'Next IPv6 check',
      'field.probe': 'Probe method / cost',
      'probe.format': 'every {minutes} min · {ms} ms · {via}',
      'probe.off': 'watch disabled',
      'field.pid': 'Runtime PID',
      'field.users': 'Known contacts',
      'field.info': 'Latest access info',
      'field.ipv6': 'IPv6',
      'field.pendingOwner': 'Pending binding',
      'field.pendingPush': 'Pending push retry',
      'field.ssh': 'SSH bridge',
      'field.fingerprint': 'Host key fingerprint',
      'field.urlLocal': 'Web URL after tunnel',
      'field.log': 'Runtime log',
      'value.none': '—',
      'value.missing': 'unavailable',
      'action.start': 'Start runtime',
      'action.stop': 'Stop runtime',
      'action.relogin': 'Scan QR again',
      'action.logout': 'Log out',
      'action.sendInfo': 'Send info now',
      'action.runInfo': 'Fetch access info',
      'action.checkIpv6': 'Check IPv6',
      'action.clearOwner': 'Unbind contact',
      'action.approveOwner': 'Approve',
      'action.rejectOwner': 'Reject',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.close': 'Close',
      'action.refreshQr': 'Regenerate QR',
      'action.refreshing': 'Working…',
      'qr.title': 'Scan to sign in to WeChat ClawBot',
      'qr.subtitle': 'Scan the QR code with your phone WeChat and confirm the connection. This window closes automatically once connected.',
      'qr.expires': 'QR expires in {time}',
      'qr.expired': 'QR expired — regenerate it',
      'qr.openLink': 'Open the login link on your phone',
      'qr.hint': 'You can also send the login link to your phone to open it in WeChat.',
      'qr.waitingConfirm': 'Scanned? Confirm on your phone…',
      'info.failed': 'Could not collect access info',
      'info.notReady': 'Collecting access info…',
      'warn.title': 'Phone access hints',
      'warn.ipv6-portproxy-missing':
        'Windows does not forward port 3080 over IPv6 to WSL yet: add an admin PowerShell netsh interface portproxy v6tov4 rule, otherwise the IPv6 URL will not open on your phone.',
      'warn.dsh-trusted-host-missing':
        'DSH does not trust this IPv6 authority: add --trusted-host "[IPv6]:port" to dsh-web.service and restart it, otherwise the browser cannot call the backend.',
      'warn.dsh-unit-unknown': 'Could not identify the DSH systemd unit; check --trusted-host manually.',
      'warn.ipv6-missing': 'No usable global IPv6 address was detected.',
      'warn.generic': 'A configuration issue may block phone access; see the runtime log.',
      'warn.ipv6Pending':
        'One IPv6 change notification is waiting to be sent; it retries once a WeChat reply context is available.',
      'hint.ssh':
        'DSH 已不再对网络开放：电脑/手机先建立 SSH 隧道（本地 3080 → 127.0.0.1:3080），再打开「隧道后网页」。微信每次回复都会带完整 SSH 信息。',
      'hint.ssh':
        'DSH is no longer reachable over the network: open an SSH tunnel (local 3080 → 127.0.0.1:3080) first, then open the tunneled URL. Every bot reply carries the full SSH details.',
      'hint.ipv6Watch':
        'Checks the machine IPv6 hourly (WSL: /proc read with no subprocess; Windows: netsh ~80 ms; PowerShell only when the stable address actually changes) and pushes the new info through the bot on change.',
      'empty.noQr': 'There is no QR code waiting for a scan.',
      'notice.startCommand': 'Runtime start requested',
      'notice.stopped': 'Runtime stop requested',
      'notice.relogin': 'QR login restart requested',
      'notice.logout': 'Logged out of WeChat',
      'notice.sendInfo': 'Access info push requested',
      'notice.checkIpv6': 'IPv6 change check triggered',
      'notice.cleared': 'WeChat binding cleared; the next message requests a new binding',
      'notice.ownerApproved': 'WeChat binding approved',
      'notice.ownerRejected': 'Binding request rejected',
      'notice.actionFailed': 'Action failed: {message}',
      'notice.loadFailed': 'Could not read plugin status: {message}',
      'notice.forbidden':
        'The plugin was updated or this page is out of date (route secret mismatch). Refresh the page; the new version re-reads the secret automatically and the QR dialog will appear.',
      'action.reloadPage': 'Refresh page',
      'security.note':
        'Security: access info contains the DSH login token and is only sent to the bound WeChat contact; unauthorized contacts are rejected.',
      'runtime.note': 'Runtime script: runtime/clawbot.mjs — can run standalone via systemd or a shell with no model dependency.',
      'action.confirmLogout': 'Log out of WeChat? You will need to scan a new QR code.',
    }

    const dictionaries = { zh, en }
    let localeService = null

    /** @returns {'zh'|'en'} active locale id. */
    function currentLocale() {
      try {
        const snapshot = localeService?.getLocale?.()
        const id = String(snapshot?.locale ?? snapshot?.id ?? '')
        return id.startsWith('en') ? 'en' : 'zh'
      } catch {
        return 'zh'
      }
    }

    /** React hook returning a translate function that follows the host locale. */
    function useTranslate() {
      const [locale, setLocale] = React.useState(currentLocale())
      React.useEffect(() => {
        if (!localeService?.subscribe) return undefined
        return localeService.subscribe(() => setLocale(currentLocale()))
      }, [])
      return React.useCallback(
        (key, params) => {
          const dict = dictionaries[locale] ?? dictionaries.zh
          let text = dict[key] ?? dictionaries.zh[key] ?? key
          if (params && typeof params === 'object') {
            for (const [name, value] of Object.entries(params)) {
              text = text.split(`{${name}}`).join(String(value))
            }
          }
          return text
        },
        [locale],
      )
    }

    /**
     * Fetch the Host status snapshot.
     * @returns {Promise<object>} parsed status payload.
     */
    async function fetchStatus() {
      const response = await requestRoute(STATUS_ROUTE, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok !== true) {
        const error = new Error(data.message || `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return data
    }

    /**
     * Post one control action.
     * @param {string} action - action name understood by the Host.
     * @returns {Promise<object>} parsed response.
     */
    async function postAction(action) {
      const response = await requestRoute(ACTION_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok !== true) {
        const error = new Error(data.message || `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return data
    }

    /**
     * Poll the Host status while the component is mounted and the page visible.
     * @param {number} intervalMs - poll interval.
     * @returns {{phase: string, data?: object, message?: string}} status state.
     */
    function useStatus(intervalMs) {
      const [state, setState] = React.useState({ phase: 'loading' })
      React.useEffect(() => {
        let alive = true
        let timer = null
        let failures = 0
        const schedule = (delay) => {
          if (!alive) return
          timer = setTimeout(() => void tick(), delay)
        }
        const tick = async () => {
          if (!alive) return
          if (typeof document !== 'undefined' && document.hidden) {
            schedule(intervalMs)
            return
          }
          try {
            const data = await fetchStatus()
            if (!alive) return
            failures = 0
            setState({ phase: 'ready', data })
            schedule(intervalMs)
          } catch (error) {
            if (!alive) return
            failures += 1
            setState({
              phase: 'error',
              message: String(error?.message || error),
              status: Number(error?.status) || 0,
            })
            schedule(Math.min(intervalMs * Math.min(failures + 1, 8), 15000))
          }
        }
        void tick()
        const onVisibility = () => {
          if (typeof document !== 'undefined' && !document.hidden && alive) {
            if (timer) clearTimeout(timer)
            timer = null
            void tick()
          }
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [intervalMs])
      return state
    }

    /** @param {number} time - epoch milliseconds. @returns {string} readable time or a dash. */
    function formatTime(time) {
      const value = Number(time)
      if (!Number.isFinite(value) || value <= 0) return ''
      try {
        return new Date(value).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      } catch {
        return new Date(value).toISOString()
      }
    }

    /** @param {number} ms - remaining milliseconds. @returns {string} mm:ss countdown. */
    function formatCountdown(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const minutes = String(Math.floor(total / 60)).padStart(2, '0')
      const seconds = String(total % 60).padStart(2, '0')
      return `${minutes}:${seconds}`
    }

    /**
     * Render a QR matrix as a crisp SVG.
     * @param {{qr: object|null, size?: number, label?: string}} props - QR record and pixel size.
     */
    function QrSvg({ qr, size = 220, label }) {
      const modules = Array.isArray(qr?.modules) ? qr.modules : null
      const count = Number(qr?.size) || (modules ? modules.length : 0)
      if (!modules || !count) {
        return h(
          'div',
          { style: styles.qrFallback },
          h('div', { style: styles.qrFallbackTitle }, qr?.link ? '无法在本地渲染二维码' : '二维码生成失败'),
          qr?.link
            ? h(
                'a',
                { href: qr.link, target: '_blank', rel: 'noreferrer', style: styles.link },
                qr.link,
              )
            : null,
          qr?.error ? h('div', { style: styles.hint }, String(qr.error)) : null,
        )
      }
      const quiet = 4
      const total = count + quiet * 2
      let path = ''
      for (let row = 0; row < count; row += 1) {
        const line = modules[row]
        if (!Array.isArray(line)) continue
        for (let column = 0; column < count; column += 1) {
          if (line[column] === true) path += `M${column + quiet} ${row + quiet}h1v1h-1z`
        }
      }
      return h(
        'div',
        { style: styles.qrFrame },
        h(
          'svg',
          {
            viewBox: `0 0 ${total} ${total}`,
            width: size,
            height: size,
            role: 'img',
            'aria-label': label || 'QR code',
            style: { display: 'block' },
          },
          h('rect', { width: total, height: total, fill: '#ffffff' }),
          h('path', { d: path, fill: '#111111', shapeRendering: 'crispEdges' }),
        ),
      )
    }

    /** @param {Function} t - translate function. @param {object|null} runtime - daemon status. @returns {string} probe summary. */
    function probeSummary(t, runtime) {
      const minutes = Number(runtime?.ipv6WatchMinutes) || 0
      if (!minutes) return t('probe.off')
      if (!runtime?.lastIpv6CheckAt) return t('value.none')
      return t('probe.format', {
        minutes,
        ms: Number(runtime.lastIpv6ProbeMs) || 0,
        via: runtime.lastIpv6ProbeVia || t('value.none'),
      })
    }

    /** Map one warning code to localized advice. */
    function warningText(t, code) {
      if (code && t(`warn.${code}`) !== `warn.${code}`) return t(`warn.${code}`)
      return t('warn.generic')
    }

    /** @param {object} status - Host status payload. @returns {object|null} live access info. */
    function infoOf(status) {
      return status?.info ?? null
    }

    /** @param {object} status - Host status payload. @returns {object|null} daemon status record. */
    function runtimeOf(status) {
      return status?.status ?? null
    }

    /** Shared button style factory. */
    function buttonStyle(kind, disabled) {
      const base = {
        height: '30px',
        padding: '0 12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12.5px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
      }
      if (kind === 'primary') {
        return {
          ...base,
          border: 'none',
          background: 'var(--dsw-alias-brand-primary)',
          color: '#ffffff',
        }
      }
      if (kind === 'danger') {
        return { ...base, color: 'var(--dsw-alias-state-error-primary)' }
      }
      return base
    }

    const styles = {
      wrap: { display: 'grid', gap: '14px', maxWidth: '720px', padding: '4px 0', fontSize: '13px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'grid',
        gap: '10px',
      },
      cardTitle: { fontSize: '13.5px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      subtitle: { fontSize: '12.5px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' },
      field: { display: 'grid', gap: '3px' },
      label: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' },
      value: {
        fontSize: '12.5px',
        color: 'var(--dsw-alias-label-primary)',
        wordBreak: 'break-all',
        fontVariantNumeric: 'tabular-nums',
      },
      mono: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        wordBreak: 'break-all',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      },
      pill: (kind) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '22px',
        padding: '0 9px',
        borderRadius: '999px',
        fontSize: '11.5px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color:
          kind === 'ok'
            ? 'var(--dsw-alias-state-success-primary)'
            : kind === 'warn'
              ? 'var(--dsw-alias-state-warn-primary)'
              : kind === 'error'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-state-idle-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      }),
      dot: (kind) => ({
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background:
          kind === 'ok'
            ? 'var(--dsw-alias-state-success-primary)'
            : kind === 'warn'
              ? 'var(--dsw-alias-state-warn-primary)'
              : kind === 'error'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-state-idle-primary)',
      }),
      qrFrame: {
        display: 'inline-flex',
        padding: '10px',
        borderRadius: '10px',
        background: '#ffffff',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      qrFallback: {
        display: 'grid',
        gap: '6px',
        padding: '10px',
        borderRadius: '8px',
        border: '1px dashed var(--dsw-alias-border-l2)',
      },
      qrFallbackTitle: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)' },
      link: { color: 'var(--dsw-alias-brand-primary)', fontSize: '12px', wordBreak: 'break-all' },
      notice: (kind) => ({
        fontSize: '12px',
        lineHeight: 1.5,
        color:
          kind === 'error'
            ? 'var(--dsw-alias-state-error-primary)'
            : kind === 'ok'
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-secondary)',
      }),
      warnList: { display: 'grid', gap: '6px', margin: 0, padding: 0, listStyle: 'none' },
      warnItem: {
        fontSize: '12px',
        lineHeight: 1.55,
        color: 'var(--dsw-alias-state-warn-primary)',
        wordBreak: 'break-word',
        userSelect: 'text',
      },
      errorText: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
      overlay: {
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(15, 18, 22, 0.55)',
        zIndex: 60,
        padding: '24px',
      },
      modal: {
        width: 'min(380px, 100%)',
        maxHeight: 'calc(100vh - 48px)',
        overflow: 'auto',
        borderRadius: '14px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.35)',
        padding: '20px',
        display: 'grid',
        gap: '14px',
        justifyItems: 'center',
      },
      modalTitle: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      modalSubtitle: {
        fontSize: '12.5px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
        textAlign: 'center',
      },
      modalActions: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' },
      sectionLabel: {
        fontSize: '11.5px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /** One labeled field row. */
    function Field({ label, children, mono }) {
      return h(
        'div',
        { style: styles.field },
        h('div', { style: styles.label }, label),
        h('div', { style: mono ? styles.mono : styles.value }, children || '—'),
      )
    }

    /** Copy text to the clipboard with a graceful fallback. */
    async function copyText(text) {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(String(text))
          return true
        }
      } catch {}
      try {
        const area = document.createElement('textarea')
        area.value = String(text)
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    /** A row of action buttons with the shared pending/notice state. */
    function ActionBar({ status, t, run }) {
      const runtime = runtimeOf(status)
      const connected = Boolean(runtime?.connected)
      return h(
        'div',
        { style: styles.row },
        h(
          'button',
          { type: 'button', style: buttonStyle('primary', false), onClick: () => void run('start', 'notice.startCommand') },
          t('action.start'),
        ),
        h(
          'button',
          { type: 'button', style: buttonStyle('plain', false), onClick: () => void run('stop', 'notice.stopped') },
          t('action.stop'),
        ),
        h(
          'button',
          { type: 'button', style: buttonStyle('plain', false), onClick: () => void run('relogin', 'notice.relogin') },
          t('action.relogin'),
        ),
        h(
          'button',
          { type: 'button', style: buttonStyle('plain', false), onClick: () => void run('send-info', 'notice.sendInfo') },
          t('action.sendInfo'),
        ),
        h(
          'button',
          { type: 'button', style: buttonStyle('plain', false), onClick: () => void run('check-ipv6', 'notice.checkIpv6') },
          t('action.checkIpv6'),
        ),
        h(
          'button',
          { type: 'button', style: buttonStyle('plain', false), onClick: () => void run('run-info', null) },
          t('action.runInfo'),
        ),
        runtime?.pendingOwner
          ? h(
              'button',
              {
                type: 'button',
                style: buttonStyle('primary', false),
                onClick: () => void run('approve-owner', 'notice.ownerApproved'),
              },
              t('action.approveOwner'),
            )
          : null,
        runtime?.pendingOwner
          ? h(
              'button',
              {
                type: 'button',
                style: buttonStyle('danger', false),
                onClick: () => void run('reject-owner', 'notice.ownerRejected'),
              },
              t('action.rejectOwner'),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            style: buttonStyle('danger', false),
            onClick: () =>
              void (connected
                ? run('logout', 'notice.logout')
                : run('clear-owner', 'notice.cleared')),
          },
          connected ? t('action.logout') : t('action.clearOwner'),
        ),
      )
    }

    /** The bundle page control panel. */
    function ClawbotPanel() {
      const t = useTranslate()
      const state = useStatus(2000)
      const [pending, setPending] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [localInfo, setLocalInfo] = React.useState(null)

      const status = state.data
      const runtime = runtimeOf(status)
      const daemon = status?.daemon
      const info = localInfo ?? infoOf(status)
      const warnings = Array.isArray(info?.warnings) ? info.warnings : []
      const errors = Array.isArray(info?.errors) ? info.errors : []

      const run = async (action, noticeKey) => {
        setPending(action)
        setNotice(null)
        try {
          const result = await postAction(action)
          if (action === 'run-info' && result.info) setLocalInfo(result.info)
          if (noticeKey) setNotice({ kind: 'ok', text: t(noticeKey) })
          else if (action === 'run-info') setNotice({ kind: 'ok', text: result.message || t('action.runInfo') })
        } catch (error) {
          setNotice({ kind: 'error', text: t('notice.actionFailed', { message: String(error?.message || error) }) })
        } finally {
          setPending(null)
        }
      }

      if (state.phase === 'loading') {
        return h('div', { style: styles.hint }, t('panel.subtitle'))
      }
      if (state.phase === 'error') {
        const forbidden = state.status === 403 || /forbidden/i.test(state.message)
        return h(
          'div',
          { style: styles.wrap },
          h(
            'div',
            { style: styles.card },
            h(
              'div',
              { style: styles.errorText },
              forbidden
                ? t('notice.forbidden')
                : t('notice.loadFailed', { message: state.message }),
            ),
            h(
              'div',
              { style: styles.row },
              h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle('primary', false),
                  onClick: () => {
                    if (typeof window !== 'undefined') window.location.reload()
                  },
                },
                t('action.reloadPage'),
              ),
            ),
          ),
        )
      }

      const phaseKey =
        runtime?.phase === 'login-waiting'
          ? 'state.waitingQr'
          : runtime?.phase === 'login-needed'
            ? 'state.loginNeeded'
            : runtime?.phase === 'error'
              ? 'state.error'
              : runtime?.phase === 'polling'
                ? 'state.connected'
                : daemon?.running
                  ? 'state.running'
                  : 'state.stopped'
      const phaseKind =
        runtime?.phase === 'login-waiting'
          ? 'warn'
          : runtime?.phase === 'polling'
            ? 'ok'
            : runtime?.phase === 'error'
              ? 'error'
              : daemon?.running
                ? 'ok'
                : 'idle'

      return h(
        'div',
        { style: styles.wrap },
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.dot(phaseKind) }),
            h('span', { style: styles.cardTitle }, t('panel.title')),
            h('span', { style: styles.pill(phaseKind) }, t(phaseKey)),
            daemon?.running ? h('span', { style: styles.hint }, `PID ${daemon.pid}`) : null,
          ),
          h('div', { style: styles.subtitle }, t('panel.subtitle')),
          h('div', { style: styles.row }, h(ActionBar, { status, t, run })),
          notice ? h('div', { style: styles.notice(notice.kind) }, notice.text) : null,
          pending ? h('div', { style: styles.hint }, t('action.refreshing')) : null,
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.sectionLabel }, 'STATUS'),
          h(
            'div',
            { style: styles.grid },
            h(Field, { label: t('field.owner'), children: runtime?.ownerId || t('value.none') }),
            runtime?.pendingOwner?.id
              ? h(Field, { label: t('field.pendingOwner'), children: runtime.pendingOwner.id, mono: true })
              : null,
            runtime?.pendingPush
              ? h(Field, {
                  label: t('field.pendingPush'),
                  children: `${runtime.pendingPush.attempts || 0}×`,
                })
              : null,
            h(Field, { label: t('field.users'), children: `${(runtime?.users || []).length}` }),
            h(Field, { label: t('field.loginAt'), children: formatTime(runtime?.loginAt) || t('value.none') }),
            h(Field, { label: t('field.lastMessage'), children: formatTime(runtime?.lastMessageAt) || t('value.none') }),
            h(Field, { label: t('field.nextPush'), children: formatTime(runtime?.nextPushAt) || t('value.none') }),
            h(Field, { label: t('field.lastPush'), children: formatTime(runtime?.lastPushAt) || t('value.none') }),
          ),
          runtime?.lastError?.message ? h('div', { style: styles.errorText }, `⚠️ ${runtime.lastError.message}`) : null,
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.sectionLabel }, t('field.info')),
          info?.ok === false || errors.length > 0
            ? h('div', { style: styles.errorText }, t('info.failed'))
            : null,
          h(
            'div',
            { style: styles.grid },
            h(Field, {
              label: t('field.ipv6'),
              children: info?.ipv6?.address
                ? `${info.ipv6.address}${info.ipv6.source === 'windows' ? '（Windows）' : '（WSL）'}`
                : t('value.missing'),
              mono: true,
            }),
            h(Field, {
              label: t('field.ssh'),
              children: info?.ssh?.loginCommand ?? t('value.missing'),
              mono: true,
            }),
            h(Field, {
              label: t('field.fingerprint'),
              children: info?.ssh?.fingerprint ?? t('value.missing'),
              mono: true,
            }),
            h(Field, {
              label: t('field.urlLocal'),
              children: info?.urls?.local ? h(UrlLine, { url: info.urls.local, t }) : t('value.missing'),
              mono: true,
            }),
            h(Field, { label: t('field.log'), children: daemon?.logPath || t('value.none'), mono: true }),
          ),
          warnings.length > 0
            ? h(
                'div',
                { style: { display: 'grid', gap: '4px' } },
                h('div', { style: styles.label }, t('warn.title')),
                h(
                  'ul',
                  { style: styles.warnList },
                  warnings.map((warning, index) =>
                    h(
                      'li',
                      { key: `${warning?.code || 'warn'}-${index}`, style: styles.warnItem },
                      warning?.message ? String(warning.message) : warningText(t, warning?.code),
                    ),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.sectionLabel }, t('field.ipv6Watch')),
          h(
            'div',
            { style: styles.grid },
            h(Field, { label: t('field.watchedIpv6'), children: runtime?.watchedIpv6 || t('value.missing'), mono: true }),
            h(Field, {
              label: t('field.lastIpv6Check'),
              children: formatTime(runtime?.lastIpv6CheckAt) || t('value.none'),
            }),
            h(Field, {
              label: t('field.nextIpv6Check'),
              children: formatTime(runtime?.nextIpv6CheckAt) || t('value.none'),
            }),
            h(Field, { label: t('field.probe'), children: probeSummary(t, runtime) }),
          ),
          runtime?.ipv6WatchPending ? h('div', { style: styles.warnItem }, t('warn.ipv6Pending')) : null,
          h('div', { style: styles.hint }, t('hint.ipv6Watch')),
        ),
        runtime?.qr
          ? h(
              'div',
              { style: styles.card },
              h('div', { style: styles.sectionLabel }, t('qr.title')),
              h(
                'div',
                { style: styles.row },
                h(QrSvg, { qr: runtime.qr, size: 180, label: t('qr.title') }),
                h(
                  'div',
                  { style: { display: 'grid', gap: '8px', alignContent: 'start' } },
                  h('div', { style: styles.hint }, t('qr.subtitle')),
                  runtime.qr.link
                    ? h(
                        'a',
                        { href: runtime.qr.link, target: '_blank', rel: 'noreferrer', style: styles.link },
                        t('qr.openLink'),
                      )
                    : null,
                ),
              ),
            )
          : null,
        h('div', { style: styles.hint }, t('security.note')),
        h('div', { style: styles.hint }, t('hint.ssh')),
        h('div', { style: styles.hint }, t('runtime.note')),
      )
    }

    /** A token URL line with a copy action. */
    function UrlLine({ url, t }) {
      const [copied, setCopied] = React.useState(false)
      return h(
        'span',
        { style: { display: 'inline-grid', gap: '2px' } },
        h('span', null, url),
        h(
          'button',
          {
            type: 'button',
            style: {
              justifySelf: 'start',
              border: 'none',
              padding: 0,
              background: 'transparent',
              color: 'var(--dsw-alias-brand-primary)',
              fontSize: '11.5px',
              cursor: 'pointer',
            },
            onClick: async () => {
              const ok = await copyText(url)
              if (ok) {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }
            },
          },
          copied ? t('action.copied') : t('action.copy'),
        ),
      )
    }

    /** The frame-wide login QR modal. */
    function QrOverlay() {
      const t = useTranslate()
      const state = useStatus(2000)
      const [dismissed, setDismissed] = React.useState(false)
      const [now, setNow] = React.useState(Date.now())
      const [pending, setPending] = React.useState(null)
      const seenRef = React.useRef('')
      const modalRef = React.useRef(null)
      const qr = state.phase === 'ready' ? runtimeOf(state.data)?.qr ?? null : null
      const qrcodeId = String(qr?.qrcode || '')

      React.useEffect(() => {
        if (qrcodeId && qrcodeId !== seenRef.current) {
          seenRef.current = qrcodeId
          setDismissed(false)
        }
        if (!qrcodeId) seenRef.current = ''
      }, [qrcodeId])

      React.useEffect(() => {
        if (!qr) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [Boolean(qr)])

      React.useEffect(() => {
        if (!qr) return undefined
        const root = modalRef.current
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        const focusable = root ? Array.from(root.querySelectorAll(selector)) : []
        if (focusable.length > 0) focusable[0].focus()
        const trap = (event) => {
          if (event.key !== 'Tab' || !root) return
          const items = Array.from(root.querySelectorAll(selector)).filter(
            (node) => !node.disabled && node.offsetParent !== null,
          )
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        window.addEventListener('keydown', trap, true)
        const overflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          window.removeEventListener('keydown', trap, true)
          document.body.style.overflow = overflow
          if (previous && typeof previous.focus === 'function') previous.focus()
        }
      }, [Boolean(qr)])

      React.useEffect(() => {
        if (!qr) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setDismissed(true)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [Boolean(qr)])

      if (!qr || dismissed) return null

      const remaining = Math.max(0, Number(qr.expiresAt || 0) - now)
      const expired = remaining <= 0
      const restart = async () => {
        setPending(true)
        try {
          await postAction('relogin')
        } catch {}
        setPending(false)
      }

      return h(
        'div',
        { style: styles.overlay },
        h(
          'div',
          {
            ref: modalRef,
            style: styles.modal,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('qr.title'),
          },
          h('div', { style: styles.modalTitle }, t('qr.title')),
          h('div', { style: styles.modalSubtitle }, t('qr.subtitle')),
          h(QrSvg, { qr, size: 240, label: t('qr.title') }),
          h(
            'div',
            { style: expired ? styles.errorText : styles.hint },
            expired ? t('qr.expired') : t('qr.expires', { time: formatCountdown(remaining) }),
          ),
          !expired ? h('div', { style: styles.hint }, t('qr.waitingConfirm')) : null,
          qr.link
            ? h(
                'a',
                { href: qr.link, target: '_blank', rel: 'noreferrer', style: styles.link },
                t('qr.openLink'),
              )
            : null,
          h('div', { style: styles.modalActions },
            h(
              'button',
              { type: 'button', style: buttonStyle('primary', pending), disabled: pending, onClick: () => void restart() },
              pending ? t('action.refreshing') : t('action.refreshQr'),
            ),
            h(
              'button',
              { type: 'button', style: buttonStyle('plain', false), onClick: () => setDismissed(true) },
              t('action.close'),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        localeService = ctx.get('locale') ?? null
        try {
          if (localeService?.register) {
            ctx.effect(() => localeService.register(NS, { zh, en }), 'wechat-clawbot: dictionaries')
          }
        } catch {}
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: 'dsh-wechat-clawbot-access',
              order: 10,
              locale: NS,
            },
            ClawbotPanel,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'wechat-clawbot-login',
              order: 90,
              locale: NS,
            },
            QrOverlay,
          ),
        )
      },
    }
  },
})
