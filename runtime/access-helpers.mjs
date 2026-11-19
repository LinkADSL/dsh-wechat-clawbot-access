/**
 * Small process/filesystem helpers shared by access-info and ssh-info.
 * @module dsh-wechat-clawbot-access/runtime/access-helpers
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'

export const MAX_TIMEOUT_MS = 8000
export const DEFAULT_TIMEOUT_MS = 8000
const RE_WSL_IPV4_LINE = /^\d+:\s+(\S+)\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})\//

/** @param {string} file - file path. @returns {Promise<boolean>} whether it is readable. */
export async function fileReadable(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a pid belongs to a live process.
 * @param {number} pid - process id.
 * @returns {boolean} true when the process exists.
 */

/**
 * Run one child process with a hard timeout and never reject.
 * @param {string} command - executable path or name.
 * @param {string[]} args - argument list.
 * @param {{timeoutMs?: number, maxBuffer?: number}} [options] - limits.
 * @returns {Promise<{ok: boolean, timedOut: boolean, code: number|string, error: string|null, stdout: string, stderr: string}>}
 *   observed result; `ok` is false for spawn errors, non-zero exits and timeouts.
 */
export function execWithTimeout(command, args, options = {}) {
  const requested = Number(options.timeoutMs);
  const timeout = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const maxBuffer = Number.isFinite(Number(options.maxBuffer))
    ? Number(options.maxBuffer)
    : 16 * 1024 * 1024;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      execFile(
        command,
        args,
        { encoding: 'utf8', timeout, maxBuffer, windowsHide: true },
        (error, stdout, stderr) => {
          finish({
            ok: !error,
            timedOut: Boolean(error?.killed),
            code: error?.code ?? 0,
            error: error ? String(error.message || error) : null,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : '',
          });
        },
      );
    } catch (error) {
      finish({
        ok: false,
        timedOut: false,
        code: 'spawn-error',
        error: String(error?.message || error),
        stdout: '',
        stderr: '',
      });
    }
  });
}


/**
 * Best-effort WSL IPv4 address, used to build the portproxy hint.
 * @param {number} timeoutMs - child process timeout.
 * @returns {Promise<string|null>} dotted IPv4 literal or null.
 */
export async function detectWslIpv4(timeoutMs) {
  const result = await execWithTimeout('ip', ['-4', '-o', 'addr', 'show', 'scope', 'global'], { timeoutMs });
  if (!result.ok) return null;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = RE_WSL_IPV4_LINE.exec(line);
    if (match) return match[2];
  }
  return null;
}


export { RE_WSL_IPV4_LINE }
