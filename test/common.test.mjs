import test from 'node:test'
import assert from 'node:assert/strict'

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { chunkText, firstText, isoLocal, processAlive, readJson, writeJsonAtomic } from '../runtime/common.mjs'

test('chunkText keeps short text intact', () => {
  assert.deepEqual(chunkText('hello', 1800), ['hello'])
  assert.deepEqual(chunkText('   ', 1800), [])
})

test('chunkText splits long text under the limit and prefers newlines', () => {
  const text = `${'a'.repeat(120)}\n${'b'.repeat(120)}`
  const chunks = chunkText(text, 150)
  assert.ok(chunks.length >= 2)
  for (const chunk of chunks) assert.ok(chunk.length <= 150)
  assert.equal(chunks.join('\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''))
})

test('firstText picks the first text item only', () => {
  assert.equal(
    firstText({ item_list: [{ type: 1, text_item: { text: 'hi' } }, { type: 1, text_item: { text: 'bye' } }] }),
    'hi',
  )
  assert.equal(firstText({ item_list: [] }), '')
  assert.equal(firstText(null), '')
})

test('isoLocal formats a local ISO 8601 timestamp with offset', () => {
  assert.match(isoLocal(0), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
})

test('processAlive recognizes this process and rejects impossible pids', () => {
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(0), false)
  assert.equal(processAlive(-1), false)
})

test('writeJsonAtomic leaves no temporary files and round-trips JSON', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawbot-common-'))
  try {
    const file = path.join(dir, 'state.json')
    await writeJsonAtomic(file, { ok: true, value: 42 }, 0o600)
    assert.deepEqual(await readJson(file), { ok: true, value: 42 })
    const names = await readdir(dir)
    assert.deepEqual(names, ['state.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
