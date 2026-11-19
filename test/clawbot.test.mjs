import test from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs } from '../runtime/clawbot.mjs'

test('parseArgs defaults are safe', () => {
  const options = parseArgs([])
  assert.equal(options.mode, 'daemon')
  assert.equal(options.pushEnabled, true)
  assert.equal(options.pushHour, 15)
  assert.equal(options.ipv6WatchMinutes, 60)
  assert.deepEqual(options.allowedUsers, [])
})

test('parseArgs accepts daemon flags and clamps numbers', () => {
  const options = parseArgs([
    'daemon',
    '--push-hour=7',
    '--push-minute',
    '5',
    '--ipv6-watch-minutes',
    '99999',
    '--max-send-chars',
    '1',
    '--allowed-users',
    'a,b',
    '--ssh-port',
    '2222',
    '--no-push',
    '--log-level',
    'debug',
  ])
  assert.equal(options.mode, 'daemon')
  assert.equal(options.pushHour, 7)
  assert.equal(options.pushMinute, 5)
  assert.equal(options.ipv6WatchMinutes, 1440)
  assert.equal(options.maxSendChars, 200)
  assert.deepEqual(options.allowedUsers, ['a', 'b'])
  assert.equal(options.sshPort, 2222)
  assert.equal(options.pushEnabled, false)
  assert.equal(options.logLevel, 'debug')
})
