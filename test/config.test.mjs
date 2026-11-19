import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../index.js'

test('Config schema validates and defaults all supported settings', () => {
  const parsed = Config({})
  assert.equal(parsed.baseUrl, 'https://ilinkai.weixin.qq.com')
  assert.equal(parsed.autoStart, true)
  assert.equal(parsed.pushHour, 15)
  assert.equal(parsed.pushMinute, 0)
  assert.equal(parsed.ipv6WatchMinutes, 60)
  assert.equal(parsed.sshPort, 22)
  assert.equal(parsed.reuseTokenDays, 30)
  assert.equal(parsed.maxSendChars, 1800)
  assert.equal(parsed.logLevel, 'info')
  assert.deepEqual(parsed.allowedUsers, [])
})
