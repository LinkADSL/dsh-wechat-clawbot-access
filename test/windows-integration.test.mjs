import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

import { parsePortProxyRules, probeIpv6Fast } from '../runtime/access-info.mjs'

const execFileAsync = promisify(execFile)
const NETS = '/mnt/c/Windows/System32/netsh.exe'
const hasWindowsInterop = process.platform === 'linux' && existsSync(NETS)

test('Windows integration: netsh portproxy output is parsed into typed rules', { skip: !hasWindowsInterop && 'Windows interop not available' }, async () => {
  const { stdout } = await execFileAsync(NETS, ['interface', 'portproxy', 'show', 'v6tov4'], {
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  })
  assert.equal(typeof stdout, 'string')
  const rules = parsePortProxyRules(stdout)
  assert.ok(Array.isArray(rules))
  for (const rule of rules) {
    assert.match(rule.listenAddress, /^[:0-9a-fA-F.]+$/)
    assert.ok(Number.isInteger(rule.listenPort) && rule.listenPort >= 1 && rule.listenPort <= 65535)
    assert.match(rule.connectAddress, /^[:0-9a-fA-F.]+$/)
    assert.ok(Number.isInteger(rule.connectPort) && rule.connectPort >= 1 && rule.connectPort <= 65535)
  }
})

test('Windows integration: fast IPv6 probe returns a typed observation', { skip: !hasWindowsInterop && 'Windows interop not available' }, async () => {
  const result = await probeIpv6Fast({ timeoutMs: 8000 })
  assert.equal(typeof result, 'object')
  assert.ok(result !== null)
  assert.ok(['wsl', 'windows', null].includes(result.source))
  assert.ok(['proc', 'netsh', 'powershell', 'none'].includes(result.via))
  assert.ok(Array.isArray(result.candidates))
  assert.ok(Array.isArray(result.warnings))
  assert.ok(Array.isArray(result.errors))
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0)
})
