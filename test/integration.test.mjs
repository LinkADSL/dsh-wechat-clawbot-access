import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ClawbotRuntime, parseArgs } from '../runtime/clawbot.mjs'

/**
 * Start a tiny iLink-compatible HTTP server for one integration test.
 * @returns {Promise<{base: string, close: () => Promise<void>, sent: object[]}>}
 */
async function startMockIlink() {
  const sent = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      const url = new URL(req.url, 'http://127.0.0.1')
      res.setHeader('content-type', 'application/json')
      if (url.pathname.endsWith('/get_bot_qrcode')) {
        res.end(JSON.stringify({ qrcode: 'qr-test', qrcode_img_content: 'https://example.invalid/login' }))
        return
      }
      if (url.pathname.endsWith('/get_qrcode_status')) {
        res.end(JSON.stringify({ status: 'confirmed', bot_token: 'test-bot-token', bot_user_id: 'bot' }))
        return
      }
      if (url.pathname.endsWith('/sendmessage')) {
        sent.push({ authorization: req.headers.authorization, body })
        res.end(JSON.stringify({ errcode: 0 }))
        return
      }
      if (url.pathname.endsWith('/getupdates')) {
        res.end(JSON.stringify({ get_updates_buf: 'buf', msgs: [] }))
        return
      }
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    sent,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('mock iLink: QR login yields a token and sendmessage uses it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawbot-integration-'))
  const mock = await startMockIlink()
  const runtime = new ClawbotRuntime(
    parseArgs([
      '--state-dir',
      dir,
      '--base-url',
      mock.base,
      '--qr-ttl-seconds',
      '30',
      '--qr-max-attempts',
      '1',
    ]),
  )
  try {
    await runtime.loadState()
    runtime.updateStatus = async () => {}
    runtime.saveStateNow = async () => {}
    runtime.queueSave = () => {}
    runtime.startPolling = () => {}
    runtime.schedulePendingWatchFlush = () => {}

    await runtime.beginLogin()
    assert.equal(runtime.state.token, 'test-bot-token')
    assert.equal(runtime.state.loginConfirmedAt > 0, true)

    await runtime.sendText('user@example.invalid', 'ctx-test', 'hello tunnel')
    assert.equal(mock.sent.length, 1)
    assert.equal(mock.sent[0].authorization, 'Bearer test-bot-token')
    assert.equal(mock.sent[0].body.msg.to_user_id, 'user@example.invalid')
    assert.equal(mock.sent[0].body.msg.item_list[0].text_item.text, 'hello tunnel')
  } finally {
    await runtime.requestStop('integration test done').catch(() => {})
    await mock.close()
    await rm(dir, { recursive: true, force: true })
  }
})
