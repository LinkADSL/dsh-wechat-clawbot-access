import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ClawbotRuntime, parseArgs } from '../runtime/clawbot.mjs'

test('runtime creates a pending owner and requires explicit approval', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawbot-test-'))
  const runtime = new ClawbotRuntime(parseArgs(['--state-dir', dir]))
  try {
    await runtime.loadState()
    // Keep this unit test off the filesystem/network/status paths.
    runtime.queueSave = () => {}
    runtime.saveStateNow = async () => {}
    runtime.updateStatus = async () => {}
    runtime.enqueueReply = () => {}
    runtime.sendText = async () => {}
    runtime.pushInfo = async () => ({ ok: true, sent: 1, failed: 0, message: '', errors: [] })

    runtime.acceptMessage({
      from_user_id: 'new-contact',
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })
    assert.equal(runtime.state.ownerId, '')
    assert.equal(runtime.state.pendingOwner?.id, 'new-contact')

    await runtime.runControl('approve-owner')
    assert.equal(runtime.state.ownerId, 'new-contact')
    assert.equal(runtime.state.pendingOwner, null)

    runtime.acceptMessage({
      from_user_id: 'owner-only',
      context_token: 'ctx-2',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })
    assert.equal(runtime.state.ownerId, 'new-contact')
    assert.equal(runtime.state.pendingOwner, null)
  } finally {
    await runtime.requestStop('test done').catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('only the approved owner receives push recipients', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawbot-test-'))
  const runtime = new ClawbotRuntime(parseArgs(['--state-dir', dir, '--allowed-users', 'a,b']))
  try {
    await runtime.loadState()
    runtime.queueSave = () => {}
    runtime.saveStateNow = async () => {}
    runtime.updateStatus = async () => {}
    runtime.enqueueReply = () => {}
    runtime.sendText = async () => {}
    runtime.pushInfo = async () => ({ ok: true, sent: 1, failed: 0, message: '', errors: [] })

    runtime.acceptMessage({
      from_user_id: 'a',
      context_token: 'ctx-a',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    })
    assert.equal(runtime.state.ownerId, 'a')
    const b = runtime.recordFor('b')
    b.contextToken = 'ctx-b'
    assert.deepEqual(runtime.recipients().map((row) => row.id), ['a'])
    // If the owner has no context yet, never fall back to another allow-listed contact.
    runtime.state.users.a.contextToken = ''
    assert.deepEqual(runtime.recipients(), [])
  } finally {
    await runtime.requestStop('test done').catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})
