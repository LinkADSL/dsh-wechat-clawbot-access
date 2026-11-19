import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatDisplayTime,
  formatMessage,
  parseOpenSshPublicKey,
  parsePortProxyRules,
} from '../runtime/access-info.mjs'

const portproxySample = [
  '',
  '连接 ipv6:                连接到 ipv4:',
  '',
  '地址           端口       地址           端口',
  '--------------- ----------  --------------- ----------',
  '::              22          192.0.2.10    22',
  '::              3080        127.0.0.1       3080',
  '',
].join('\n')

test('parsePortProxyRules reads localized netsh tables by column position', () => {
  const rules = parsePortProxyRules(portproxySample)
  assert.deepEqual(rules, [
    { listenAddress: '::', listenPort: 22, connectAddress: '192.0.2.10', connectPort: 22 },
    { listenAddress: '::', listenPort: 3080, connectAddress: '127.0.0.1', connectPort: 3080 },
  ])
})

test('parseOpenSshPublicKey computes the SHA256 fingerprint', () => {
  const key =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE7dFteZC3JdXyv3x8ie2s7YUxrqB9hNrS+IcUbcZgZp test@example.invalid'
  const parsed = parseOpenSshPublicKey(key)
  assert.ok(parsed)
  assert.equal(parsed.type, 'ssh-ed25519')
  assert.equal(parsed.comment, 'test@example.invalid')
  assert.match(parsed.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/)
  assert.equal(parseOpenSshPublicKey('not a key'), null)
})

test('formatDisplayTime renders the minute precision timestamp', () => {
  assert.equal(formatDisplayTime('2026-11-19T18:33:01+08:00'), '2026-11-19 18:33')
  assert.equal(formatDisplayTime('nope'), '')
})

test('formatMessage keeps the minimal access-info shape', () => {
  const message = formatMessage({
    ok: true,
    checkedAt: '2026-11-19T18:33:01+08:00',
    ipv6: { address: '240e::1', source: 'windows', candidates: [] },
    urls: { ipv6: null, local: 'http://127.0.0.1:3080/?token=t' },
    ssh: {
      user: 'tester',
      host: '240e::1',
      port: 22,
      localPort: 3080,
      tunnelCommand: 'ssh -N -L 3080:127.0.0.1:3080 -p 22 tester@[240e::1]',
      loginCommand: 'ssh -p 22 tester@[240e::1]',
      localUrl: 'http://127.0.0.1:3080/?token=t',
      hostKeys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }],
    },
    warnings: [],
    errors: [],
  })
  assert.match(message, /2026-11-19 18:33/)
  assert.match(message, /IPv6：240e::1/)
  assert.match(message, /SSH：端口 22，用户名 tester/)
  assert.match(message, /隧道：ssh -N -L 3080:127\.0\.0\.1:3080/)
  assert.match(message, /链接：http:\/\/127\.0\.0\.1:3080\/\?token=t/)
  assert.doesNotMatch(message, /SHA256:/)
})

test('formatMessage reports failures and warnings', () => {
  const message = formatMessage({
    ok: false,
    checkedAt: '2026-11-19T18:33:01+08:00',
    ipv6: null,
    urls: { ipv6: null, local: null },
    ssh: null,
    warnings: [{ code: 'ssh-portproxy-stale', message: '需要更新转发' }],
    errors: [{ code: 'ipv6-missing', message: '未找到 IPv6' }],
  })
  assert.match(message, /DSH 信息获取失败/)
  assert.match(message, /未找到 IPv6/)
  assert.match(message, /需要更新转发/)
})
