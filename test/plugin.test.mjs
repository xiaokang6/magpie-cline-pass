import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClinePassPlugin, PROVIDER } from '../index.mjs'

const FEED = {
  clinePass: [
    { id: 'cline-pass/glm-5.3', name: 'GLM-5.3', description: 'Z-AI' },
    { id: 'cline-pass/kimi-k3', name: 'Kimi K3' },
  ],
}

test('the plugin exposes the magpie hooks and a live model list', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-pass-plugin-'))
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('recommended-models')) {
      return new Response(JSON.stringify(FEED), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  try {
    const hooks = await ClinePassPlugin({ directory }, {})
    assert.deepEqual(Object.keys(hooks).sort(), ['auth', 'config', 'provider', 'tool'])

    const cfg = { provider: {} }
    await hooks.config(cfg)
    assert.equal(cfg.provider[PROVIDER].name, 'Cline Pass')
    assert.equal(cfg.provider[PROVIDER].npm, '@ai-sdk/openai-compatible')
    assert.equal(cfg.provider[PROVIDER].api, 'https://api.cline.bot/api/v1')
    assert.ok(Object.keys(cfg.provider[PROVIDER].models).length >= 15)

    const live = await hooks.provider.models({ models: {} }, {})
    assert.deepEqual(Object.keys(live), ['glm-5.3', 'kimi-k3'])
    assert.equal(live['glm-5.3'].id, 'glm-5.3')
    assert.equal(live['glm-5.3'].api.id, 'cline-pass/glm-5.3')
    assert.equal(live['glm-5.3'].limit.context, 1000000)

    assert.equal(hooks.auth.provider, PROVIDER)
    assert.equal(hooks.auth.methods[0].type, 'api')
    assert.equal(typeof hooks.auth.loader, 'function')
    assert.equal(typeof hooks.auth.usage, 'function')

    const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'sk-test' }))
    assert.equal(loader.baseURL, 'https://api.cline.bot/api/v1')
    assert.equal(typeof loader.fetch, 'function')
  } finally {
    globalThis.fetch = realFetch
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('options pins flow into the provider fetch', async () => {
  const realFetch = globalThis.fetch
  const encoder = new TextEncoder()
  const calls = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('recommended-models')) return new Response(JSON.stringify(FEED), { status: 200 })
    calls.push(JSON.parse(init.body))
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const hooks = await ClinePassPlugin({ directory: '' }, {
      pins: { 'glm-5.3': { upstreams: ['zai'], pinMode: 'strict' } },
    })
    const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'sk-test' }))
    const response = await loader.fetch('https://api.cline.bot/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'cline-pass/glm-5.3', stream: true, messages: [] }),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /ok/)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].provider.only, ['z-ai'])
    assert.deepEqual(calls[0].providerOptions.gateway.only, ['zai'])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('tools can be switched off without touching the provider', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('recommended-models')) return new Response(JSON.stringify(FEED), { status: 200 })
    throw new Error(`unexpected fetch: ${url}`)
  }
  try {
    const hooks = await ClinePassPlugin({ directory: '' }, { exposeTools: false })
    assert.equal(hooks.tool, undefined)
    assert.equal(typeof hooks.provider.models, 'function')
  } finally {
    globalThis.fetch = realFetch
  }
})
