/**
 * IPv6 detection, fast probes and Windows/WSL address ranking.
 * @module dsh-wechat-clawbot-access/runtime/ipv6-info
 */
import fs from 'node:fs'

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  WINDOWS_POWERSHELL_PATH,
  execWithTimeout,
  fileReadable,
  shorten,
} from './access-helpers.mjs'

/** PowerShell pipeline used to list IPv6 addresses of the Windows host. */
const WINDOWS_IPV6_COMMAND =
  "Get-NetIPAddress -AddressFamily IPv6 | Where-Object {$_.IPAddress -notmatch '^(fe80|::)'} | " +
  'Select-Object InterfaceAlias,IPAddress,PrefixOrigin,SuffixOrigin,AddressState | ConvertTo-Json -Compress';

/** Matches one WSL `ip -6 -o addr show scope global` line. */
const RE_WSL_IPV6_LINE = /^\d+:\s+(\S+)\s+inet6\s+([0-9a-fA-F:]+)\/(\d+)\s+scope\s+global\b(.*)$/;

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
export async function detectIpv6(context) {
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
