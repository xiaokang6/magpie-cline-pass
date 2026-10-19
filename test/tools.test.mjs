import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.js'
import { createTools } from '../lib/tools.js'

function setup() {
  const store = createStore({ directory: '' })
  store.learn('glm-5.3', { upstreams: ['zai', 'baseten'], channels: { planner: ['zai', 'baseten'] } })
  store.learnUpstream('glm-5.3', 'zai', 'ok', '', 12)
  store.record({ model: 'glm-5.3', upstream: 'zai', actual: 'zai', ms: 100, error: '' })
  const calls = []
  const engine = {
    probe: async (model, options) => { calls.push(['probe', model, options]); return { ok: true, model } },
    validate: async (model, options) => { calls.push(['validate', model, options]); return { ok: true, model } },
    test: async (model, upstream, options) => { calls.push(['test', model, upstream, options]); return { ok: true, model } },
  }
  const tools = createTools({
    store,
    engine,
    listModels: () => ['cline-pass/glm-5.3', 'cline-pass/kimi-k3'],
    build: 'test-build',
    provider: 'cline-pass',
    displayName: 'Cline Pass',
  }).tool
  return { store, tools, calls }
}

test('status and models expose the route without secrets', async () => {
  const { store, tools } = setup()
  try {
    const status = await tools.status.execute({}, {})
    assert.equal(status.provider, 'cline-pass')
    assert.equal(status.build, 'test-build')
    assert.equal(status.models, 2)
    assert.deepEqual(status.channels['glm-5.3'].upstreams, ['zai', 'baseten'])

    const models = await tools.models.execute({ filter: 'glm' }, {})
    assert.equal(models.count, 1)
    assert.equal(models.models[0].model, 'glm-5.3')
    assert.deepEqual(models.models[0].upstreams, ['zai', 'baseten'])
    assert.equal(models.models[0].verdicts.zai.status, 'ok')
    assert.equal(JSON.stringify(status).includes('sk_'), false)
  } finally {
    store.dispose()
  }
})

test('pin writes and clears a tool-level pin', async () => {
  const { store, tools } = setup()
  try {
    const saved = await tools.pin.execute({ model: 'cline-pass/glm-5.3', upstreams: ['baseten'], pinMode: 'preferred' }, {})
    assert.equal(saved.model, 'glm-5.3')
    assert.deepEqual(saved.pin.upstreams, ['baseten'])
    assert.equal(saved.pin.pinMode, 'preferred')

    const row = (await tools.models.execute({ filter: 'glm' }, {})).models[0]
    assert.deepEqual(row.pinned.upstreams, ['baseten'])

    const cleared = await tools.pin.execute({ model: 'glm-5.3', clear: true }, {})
    assert.deepEqual(cleared.pin, {})
  } finally {
    store.dispose()
  }
})

test('probe, validate and test pass the abort signal through', async () => {
  const { store, tools, calls } = setup()
  const abort = new AbortController()
  try {
    await tools.probe.execute({ model: 'glm-5.3' }, { abort: abort.signal })
    await tools.validate.execute({ model: 'glm-5.3' }, { abort: abort.signal })
    await tools.test.execute({ model: 'glm-5.3', upstream: 'zai' }, { abort: abort.signal })
    assert.equal(calls.length, 3)
    assert.equal(calls[0][0], 'probe')
    assert.equal(calls[0][2].signal, abort.signal)
    assert.equal(calls[2][1], 'glm-5.3')
    assert.equal(calls[2][2], 'zai')
  } finally {
    store.dispose()
  }
})

test('history is bounded by the tool argument', async () => {
  const { store, tools } = setup()
  try {
    for (let index = 0; index < 5; index += 1) store.record({ model: `m${index}` })
    const history = await tools.history.execute({ limit: 2 }, {})
    assert.equal(history.rows.length, 2)
    assert.equal(history.rows[0].model, 'm4')
  } finally {
    store.dispose()
  }
})
