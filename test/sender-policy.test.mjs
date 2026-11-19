import test from 'node:test'
import assert from 'node:assert/strict'

import { PAIRING_TTL_MS, classifySender, maskId } from '../runtime/sender-policy.mjs'

const owner = 'owner@wechat'
const pending = (id, at = Date.now()) => ({ id, at })

test('maskId keeps short ids hidden and trims long ids', () => {
  assert.equal(maskId(''), '')
  assert.equal(maskId('short'), '***')
  assert.equal(maskId('abcdefghijklmnop'), 'abcd…mnop')
})

test('owner is the only contact admitted once ownership is locked', () => {
  assert.deepEqual(classifySender({ fromId: owner, ownerId: owner }), { action: 'owner' })
  assert.deepEqual(classifySender({ fromId: 'other', ownerId: owner }), {
    action: 'deny',
    reason: 'not-owner',
  })
})

test('allow-listed contacts may claim ownership; others are denied', () => {
  const input = { allowedUsers: ['a', 'b'], ownerId: '' }
  assert.deepEqual(classifySender({ ...input, fromId: 'a' }), { action: 'allowed-new-owner' })
  assert.deepEqual(classifySender({ ...input, fromId: 'z' }), {
    action: 'deny',
    reason: 'not-allow-listed',
  })
})

test('first unknown contact becomes a pending request, never an instant owner', () => {
  const first = classifySender({ fromId: 'new-contact', ownerId: '', allowedUsers: [], pendingOwner: null })
  assert.deepEqual(first, { action: 'pending-new' })
  const remind = classifySender({
    fromId: 'new-contact',
    ownerId: '',
    allowedUsers: [],
    pendingOwner: pending('new-contact'),
  })
  assert.deepEqual(remind, { action: 'pending-remind' })
  const other = classifySender({
    fromId: 'other',
    ownerId: '',
    allowedUsers: [],
    pendingOwner: pending('new-contact'),
  })
  assert.deepEqual(other, { action: 'deny', reason: 'pairing-pending-for-another-contact' })
})

test('an expired pending request may be replaced by a new one', () => {
  const old = classifySender({
    fromId: 'new-contact',
    ownerId: '',
    allowedUsers: [],
    pendingOwner: pending('stale-contact', Date.now() - PAIRING_TTL_MS - 1),
  })
  assert.deepEqual(old, { action: 'pending-new' })
})
