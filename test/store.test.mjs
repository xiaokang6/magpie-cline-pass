import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore, normalizePins } from '../lib/store.js'

test('pins from options are used until a tool writes one', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-pass-store-'))
  try {
    const store = createStore({ directory, options: { pins: { 'glm-5.3': { upstreams: ['zai'], pinMode: 'strict' } } } })
    assert.deepEqual(store.pinOf('glm-5.3').upstreams, ['zai'])
    assert.deepEqual(store.pinOf('cline-pass/glm-5.3').upstreams, ['zai'])

    store.setPin('glm-5.3', { upstreams: ['baseten'], pinMode: 'preferred' })
    assert.deepEqual(store.pinOf('glm-5.3').upstreams, ['baseten'])
    store.clearPin('glm-5.3')
    assert.deepEqual(store.pinOf('glm-5.3').upstreams, ['zai'])
    store.dispose()
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('state survives a restart and never contains a key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-pass-store-'))
  try {
    const first = createStore({ directory })
    first.learn('glm-5.3', { upstreams: ['zai', 'baseten'], pipeline: 'planner' })
    first.learnUpstream('glm-5.3', 'zai', 'ok', '', 12)
    first.setPin('glm-5.3', { upstreams: ['zai'], pinMode: 'strict' })
    first.record({ model: 'glm-5.3', upstream: 'zai', actual: 'zai', error: '', ms: 10 })
    await first.flush()

    const raw = fs.readFileSync(path.join(directory, 'cline-pass-state.json'), 'utf8')
    assert.doesNotMatch(raw, /sk_|Bearer|authorization/i)

    const second = createStore({ directory })
    assert.deepEqual(second.metaOf('glm-5.3').upstreams, ['zai', 'baseten'])
    assert.equal(second.verdictOf('glm-5.3', 'zai').status, 'ok')
    assert.deepEqual(second.pinOf('glm-5.3').upstreams, ['zai'])
    assert.equal(second.snapshot().history[0].model, 'glm-5.3')
    first.dispose()
    second.dispose()
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('verdict notes and history mask anything key-shaped', () => {
  const store = createStore({ directory: '' })
  store.learnUpstream('glm-5.3', 'zai', 'bad', 'upstream echoed sk_abcdef123456', 1)
  store.record({ model: 'glm-5.3', error: 'and sk_987654321abc' })
  assert.doesNotMatch(store.verdictOf('glm-5.3', 'zai').note, /sk_[a-z0-9]/i)
  assert.doesNotMatch(store.snapshot().history[0].error, /sk_[a-z0-9]/i)
  store.dispose()
})

test('history is bounded and newest first', () => {
  const store = createStore({ directory: '', historyLimit: 2 })
  store.record({ model: 'a' })
  store.record({ model: 'b' })
  store.record({ model: 'c' })
  assert.deepEqual(store.snapshot().history.map((row) => row.model), ['c', 'b'])
  store.dispose()
})

test('normalizePins drops half-written entries and normalizes keys', () => {
  assert.deepEqual(normalizePins({
    'cline-pass/glm-5.3': { upstreams: ['zai'], has: ['vision', 'implicit-caching'], pinMode: 'strict' },
    broken: 'nope',
    empty: {},
  }), { 'glm-5.3': { upstreams: ['zai'], has: ['vision', 'implicit-caching'], pinMode: 'strict' } })
})
