/**
 * SSH tunnel information for the ClawBot access-info collector.
 * @module dsh-wechat-clawbot-access/runtime/ssh-info
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileReadable, detectWslIpv4, execWithTimeout } from './access-helpers.mjs'

export const DEFAULT_SSH_PORT = 22
const WINDOWS_PORTPROXY_COMMAND = 'netsh interface portproxy show v6tov4'
const WINDOWS_NETSH_PATH = '/mnt/c/Windows/System32/netsh.exe'
let hostKeysCache = { at: 0, dir: '', keys: [] }

// ---------------------------------------------------------------------------
// Port proxy parsing
// ---------------------------------------------------------------------------

/**
 * Parse `netsh interface portproxy show v6tov4` rows.
 * The header text is localised on non-English Windows, but data rows keep the
 * column layout `<listen addr> <listen port> <connect addr> <connect port>`.
 * @param {string} stdout - netsh output.
 * @returns {Array<{listenAddress: string, listenPort: number, connectAddress: string, connectPort: number}>}
 *   parsed rules.
 */
export function parsePortProxyRules(stdout) {
  const rules = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 4) continue;
    const listenPort = Number(tokens[1]);
    const connectPort = Number(tokens[3]);
    if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) continue;
    if (!Number.isInteger(connectPort) || connectPort < 1 || connectPort > 65535) continue;
    rules.push({
      listenAddress: tokens[0],
      listenPort,
      connectAddress: tokens[2],
      connectPort,
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// SSH tunnel information
// ---------------------------------------------------------------------------
//
// Since v2.2 the DSH web UI is no longer exposed on the network: the browser is
// reached through an SSH local port forward, so the bot delivers the SSH
// endpoint, host-key fingerprints, tunnel commands and the localhost token URL
// in every reply.

/** Public-key files of the WSL sshd, most preferred first. */
const SSH_HOST_KEY_FILES = [
  { type: 'ed25519', file: 'ssh_host_ed25519_key.pub' },
  { type: 'ecdsa', file: 'ssh_host_ecdsa_key.pub' },
  { type: 'rsa', file: 'ssh_host_rsa_key.pub' },
];

/**
 * Parse one OpenSSH public key line.
 * @param {string} text - file contents.
 * @returns {null|{type: string, blob: string, fingerprint: string, comment: string}} parsed key.
 */
export function parseOpenSshPublicKey(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith('#'));
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 2) return null;
  const [type, blob, ...commentParts] = parts;
  let decoded;
  try {
    decoded = Buffer.from(blob, 'base64');
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  const fingerprint = `SHA256:${createHash('sha256').update(decoded).digest('base64').replace(/=+$/, '')}`;
  return { type, blob, fingerprint, comment: commentParts.join(' ') };
}

/**
 * Read the sshd host public keys and compute their SHA256 fingerprints.
 * @param {string} sshDir - directory containing the host keys (default /etc/ssh).
 * @returns {Promise<Array<{type: string, fingerprint: string, comment: string}>>} readable host keys.
 */
async function readSshHostKeys(sshDir) {
  if (hostKeysCache.dir === sshDir && Date.now() - hostKeysCache.at < 60_000) return hostKeysCache.keys
  const keys = [];
  for (const entry of SSH_HOST_KEY_FILES) {
    try {
      const text = await fs.promises.readFile(path.join(sshDir, entry.file), 'utf8');
      const parsed = parseOpenSshPublicKey(text);
      if (parsed) keys.push({ type: parsed.type || entry.type, fingerprint: parsed.fingerprint, comment: parsed.comment });
    } catch {}
  }
  hostKeysCache = { at: Date.now(), dir: sshDir, keys }
  return keys;
}

/**
 * Detect the public SSH port from the Windows IPv6→SSH portproxy rule and warn
 * when that rule still points at a previous WSL IP (common after a reboot).
 * @param {object} settings - normalized settings.
 * @param {Array<{code: string, message: string}>} warnings - warnings sink.
 * @param {'wsl'|'windows'|null} source - where the public IPv6 came from.
 * @returns {Promise<number>} public SSH port (falls back to 22).
 */
async function detectPublicSshPort(settings, warnings, source) {
  const sshPort = settings.sshPort || DEFAULT_SSH_PORT;
  // Prefer the direct netsh interop path (~100 ms) over PowerShell (~1 s).
  let result = await execWithTimeout(
    WINDOWS_NETSH_PATH,
    ['interface', 'portproxy', 'show', 'v6tov4'],
    { timeoutMs: settings.timeoutMs },
  );
  if (!result.ok && (await fileReadable(settings.powershellPath))) {
    result = await execWithTimeout(
      settings.powershellPath,
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PORTPROXY_COMMAND],
      { timeoutMs: settings.timeoutMs },
    );
  }
  if (!result.ok) return sshPort;
  const rules = parsePortProxyRules(result.stdout);
  const sshRules = rules.filter((rule) => rule.connectPort === sshPort);
  const wslIpv4 = await detectWslIpv4(settings.timeoutMs);
  const fixCommands = (ipv4) =>
    `netsh interface portproxy set v4tov4 listenport=${sshPort} listenaddress=0.0.0.0 connectport=${sshPort} connectaddress=${ipv4} ; ` +
    `netsh interface portproxy set v6tov4 listenport=${sshPort} listenaddress=:: connectport=${sshPort} connectaddress=${ipv4}`;

  if (sshRules.length === 0) {
    if (source === 'windows') {
      warnings.push({
        code: 'ssh-portproxy-missing',
        message:
          `Windows 未把 IPv6 的 SSH(${sshPort}) 转发到 WSL，手机无法建立隧道。管理员 PowerShell 执行：` +
          `netsh interface portproxy add v4tov4 listenport=${sshPort} listenaddress=0.0.0.0 connectport=${sshPort} connectaddress=${wslIpv4 ?? '<WSL IPv4>'} ; ` +
          `netsh interface portproxy add v6tov4 listenport=${sshPort} listenaddress=:: connectport=${sshPort} connectaddress=${wslIpv4 ?? '<WSL IPv4>'} ; ` +
          `netsh advfirewall firewall add rule name="dsh_ssh_${sshPort}" dir=in action=allow protocol=TCP localport=${sshPort} profile=any`,
      });
    }
    return sshPort;
  }
  // Prefer a rule that still points at the current WSL address.
  const matching = wslIpv4 ? sshRules.find((rule) => rule.connectAddress === wslIpv4) : null;
  if (matching) return matching.listenPort || sshPort;
  if (source === 'windows' && wslIpv4) {
    const stale = sshRules[0];
    warnings.push({
      code: 'ssh-portproxy-stale',
      message:
        `Windows 的 SSH 端口转发仍指向旧 WSL 地址 ${stale.connectAddress}（当前 WSL 为 ${wslIpv4}），` +
        `重启后手机将连不上。请在管理员 PowerShell 执行：${fixCommands(wslIpv4)}`,
    });
  }
  return sshRules[0].listenPort || sshPort;
}

/**
 * Collect SSH tunnel facts for one access-info snapshot.
 * @param {{settings: object, ipv6: object, dsh: object, localUrl: string|null,
 *   warnings: Array<{code: string, message: string}>}} context - collection context.
 * @returns {Promise<null|object>} ssh info or null when no IPv6/DSH is available.
 */
export async function collectSshInfo(context) {
  const { settings, ipv6, dsh, localUrl, warnings } = context;
  if (!ipv6 || !dsh) return null;
  const user = typeof settings.sshUser === 'string' && settings.sshUser
    ? settings.sshUser
    : os.userInfo().username;
  const port = await detectPublicSshPort(settings, warnings, ipv6.source);
  const hostKeys = await readSshHostKeys(settings.sshDir);
  if (hostKeys.length === 0) {
    warnings.push({
      code: 'ssh-hostkey-missing',
      message: `未读到 SSH 主机公钥（${settings.sshDir}/ssh_host_*_key.pub），手机无法核对服务器指纹`,
    });
  }
  const host = ipv6.address;
  const loginCommand = `ssh -p ${port} ${user}@[${host}]`;
  const tunnelCommand = `ssh -N -L ${dsh.port}:127.0.0.1:${dsh.port} -p ${port} ${user}@[${host}]`;
  return {
    user,
    host,
    port,
    localPort: dsh.port,
    hostKeys,
    loginCommand,
    tunnelCommand,
    localUrl,
  };
}


