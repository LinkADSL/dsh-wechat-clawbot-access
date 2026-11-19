/**
 * Access information collector for the WeChat ClawBot runtime.
 *
 * Collects the two pieces of information a remote WeChat user needs to open
 * the DeepSeek Harness Web UI:
 *
 *   1. a reachable **IPv6** address for this machine, and
 *   2. the DSH Web **port + token** URL (the token authenticates the browser).
 *
 * It is a plain Node.js ESM module with **no third-party dependencies** and no
 * network access: it only runs a few local commands (`ip`, `ss`, `journalctl`,
 * the Windows PowerShell interop binary under `/mnt/c`, and reads local files).
 * Every child process has a hard timeout (default/ceiling 8000 ms) and every
 * failure degrades to a warning/error entry instead of throwing.
 *
 * Collection strategy (see the daemon contract):
 *
 *   IPv6:
 *     a. WSL itself: `ip -6 -o addr show scope global`, ignoring fe80::/:: and
 *        deprioritising temporary addresses. Usually empty in WSL NAT mode.
 *     b. Windows host via the WSL interop binary
 *        `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`
 *        (powershell is not on PATH): `Get-NetIPAddress -AddressFamily IPv6 ...`.
 *        Stable addresses (AddressState Preferred, SuffixOrigin Link/Dhcp, not
 *        Random) on WLAN/Ethernet win; all usable addresses go to `candidates`.
 *     c. Otherwise `ipv6: null` and error `ipv6-missing`.
 *
 *   DSH token URL:
 *     a. explicit override: `options.dshUrl` (CLI `--dsh-url`) or env
 *        `DSH_WEB_TOKEN_URL`  -> tokenSource `env`
 *     b. `<stateDir>/dsh-web.json` written by the DSH host plugin; accepted
 *        only while its port is listening and its pid is alive ->
 *        tokenSource `state-file`
 *     c. `journalctl --user --no-pager -n 5000`, regex
 *        `dsh web: http://...token=...`, newest match whose port is listening
 *        -> tokenSource `journal`
 *     d. Otherwise `dsh: null` and error `dsh-token-missing`.
 *
 *   Remote URLs (IPv6 must be bracketed and the port explicit):
 *     urls.ipv6  = `http://[<ipv6>]:<port>/?token=<token>`
 *     urls.local = `http://127.0.0.1:<port>/?token=<token>`
 *
 *   SSH tunnel:
 *     a. read the WSL sshd host public keys under `sshDir` and compute SHA256 fingerprints;
 *     b. read the Windows v6tov4 portproxy rule for `sshPort` (default 22);
 *     c. warn when the rule is missing or points at an old WSL IPv4 address.
 *
 *   Warnings (do not affect `ok`): SSH portproxy missing/stale, missing host keys,
 *   Windows IPv6 probe failures, stale DSH state file, journald failures.
 *
 * Public contract (must stay in sync with the daemon that imports it):
 *
 *   getAccessInfo(options?) -> Promise<{
 *     ok: boolean,
 *     checkedAt: string,                      // ISO 8601 with local offset (+08:00)
 *     ipv6: null | { address, source: 'wsl'|'windows', interface?, candidates: string[] },
 *     dsh:  null | { origin, port, tokenUrl, tokenSource: 'state-file'|'journal'|'env', pid? },
 *     urls: { ipv6: string|null, local: string|null },
 *     warnings: Array<{ code: string, message: string }>,
 *     errors:   Array<{ code: string, message: string }>,
 *   }>
 *
 *   formatMessage(info) -> string   // short WeChat-ready text, <= 1500 chars
 *
 * CLI:
 *   node runtime/access-info.mjs [--json] [--state-dir <dir>] [--no-windows]
 *        [--ssh-port <port>] [--dsh-url <token-url>]
 *   Human output defaults to formatMessage(); `--json` prints the structure.
 *   Exit code 1 when `ok` is false.
 *
 * @module dsh-wechat-clawbot-access/runtime/access-info
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, execWithTimeout, fileReadable } from './access-helpers.mjs';
import { DEFAULT_SSH_PORT, collectSshInfo } from './ssh-info.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default state directory (`~/.dsh/wechat-clawbot`). */
export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.dsh', 'wechat-clawbot');

/** Default public SSH port used when no override is configured. */

export { clampMessage, formatDisplayTime, formatMessage } from './message-format.mjs';

/** Last stable Windows IPv6, so repeated info collection can use the fast netsh path. */
let lastStableWindowsIpv6 = '';
export { DEFAULT_SSH_PORT, parseOpenSshPublicKey, parsePortProxyRules } from './ssh-info.mjs';

/** Hard ceiling for every child process timeout (milliseconds). */

/** Default timeout for child processes (milliseconds). */

/** Windows PowerShell through the WSL interop mount (not on PATH). */
export const WINDOWS_POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

/** Default systemd user unit for the DSH Web UI. */
/** WeChat message hard limit (characters). */

/** ExecStart flag used by DSH to allow browser API requests from a host. */

/**
 * PowerShell pipeline used to list IPv6 addresses of the Windows host.
 * - notmatch '^(fe80|::)' drops link-local/unspecified addresses;
 * - ConvertTo-Json -Compress returns one object or an array of objects.
 */
const WINDOWS_IPV6_COMMAND =
  "Get-NetIPAddress -AddressFamily IPv6 | Where-Object {$_.IPAddress -notmatch '^(fe80|::)'} | " +
  'Select-Object InterfaceAlias,IPAddress,PrefixOrigin,SuffixOrigin,AddressState | ConvertTo-Json -Compress';

/** PowerShell/netsh command listing Windows v6tov4 port proxy rules. */

/** Matches one WSL `ip -6 -o addr show scope global` line. */
const RE_WSL_IPV6_LINE = /^\d+:\s+(\S+)\s+inet6\s+([0-9a-fA-F:]+)\/(\d+)\s+scope\s+global\b(.*)$/;

/** Matches one WSL `ip -4 -o addr show scope global` line (WSL IPv4 helper). */

/** Extracts the token-bearing DSH Web URL from journald output. */
const RE_JOURNAL_TOKEN_URL = /dsh web: (https?:\/\/[^\s]+[?&]token=[A-Za-z0-9_-]+)/g;

/** Base64url token shape (DSH tokens are ~43 chars). */
const RE_DSH_TOKEN = /^[A-Za-z0-9_-]{16,200}$/;

// ---------------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------------

/**
 * Format one timestamp as a local ISO 8601 string with numeric offset.
 * @param {number} [time] - epoch milliseconds.
 * @returns {string} e.g. `2026-11-17T22:05:31+08:00`.
 */
function isoLocal(time = Date.now()) {
  const date = new Date(time);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const pad = (value) => String(value).padStart(2, '0');
  const hours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const minutes = pad(Math.abs(offsetMinutes) % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${hours}:${minutes}`
  );
}

/**
 * Shorten text for a single-line diagnostic.
 * @param {unknown} value - any value.
 * @param {number} [max] - maximum length (default 240).
 * @returns {string} shortened single-line text.
 */
function shorten(value, max = 240) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Hide a token inside arbitrary text (`token=...` -> `token=***`).
 * @param {unknown} value - any value.
 * @returns {string} text with token values masked.
 */
function maskTokens(value) {
  return String(value ?? '').replace(/([?&]token=)[^&\s"']+/gi, '$1***');
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Canonicalize one IPv6 literal to RFC 5952-ish lowercase compressed form.
 * This keeps string comparisons stable no matter which probe produced the
 * address (`/proc` hex expansion, netsh, PowerShell or `ip`).
 * @param {unknown} value - any IPv6 literal.
 * @returns {string} canonical address, or '' when it cannot be parsed.
 */
function canonicalIpv6(value) {
  let text = normalizeIpv6(value);
  if (!text) return '';
  let v4 = '';
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon < 0) return '';
    v4 = text.slice(lastColon + 1);
    text = `${text.slice(0, lastColon + 1)}0:0`;
    if (!text.includes('::')) text = text.replace(/:0:0$/, '::0:0');
  }
  const parseGroups = (chunk) => chunk.split(':').map((group) => {
    const number = Number.parseInt(group || '0', 16);
    return Number.isFinite(number) && number >= 0 && number <= 0xffff ? number : Number.NaN;
  });
  let groups;
  if (text.includes('::')) {
    if (text.indexOf('::') !== text.lastIndexOf('::')) return '';
    const [head, tail] = text.split('::');
    const left = head ? parseGroups(head) : [];
    const right = tail ? parseGroups(tail) : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return '';
    groups = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    groups = parseGroups(text);
  }
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return '';
  if (v4) {
    const parts = v4.split('.').map((part) => Number(part));
    if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      groups[6] = (parts[0] << 8) | parts[1];
      groups[7] = (parts[2] << 8) | parts[3];
    } else {
      return '';
    }
  }
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let index = 0; index <= 8; index += 1) {
    const isZero = index < 8 && groups[index] === 0;
    if (isZero && start < 0) start = index;
    if (!isZero && start >= 0) {
      const length = index - start;
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
      start = -1;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

/**
 * Strip brackets/zone index from an IPv6 literal and lowercase it.
 * @param {unknown} value - e.g. `[240e::1]` or `fe80::1%2`.
 * @returns {string} normalised address.
 */
function normalizeIpv6(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/%.*$/, '')
    .toLowerCase();
}

/**
 * Decide whether an IPv6 literal is worth offering to a remote client.
 * @param {string} address - normalised IPv6 address.
 * @returns {boolean} false for link-local, loopback and unspecified addresses.
 */
function isUsableIpv6(address) {
  if (!address || !address.includes(':')) return false;
  if (address === '::' || address === '::1') return false;
  if (/^fe80/i.test(address)) return false;
  if (/^::ffff:/i.test(address)) return false;
  return true;
}

/**
 * Rough check for global-unicast (2000::/3) IPv6 addresses.
 * @param {string} address - normalised IPv6 address.
 * @returns {boolean} true for a global unicast literal.
 */
function isGlobalUnicastIpv6(address) {
  const first = address.split(':')[0];
  if (!first) return false;
  const value = Number.parseInt(first, 16);
  return Number.isFinite(value) && value >= 0x2000 && value <= 0x3fff;
}

// ---------------------------------------------------------------------------
// IPv6 detection
// ---------------------------------------------------------------------------

/**
 * Read global IPv6 addresses configured inside WSL.
 * @param {number} timeoutMs - child process timeout.
 * @returns {Promise<null|{address: string, source: 'wsl', interface: string, candidates: string[]}>}
 *   the best WSL address or null.
 */
async function detectWslIpv6(timeoutMs) {
  const result = await execWithTimeout('ip', ['-6', '-o', 'addr', 'show', 'scope', 'global'], { timeoutMs });
  if (!result.ok) return null;
  /** @type {Array<{address: string, interface: string, temporary: boolean}>} */
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = RE_WSL_IPV6_LINE.exec(line);
    if (!match) continue;
    const address = match[2].toLowerCase();
    if (!isUsableIpv6(address)) continue;
    rows.push({
      address,
      interface: match[1],
      temporary: /\btemporary\b/i.test(match[4]) || /\bdeprecated\b/i.test(match[4]),
    });
  }
  if (!rows.length) return null;
  // Stable (non-temporary) addresses first; within a group keep kernel order.
  const stable = rows.filter((row) => !row.temporary);
  const ordered = stable.length ? [...stable, ...rows.filter((row) => row.temporary)] : rows;
  const candidates = [];
  for (const row of ordered) if (!candidates.includes(row.address)) candidates.push(row.address);
  const chosen = ordered[0];
  return { address: chosen.address, source: 'wsl', interface: chosen.interface, candidates };
}

/**
 * Read IPv6 addresses of the Windows host through the WSL interop PowerShell.
 * @param {{timeoutMs: number, powershellPath: string, warnings: Array<{code: string, message: string}>}} context
 *   collection context; warnings are appended in place.
 * @returns {Promise<null|{address: string, source: 'windows', interface?: string, candidates: string[], randomOnly: boolean}>}
 *   the best Windows address or null.
 */
async function detectWindowsIpv6(context) {
  const { timeoutMs, powershellPath, warnings } = context;
  const result = await execWithTimeout(
    powershellPath,
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_IPV6_COMMAND],
    { timeoutMs },
  );
  if (!result.ok) {
    const reason = result.timedOut ? `命令超时（${timeoutMs}ms）` : shorten(result.error || result.stderr);
    warnings.push({ code: 'windows-ipv6-failed', message: `读取 Windows IPv6 地址失败：${reason}` });
    return null;
  }
  const text = result.stdout.replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnings.push({
      code: 'windows-ipv6-failed',
      message: `Windows IPv6 输出不是合法 JSON：${shorten(error?.message ?? error)}`,
    });
    return null;
  }
  const items = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (item) => item && typeof item.IPAddress === 'string',
  );
  /** @type {Array<{address: string, interface: string, suffixOrigin: number|null, addressState: number|null, stable: boolean, preferred: boolean}>} */
  const rows = [];
  for (const item of items) {
    const address = normalizeIpv6(item.IPAddress);
    if (!isUsableIpv6(address)) continue;
    const suffixOrigin = Number(item.SuffixOrigin);
    const addressState = Number(item.AddressState);
    const suffix = Number.isFinite(suffixOrigin) ? suffixOrigin : null;
    const state = Number.isFinite(addressState) ? addressState : null;
    rows.push({
      address,
      interface: typeof item.InterfaceAlias === 'string' ? item.InterfaceAlias : '',
      suffixOrigin: suffix,
      addressState: state,
      // 5 = Random (privacy/temporary suffix); Link(4)/Dhcp(3)/Manual(1) are stable.
      stable: suffix !== 5,
      // 4 = Preferred; missing state is treated as acceptable.
      preferred: state === null || state === 4,
    });
  }
  if (!rows.length) return null;

  /**
   * Higher is better: stable suffix > WLAN/Ethernet interface > global unicast >
   * Preferred state; privacy/teredo addresses are pushed down.
   * @param {(typeof rows)[number]} row - one candidate row.
   * @returns {number} sort score.
   */
  const rank = (row) => {
    let score = 0;
    if (row.stable) score += 6;
    else score -= 10;
    if (row.preferred) score += 3;
    if (/WLAN|Wi-?Fi|Wireless|Ethernet|以太网|无线/i.test(row.interface)) score += 5;
    if (/Teredo|ISATAP|Loopback|Pseudo/i.test(row.interface)) score -= 12;
    if (isGlobalUnicastIpv6(row.address)) score += 2;
    return score;
  };
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => rank(right.row) - rank(left.row) || left.index - right.index)
    .map((entry) => entry.row);
  const candidates = [];
  for (const row of ordered) if (!candidates.includes(row.address)) candidates.push(row.address);
  const chosen = ordered[0];
  return {
    address: chosen.address,
    source: 'windows',
    interface: chosen.interface || undefined,
    candidates,
    randomOnly: !rows.some((row) => row.stable),
  };
}

/**
 * Detect the best IPv6 address: WSL first, then the Windows host.
 * @param {{settings: object, warnings: Array<{code: string, message: string}>}} context - collection context.
 * @returns {Promise<null|{address: string, source: 'wsl'|'windows', interface?: string, candidates: string[]}>}
 *   contract-shaped ipv6 value or null.
 */
async function detectIpv6(context) {
  const { settings, warnings } = context;
  const wsl = await detectWslIpv6(settings.timeoutMs);
  if (wsl) return wsl;
  if (settings.noWindows) return null;
  // Fast path: netsh candidates + a process-local cache of the last stable
  // address. PowerShell is only needed when the stable address actually moves.
  const fast = await probeIpv6Fast({
    cachedStable: lastStableWindowsIpv6,
    timeoutMs: settings.timeoutMs,
    windowsPowerShell: settings.powershellPath,
  });
  if (fast.source === 'windows' && fast.address) {
    if (fast.stable) lastStableWindowsIpv6 = fast.address;
    return {
      source: 'windows',
      address: fast.address,
      candidates: fast.candidates,
      ...(fast.interface ? { interface: fast.interface } : {}),
    };
  }
  if (!(await fileReadable(settings.powershellPath))) {
    warnings.push({
      code: 'windows-powershell-missing',
      message: `未找到 Windows PowerShell（${settings.powershellPath}），无法读取 Windows 主机的 IPv6 地址`,
    });
    return null;
  }
  const windows = await detectWindowsIpv6({
    timeoutMs: settings.timeoutMs,
    powershellPath: settings.powershellPath,
    warnings,
  });
  if (!windows) return null;
  if (windows.randomOnly) {
    warnings.push({
      code: 'ipv6-random-only',
      message: '仅找到 Windows 隐私/临时 IPv6 地址（SuffixOrigin=Random），地址可能频繁变化',
    });
  }
  const { randomOnly: _ignored, ...info } = windows;
  return info;
}

// ---------------------------------------------------------------------------
// Fast IPv6 probe (hourly change watcher)
// ---------------------------------------------------------------------------
//
// The daemon checks the machine IPv6 every hour. Running the full collector that
// often would spawn PowerShell (~1.1 s) plus journalctl/ss for nothing, so this
// probe is split in two stages:
//
//   1. WSL: read /proc/net/if_inet6 directly (no process, well under 1 ms). The
//      kernel exposes the interface scope and the permanent/tentative flags, so
//      a stable global address can be picked without `ip` or PowerShell.
//   2. Windows (WSL NAT mode): `netsh interface ipv6 show addresses` (~80 ms)
//      only extracts IPv6 literals, which is locale independent. If the cached
//      stable address is still among the candidates, no further work is done.
//      PowerShell (SuffixOrigin/AddressState aware, ~1.1 s) runs only when the
//      cached stable address disappeared, i.e. when the address really changed.
//
// A native helper would not help: the cost of the Windows path is the WSL->Windows
// process interop floor (~60 ms even for cmd.exe), not the JavaScript parsing.

/**
 * Derive the Windows netsh path from the configured PowerShell path.
 * @param {string} powershellPath - interop PowerShell path.
 * @returns {string} matching netsh path.
 */
function windowsNetshPath(powershellPath) {
  const text = String(powershellPath ?? '');
  const marker = '/WindowsPowerShell/';
  const index = text.indexOf(marker);
  if (index > 0) return `${text.slice(0, index)}/netsh.exe`;
  return '/mnt/c/Windows/System32/netsh.exe';
}

/**
 * Convert a 32-character /proc/net/if_inet6 hex address into colon form.
 * @param {string} hex - 32 lowercase hex characters.
 * @returns {string} colon-separated IPv6 literal.
 */
function hexToIpv6(hex) {
  const groups = [];
  for (let index = 0; index < 8; index += 1) groups.push(hex.slice(index * 4, index * 4 + 4));
  return groups.join(':');
}

/**
 * Read WSL global IPv6 addresses directly from /proc/net/if_inet6.
 * @param {string} [procPath] - alternate proc file (tests).
 * @returns {Promise<null|{address: string, candidates: string[], interface: string, stable: boolean, temporaryOnly: boolean}>}
 *   best WSL address, or null when WSL has no global IPv6.
 */
async function readProcWslIpv6(procPath = '/proc/net/if_inet6') {
  let text;
  try {
    text = await fs.promises.readFile(procPath, 'utf8');
  } catch {
    return null;
  }
  /** @type {Array<{address: string, stable: boolean, name: string}>} */
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [hex, , , scope, flags, name] = parts;
    if (!name || name === 'lo') continue;
    if (scope !== '00') continue; // 00 = global scope; fe80::/10 uses scope 20
    if (hex.length !== 32) continue;
    const address = canonicalIpv6(hexToIpv6(hex));
    if (!isUsableIpv6(address)) continue;
    const bits = Number.parseInt(flags, 16);
    if (!Number.isFinite(bits)) continue;
    if (bits & 0x40) continue; // tentative
    if (bits & 0x08) continue; // dadfailed
    rows.push({ address, stable: (bits & 0x80) !== 0, name });
  }
  if (!rows.length) return null;
  const ordered = [...rows.filter((row) => row.stable), ...rows.filter((row) => !row.stable)];
  const candidates = [];
  for (const row of ordered) if (!candidates.includes(row.address)) candidates.push(row.address);
  return {
    address: ordered[0].address,
    candidates,
    interface: ordered[0].name,
    stable: ordered[0].stable,
    temporaryOnly: !rows.some((row) => row.stable),
  };
}

/**
 * Cheap Windows IPv6 candidate probe through netsh.
 * Only IPv6 literals are parsed, so localized column labels do not matter.
 * @param {{timeoutMs: number, netshPath: string, warnings: Array<{code: string, message: string}>}} context
 *   probe context; warnings are appended in place.
 * @returns {Promise<null|{candidates: string[]}>} candidates, or null when netsh failed.
 */
async function detectWindowsCandidatesFast(context) {
  const { timeoutMs, netshPath, warnings } = context;
  const result = await execWithTimeout(netshPath, ['interface', 'ipv6', 'show', 'addresses'], {
    timeoutMs: Math.min(timeoutMs, 4000),
  });
  if (!result.ok) {
    warnings.push({
      code: 'windows-netsh-failed',
      message: `netsh 读取 Windows IPv6 失败：${result.timedOut ? '超时' : shorten(result.error || result.stderr)}`,
    });
    return null;
  }
  const candidates = [];
  const pattern = /([0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){2,7})(?:%\d+)?/g;
  for (const match of result.stdout.matchAll(pattern)) {
    const address = canonicalIpv6(match[1]);
    if (!isUsableIpv6(address)) continue;
    if (!candidates.includes(address)) candidates.push(address);
  }
  return { candidates };
}

/**
 * Fast IPv6 probe for the hourly change watcher.
 *
 * Unlike {@link getAccessInfo} this never collects the DSH token, journal or
 * portproxy state; it only answers "which IPv6 is the machine using now".
 *
 * @param {{cachedStable?: string, noWindows?: boolean, timeoutMs?: number,
 *   windowsPowerShell?: string, windowsNetshPath?: string, procPath?: string}} [options]
 *   probe options; `cachedStable` avoids PowerShell while that address is still present.
 * @returns {Promise<{
 *   source: 'wsl'|'windows'|null,
 *   address: string|null,
 *   candidates: string[],
 *   stable: boolean,
 *   via: 'proc'|'netsh'|'powershell'|'none',
 *   temporaryOnly: boolean,
 *   interface?: string,
 *   durationMs: number,
 *   warnings: Array<{code: string, message: string}>,
 *   errors: Array<{code: string, message: string}>,
 * }>} probe result; every failure is reported, never thrown.
 */
export async function probeIpv6Fast(options = {}) {
  const startedAt = Date.now();
  const warnings = [];
  const errors = [];
  const requested = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const powershellPath = typeof options.windowsPowerShell === 'string' && options.windowsPowerShell.trim()
    ? options.windowsPowerShell.trim()
    : WINDOWS_POWERSHELL_PATH;
  const cachedStable = canonicalIpv6(options.cachedStable ?? '');
  const make = (patch) => ({
    source: null,
    address: null,
    candidates: [],
    stable: false,
    via: 'none',
    temporaryOnly: false,
    durationMs: Date.now() - startedAt,
    warnings,
    errors,
    ...patch,
  });

  // Stage 1: WSL itself, no child process.
  const wsl = await readProcWslIpv6(options.procPath);
  if (wsl) {
    return make({
      source: 'wsl',
      address: wsl.address,
      candidates: wsl.candidates,
      stable: wsl.stable,
      via: 'proc',
      temporaryOnly: wsl.temporaryOnly,
      ...(wsl.interface ? { interface: wsl.interface } : {}),
    });
  }
  if (options.noWindows) {
    errors.push({ code: 'ipv6-missing', message: 'WSL 没有全局 IPv6，且已禁用 Windows 检测' });
    return make({ via: 'proc' });
  }

  // Stage 2: Windows host, cheap candidates first.
  const netshPath = typeof options.windowsNetshPath === 'string' && options.windowsNetshPath.trim()
    ? options.windowsNetshPath.trim()
    : windowsNetshPath(powershellPath);
  let candidates = [];
  const fast = await detectWindowsCandidatesFast({ timeoutMs, netshPath, warnings });
  if (fast) candidates = fast.candidates;

  if (candidates.length === 0 && fast === null) {
    // netsh unavailable: resolve directly through PowerShell if we can.
    if (await fileReadable(powershellPath)) {
      const resolved = await detectWindowsIpv6({ timeoutMs, powershellPath, warnings });
      if (resolved) {
        return make({
          source: 'windows',
          address: resolved.address,
          candidates: resolved.candidates,
          stable: !resolved.randomOnly,
          via: 'powershell',
          temporaryOnly: resolved.randomOnly,
          ...(resolved.interface ? { interface: resolved.interface } : {}),
        });
      }
    }
  }

  if (candidates.length === 0) {
    errors.push({ code: 'ipv6-missing', message: 'WSL 与 Windows 均未检测到全局 IPv6' });
    return make({ via: fast ? 'netsh' : 'powershell' });
  }

  // The cached stable address is still present: no expensive resolution needed.
  if (cachedStable && candidates.includes(cachedStable)) {
    return make({ source: 'windows', address: cachedStable, candidates, stable: true, via: 'netsh' });
  }

  // Only one candidate: it can be used as-is.
  if (candidates.length === 1) {
    return make({ source: 'windows', address: candidates[0], candidates, stable: true, via: 'netsh' });
  }

  // The stable address may have changed: ask PowerShell to rank the candidates.
  if (!(await fileReadable(powershellPath))) {
    warnings.push({
      code: 'windows-powershell-missing',
      message: `未找到 Windows PowerShell（${powershellPath}），无法判定稳定 IPv6`,
    });
    const guess = candidates.find((address) => isGlobalUnicastIpv6(address)) ?? null;
    if (guess) return make({ source: 'windows', address: guess, candidates, stable: false, via: 'netsh' });
    errors.push({ code: 'ipv6-unresolved', message: '有 IPv6 候选地址但无法确定稳定地址' });
    return make({ source: 'windows', candidates, via: 'netsh' });
  }
  const resolved = await detectWindowsIpv6({ timeoutMs, powershellPath, warnings });
  if (!resolved) {
    const guess = candidates.find((address) => isGlobalUnicastIpv6(address)) ?? null;
    if (guess) return make({ source: 'windows', address: guess, candidates, stable: false, via: 'netsh' });
    errors.push({ code: 'ipv6-unresolved', message: '有 IPv6 候选地址但无法确定稳定地址' });
    return make({ source: 'windows', candidates, via: 'netsh' });
  }
  const merged = [];
  for (const address of [resolved.address, ...resolved.candidates, ...candidates]) {
    const canonical = canonicalIpv6(address);
    if (canonical && !merged.includes(canonical)) merged.push(canonical);
  }
  return make({
    source: 'windows',
    address: canonicalIpv6(resolved.address) || resolved.address,
    candidates: merged,
    stable: !resolved.randomOnly,
    via: 'powershell',
    temporaryOnly: resolved.randomOnly,
    ...(resolved.interface ? { interface: resolved.interface } : {}),
  });
}

// ---------------------------------------------------------------------------
// Listener / DSH token detection
// ---------------------------------------------------------------------------

/**
 * Parse the local listen port from one `ss -tln` line.
 * @param {string} line - one output line.
 * @returns {number|null} port or null.
 */
function parseSsListenPort(line) {
  const fields = line.trim().split(/\s+/);
  if (fields[0] !== 'LISTEN' || fields.length < 4) return null;
  const local = fields[3];
  const index = local.lastIndexOf(':');
  if (index < 0) return null;
  const port = Number(local.slice(index + 1));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Read listening TCP ports from `/proc/net/tcp` + `/proc/net/tcp6` (state 0A).
 * @returns {Promise<Set<number>|null>} ports, or null when neither file is readable.
 */
async function readProcNetTcpPorts() {
  const ports = new Set();
  let readable = false;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let raw;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    readable = true;
    for (const line of raw.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[3] !== '0A') continue;
      const local = fields[1] ?? '';
      const index = local.lastIndexOf(':');
      if (index < 0) continue;
      const port = Number.parseInt(local.slice(index + 1), 16);
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
    }
  }
  return readable ? ports : null;
}

/**
 * Read the set of listening TCP ports (ss first, /proc/net/tcp as fallback).
 * @param {number} timeoutMs - child process timeout.
 * @returns {Promise<{known: boolean, method: string|null, ports: Set<number>}>}
 *   `known: false` means listening state could not be observed at all.
 */
async function readListeningPorts(timeoutMs) {
  const ss = await execWithTimeout('ss', ['-tln'], { timeoutMs });
  if (ss.ok) {
    const ports = new Set();
    for (const line of ss.stdout.split(/\r?\n/)) {
      const port = parseSsListenPort(line);
      if (port !== null) ports.add(port);
    }
    return { known: true, method: 'ss', ports };
  }
  const ports = await readProcNetTcpPorts();
  if (ports) return { known: true, method: 'proc', ports };
  return { known: false, method: null, ports: new Set() };
}

/**
 * Parse one URL that is expected to carry a `token` query parameter.
 * @param {unknown} raw - URL text.
 * @returns {null|{origin: string, port: number, token: string, tokenUrl: string}} parsed parts or null.
 */
function parseTokenUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let token = url.searchParams.get('token') ?? '';
  if (!token) {
    const match = /[?&]token=([^&#\s]+)/.exec(text);
    if (match) {
      try {
        token = decodeURIComponent(match[1]);
      } catch {
        token = match[1];
      }
    }
  }
  if (!token) return null;
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { origin: url.origin, port, token, tokenUrl: url.href };
}

/**
 * Read `<stateDir>/dsh-web.json` written by the DSH host plugin.
 * @param {string} stateDir - state directory.
 * @param {{known: boolean, ports: Set<number>}} listenInfo - listening ports observation.
 * @returns {Promise<{dsh: null|object, warnings: Array<{code: string, message: string}>, reason?: string}>}
 *   accepted DSH info, or null plus diagnostics.
 */
async function readStateFile(stateDir, listenInfo) {
  const file = path.join(stateDir, 'dsh-web.json');
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return { dsh: null, warnings: [] }; // Typical case: the host plugin has not written it (yet).
  }
  const invalid = (detail) => ({
    dsh: null,
    warnings: [{
      code: 'dsh-state-file-invalid',
      message: `DSH 状态文件 ${file} ${detail}，将改用 journalctl`,
    }],
    reason: `状态文件无效（${detail}）`,
  });
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid('不是合法 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('内容不是对象');

  const parsedUrl = typeof value.url === 'string' ? parseTokenUrl(value.url) : null;
  const token = (typeof value.token === 'string' && value.token.trim())
    ? value.token.trim()
    : (parsedUrl?.token ?? '');
  let origin = typeof value.origin === 'string' && value.origin.trim()
    ? value.origin.trim()
    : (parsedUrl?.origin ?? '');
  let port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = parsedUrl?.port ?? 0;
  const pid = Number(value.pid);
  const hasPid = Number.isInteger(pid) && pid > 0;

  if (!token || !origin || !port) return invalid('缺少 url/token/origin/port');

  // A stale snapshot must never shadow the journal: DSH may have restarted.
  if (listenInfo.known && !listenInfo.ports.has(port)) {
    return {
      dsh: null,
      warnings: [{
        code: 'dsh-state-file-stale',
        message: `DSH 状态文件已过期：端口 ${port} 当前未在监听，将改用 journalctl`,
      }],
      reason: `状态文件端口 ${port} 未监听`,
    };
  }
  if (hasPid && !processAlive(pid)) {
    return {
      dsh: null,
      warnings: [{
        code: 'dsh-state-file-stale',
        message: `DSH 状态文件已过期：pid ${pid} 已不存在，将改用 journalctl`,
      }],
      reason: `状态文件 pid ${pid} 已退出`,
    };
  }

  origin = origin.replace(/\/+$/, '');
  let tokenUrl = parsedUrl?.tokenUrl ?? '';
  if (!tokenUrl || !parseTokenUrl(tokenUrl)) {
    tokenUrl = `${origin}/?token=${encodeURIComponent(token)}`;
  }
  const dsh = {
    origin,
    port,
    tokenUrl,
    tokenSource: 'state-file',
    ...(hasPid ? { pid } : {}),
  };
  return { dsh, warnings: [] };
}

/**
 * Fallback: find the newest DSH token URL in journald whose port is listening.
 * @param {{known: boolean, ports: Set<number>}} listenInfo - listening ports observation.
 * @param {number} timeoutMs - child process timeout.
 * @returns {Promise<{dsh: null|object, warnings: Array<{code: string, message: string}>, reason?: string}>}
 *   accepted DSH info, or null plus diagnostics.
 */
async function readJournalDsh(listenInfo, timeoutMs) {
  const attempts = [
    ['--user', '--no-pager', '-n', '5000'],
    ['--no-pager', '-n', '5000'], // Fallback: system journal (e.g. root service).
  ];
  let journalError = null;
  let reason = null;
  let sawTokenLines = 0;
  for (const args of attempts) {
    const result = await execWithTimeout('journalctl', args, { timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    if (!result.ok) {
      journalError = result.timedOut ? `journalctl 超时（${timeoutMs}ms）` : shorten(result.error || result.stderr);
      continue;
    }
    const matches = [...result.stdout.matchAll(RE_JOURNAL_TOKEN_URL)].map((match) => match[1]);
    if (!matches.length) continue;
    sawTokenLines = matches.length;
    // Newest first: older tokens belong to previous DSH processes.
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const parsed = parseTokenUrl(matches[index]);
      if (!parsed || !RE_DSH_TOKEN.test(parsed.token)) continue;
      if (listenInfo.known && !listenInfo.ports.has(parsed.port)) {
        reason = `journal 最近一条 token 对应端口 ${parsed.port} 未在监听`;
        continue;
      }
      return {
        dsh: {
          origin: parsed.origin,
          port: parsed.port,
          tokenUrl: parsed.tokenUrl,
          tokenSource: 'journal',
        },
        warnings: [],
        reason: null,
      };
    }
    break; // The user journal was readable; a system-journal retry cannot add listeners.
  }
  const warnings = [];
  if (journalError && !sawTokenLines) {
    warnings.push({ code: 'journalctl-failed', message: `读取 journald 失败：${journalError}` });
  }
  if (!reason && !journalError) {
    reason = 'journal 中没有找到 `dsh web: ...token=...` 记录';
  }
  return { dsh: null, warnings, reason };
}

/**
 * Detect DSH origin/port/token through the documented priority chain.
 * @param {{settings: object, warnings: Array<{code: string, message: string}>}} context - collection context.
 * @returns {Promise<{dsh: null|object, detail: string|null}>} DSH info or null plus a reason.
 */
async function detectDsh(context) {
  const { settings, warnings } = context;

  // a. Explicit override (CLI/daemon option, then environment).
  const explicit = [settings.dshUrl, process.env.DSH_WEB_TOKEN_URL]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((value) => value.length > 0);
  if (explicit) {
    const parsed = parseTokenUrl(explicit);
    if (parsed) {
      return {
        dsh: {
          origin: parsed.origin,
          port: parsed.port,
          tokenUrl: parsed.tokenUrl,
          tokenSource: 'env',
        },
        detail: null,
      };
    }
    warnings.push({
      code: 'dsh-url-invalid',
      message: `显式 DSH URL（--dsh-url/DSH_WEB_TOKEN_URL）无法解析出 token：${maskTokens(shorten(explicit, 160))}`,
    });
  }

  const listenInfo = await readListeningPorts(settings.timeoutMs);

  // b. Snapshot written by the DSH host plugin.
  const state = await readStateFile(settings.stateDir, listenInfo);
  warnings.push(...state.warnings);
  if (state.dsh) return { dsh: state.dsh, detail: null };

  // c. journald token line.
  const journal = await readJournalDsh(listenInfo, settings.timeoutMs);
  warnings.push(...journal.warnings);
  if (journal.dsh) return { dsh: journal.dsh, detail: null };

  if (!listenInfo.known) {
    warnings.push({
      code: 'listen-check-unavailable',
      message: '无法确认 DSH 端口是否在监听（ss 与 /proc/net/tcp 均不可用）',
    });
  }
  return { dsh: null, detail: journal.reason ?? state.reason ?? null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalise getAccessInfo() options.
 * @param {unknown} options - caller options.
 * @returns {{timeoutMs: number, powershellPath: string, stateDir: string, noWindows: boolean, dshUrl: string}}
 *   normalised settings.
 */
function normalizeOptions(options) {
  const value = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const rawTimeout = Number(value.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(rawTimeout, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const powershellPath =
    typeof value.windowsPowerShell === 'string' && value.windowsPowerShell.trim()
      ? value.windowsPowerShell.trim()
      : WINDOWS_POWERSHELL_PATH;
  const rawStateDir = typeof value.stateDir === 'string' ? value.stateDir.trim() : '';
  const stateDir = rawStateDir ? path.resolve(rawStateDir) : DEFAULT_STATE_DIR;
  return {
    timeoutMs,
    powershellPath,
    stateDir,
    noWindows: value.noWindows === true,
    dshUrl: typeof value.dshUrl === 'string' ? value.dshUrl.trim() : '',
    sshUser: typeof value.sshUser === 'string' ? value.sshUser.trim() : '',
    sshDir: typeof value.sshDir === 'string' && value.sshDir.trim() ? path.resolve(value.sshDir.trim()) : '/etc/ssh',
    sshPort: Number.isInteger(Number(value.sshPort)) && Number(value.sshPort) >= 1 && Number(value.sshPort) <= 65535
      ? Number(value.sshPort)
      : DEFAULT_SSH_PORT,
  };
}

/**
 * Build one token-bearing Web UI URL.
 * @param {string} base - `http://host` or `http://[ipv6]`.
 * @param {number} port - TCP port.
 * @param {string} token - URL token.
 * @returns {string} URL.
 */
function buildTokenUrl(base, port, token) {
  return `${base}:${port}/?token=${token}`;
}

/**
 * Collect IPv6 + DSH token access information. Never rejects.
 * @param {{stateDir?: string, noWindows?: boolean, dshUrl?: string, timeoutMs?: number,
 *   windowsPowerShell?: string, sshUser?: string, sshDir?: string, sshPort?: number}} [options]
 *   optional overrides.
 * @returns {Promise<{
 *   ok: boolean,
 *   checkedAt: string,
 *   ipv6: null|{address: string, source: 'wsl'|'windows', interface?: string, candidates: string[]},
 *   dsh: null|{origin: string, port: number, tokenUrl: string, tokenSource: 'state-file'|'journal'|'env', pid?: number},
 *   urls: {ipv6: string|null, local: string|null},
 *   ssh: null|{user, host, port, localPort, hostKeys: Array<{type, fingerprint, comment}>,
 *             loginCommand, tunnelCommand, localUrl},
 *   warnings: Array<{code: string, message: string}>,
 *   errors: Array<{code: string, message: string}>,
 * }>} access information.
 */
export async function getAccessInfo(options = {}) {
  const checkedAt = isoLocal(Date.now());
  /** @type {Array<{code: string, message: string}>} */
  const warnings = [];
  /** @type {Array<{code: string, message: string}>} */
  const errors = [];
  let ipv6 = null;
  let dsh = null;
  let ssh = null;
  const urls = { ipv6: null, local: null };

  try {
    const settings = normalizeOptions(options);

    ipv6 = await detectIpv6({ settings, warnings });
    if (!ipv6) {
      errors.push({
        code: 'ipv6-missing',
        message: settings.noWindows
          ? '未找到可用 IPv6 地址（WSL 没有全局 IPv6，且已用 --no-windows 禁用 Windows 检测）'
          : '未找到可用 IPv6 地址（WSL 没有全局 IPv6，Windows 主机也未返回稳定地址）',
      });
    }

    const detected = await detectDsh({ settings, warnings });
    dsh = detected.dsh;
    if (!dsh) {
      errors.push({
        code: 'dsh-token-missing',
        message:
          '未找到可用的 DSH 带 token 网页地址' +
          (detected.detail ? `（${detected.detail}）` : '（状态文件缺失/过期，journal 也没有匹配记录）'),
      });
    }

    if (dsh) {
      const token = parseTokenUrl(dsh.tokenUrl)?.token ?? '';
      if (token) {
        urls.local = buildTokenUrl('http://127.0.0.1', dsh.port, token);
        if (ipv6) urls.ipv6 = buildTokenUrl(`http://[${ipv6.address}]`, dsh.port, token);
      }
      if (ipv6) {
        ssh = await collectSshInfo({ settings, ipv6, dsh, localUrl: urls.local, warnings });
      }
    }
  } catch (error) {
    errors.push({
      code: 'internal-error',
      message: `采集访问信息时发生内部错误：${shorten(error?.message ?? error, 300)}`,
    });
  }

  return {
    ok: Boolean(ipv6 && dsh),
    checkedAt,
    ipv6,
    dsh,
    urls,
    ssh,
    warnings,
    errors,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  '用法：node runtime/access-info.mjs [--json] [--state-dir <目录>] [--no-windows] [--ssh-port <端口>] [--dsh-url <带 token 的 URL>] [--probe]';

/**
 * Parse CLI arguments.
 * @param {string[]} argv - arguments without `node` and the script path.
 * @returns {{json: boolean, stateDir?: string, noWindows: boolean, dshUrl?: string, help: boolean}}
 *   parsed arguments.
 * @throws {Error} on an unknown or incomplete option.
 */
function parseCliArgs(argv) {
  const parsed = { json: false, noWindows: false, probe: false, help: false };
  const takeValue = (name, index) => {
    const value = argv[index];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`缺少参数：${name}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--no-windows') {
      parsed.noWindows = true;
    } else if (arg === '--probe') {
      parsed.probe = true;
    } else if (arg === '--state-dir') {
      parsed.stateDir = takeValue('--state-dir', (index += 1));
    } else if (arg.startsWith('--state-dir=')) {
      const value = arg.slice('--state-dir='.length);
      if (!value) throw new Error('缺少参数：--state-dir');
      parsed.stateDir = value;
    } else if (arg === '--ssh-port') {
      const raw = takeValue('--ssh-port', (index += 1));
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--ssh-port 必须是 1-65535 的整数');
      parsed.sshPort = port;
    } else if (arg.startsWith('--ssh-port=')) {
      const port = Number(arg.slice('--ssh-port='.length));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--ssh-port 必须是 1-65535 的整数');
      parsed.sshPort = port;
    } else if (arg === '--dsh-url') {
      parsed.dshUrl = takeValue('--dsh-url', (index += 1));
    } else if (arg.startsWith('--dsh-url=')) {
      parsed.dshUrl = arg.slice('--dsh-url='.length) || undefined;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return parsed;
}

/** CLI entry point: print message/JSON and set the exit code. */
async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (parsed.probe) {
    const probe = await probeIpv6Fast({ noWindows: parsed.noWindows });
    process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
    process.exitCode = probe.address ? 0 : 1;
    return;
  }
  const info = await getAccessInfo({
    ...(parsed.stateDir ? { stateDir: parsed.stateDir } : {}),
    noWindows: parsed.noWindows,
    ...(parsed.dshUrl ? { dshUrl: parsed.dshUrl } : {}),
    ...(parsed.sshPort ? { sshPort: parsed.sshPort } : {}),
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatMessage(info)}\n`);
  }
  process.exitCode = info.ok ? 0 : 1;
}

/** @returns {boolean} whether this file was executed directly (`node access-info.mjs`). */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((error) => {
    process.stderr.write(`access-info 失败：${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
