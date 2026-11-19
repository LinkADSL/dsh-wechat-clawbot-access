/**
 * WeChat message formatting for the ClawBot runtime.
 *
 * Kept separate from access-info.mjs so the detection/probing module and the
 * message shape can evolve and be tested independently.
 *
 * @module dsh-wechat-clawbot-access/runtime/message-format
 */
import { isoLocal } from './common.mjs'

const MAX_MESSAGE_CHARS = 1500

/**
 * Truncate a message to a character limit without splitting surrogate pairs.
 * The budget is measured in UTF-16 code units (String#length) so the result can
 * never exceed `max` even when it contains astral characters such as emoji.
 * @param {string} text - input text.
 * @param {number} max - maximum characters.
 * @returns {string} truncated text.
 */
export function clampMessage(text, max = MAX_MESSAGE_CHARS) {
  if (text.length <= max) return text;
  let result = '';
  for (const character of text) {
    if (result.length + character.length > max - 1) break;
    result += character;
  }
  return `${result}…`;
}


// ---------------------------------------------------------------------------
// WeChat message formatting (moved out of access-info.mjs)
// ---------------------------------------------------------------------------

/** Short Chinese hints used by formatMessage for known warning codes. */
const WARNING_HINTS = {
  'ssh-portproxy-missing': 'Windows 未把 IPv6 的 SSH 端口转发到 WSL，手机无法建隧道',
  'ssh-portproxy-stale': 'Windows 的 SSH 端口转发指向旧 WSL 地址，需要更新（WSL 重启后 WSL IP 会变）',
  'ssh-hostkey-missing': '未读到 SSH 主机公钥，无法提供服务器指纹',

  'windows-powershell-missing': '未找到 Windows PowerShell，无法读取 Windows IPv6',
  'windows-ipv6-failed': '读取 Windows IPv6 失败',
  'ipv6-random-only': '仅找到临时 IPv6 地址，地址可能变化',
  'dsh-state-file-stale': 'DSH 状态文件已过期，已改用 journal',
  'dsh-state-file-invalid': 'DSH 状态文件不可用，已改用 journal',
  'dsh-url-invalid': '显式 DSH URL 无效，已忽略',
  'listen-check-unavailable': '无法确认 DSH 端口监听状态',
  'journalctl-failed': '读取 journald 失败',
  'internal-error': '内部错误',
};

/**
 * Format `checkedAt` as `YYYY-MM-DD HH:mm`.
 * @param {unknown} value - ISO 8601 timestamp from getAccessInfo().
 * @returns {string} display timestamp, or '' when unparsable.
 */
export function formatDisplayTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(value ?? ''));
  if (match) return `${match[1]} ${match[2]}`;
  return '';
}

/**
 * Render one warning as a short single line.
 * @param {{code?: string, message?: string}} warning - warning entry.
 * @returns {string} display text, or '' when empty.
 */
/** @param {unknown} value - text to shorten. @param {number} limit - maximum length. @returns {string} clipped text. */
function shorten(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function formatWarningLine(warning) {
  // Prefer the specific message (it can contain a copyable repair command);
  // fall back to the short hint only when no message was supplied.
  if (typeof warning?.message === 'string' && warning.message.trim()) return shorten(warning.message, 320);
  const code = typeof warning?.code === 'string' ? warning.code : '';
  const hint = WARNING_HINTS[code];
  if (hint) return hint;
  return shorten(code, 160);
}

/**
 * Format access information as a short WeChat-ready message (plain text).
 * Success lists the IPv6 address and both token URLs; failure reports the error
 * summary plus whatever partial information was obtained. Warnings are appended
 * as short `⚠️` lines. The result never exceeds 1500 characters.
 * @param {{
 *   ok?: boolean,
 *   checkedAt?: string,
 *   ipv6?: null|{address: string, source: 'wsl'|'windows'},
 *   dsh?: null|{origin?: string, port?: number},
 *   urls?: {ipv6?: string|null, local?: string|null},
 *   warnings?: Array<{code: string, message: string}>,
 *   errors?: Array<{code: string, message: string}>,
 * }} info - value returned by getAccessInfo().
 * @returns {string} WeChat-ready message.
 */
export function formatMessage(info) {
  try {
    const value = info && typeof info === 'object' ? info : {};
    const when = formatDisplayTime(value.checkedAt) || formatDisplayTime(isoLocal(Date.now()));
    const ipv6 = value.ipv6 && typeof value.ipv6.address === 'string' ? value.ipv6 : null;
    const ssh = value.ssh && typeof value.ssh === 'object' ? value.ssh : null;
    const urls = value.urls && typeof value.urls === 'object' ? value.urls : {};
    const lines = [];

    if (value.ok) {
      lines.push(`🕒 ${when}`);
      if (ipv6) lines.push(`IPv6：${ipv6.address}`);
      if (ssh) lines.push(`SSH：端口 ${ssh.port}，用户名 ${ssh.user}`);
      if (ssh && ssh.tunnelCommand) lines.push(`隧道：${ssh.tunnelCommand}`);
      if (typeof urls.local === 'string' && urls.local) lines.push(`链接：${urls.local}`);
    } else {
      const errors = Array.isArray(value.errors) ? value.errors : [];
      const summary = errors.length
        ? errors.map((error) => error?.message || error?.code || '未知错误').join('；')
        : '未知错误';
      lines.push(`⚠️ DSH 信息获取失败：${summary}`);
      if (errors.some((error) => error?.code === 'ipv6-missing')) {
        lines.push('💡 本地 DSH 仍在运行；IPv6 是手机访问所必需，恢复后可直接重发消息。');
      }
      lines.push(`🕒 ${when}`);
      if (ipv6) lines.push(`IPv6：${ipv6.address}`);
      if (ssh) lines.push(`SSH：端口 ${ssh.port}，用户名 ${ssh.user}`);
      if (ssh && ssh.tunnelCommand) lines.push(`隧道：${ssh.tunnelCommand}`);
      if (typeof urls.local === 'string' && urls.local) lines.push(`链接：${urls.local}`);
    }

    // Only problem states add extra lines; normal replies stay to the four fields above.
    const warnings = Array.isArray(value.warnings) ? value.warnings : [];
    for (const warning of warnings) {
      const line = formatWarningLine(warning);
      if (line) lines.push(`⚠️ ${line}`);
    }
    return clampMessage(lines.join('\n'));
  } catch {
    return '⚠️ DSH 信息获取失败：内部错误';
  }
}


