import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatFetch } from '../lib/request.js'
import { createStore } from '../lib/store.js'

const encoder = new TextEncoder()

/** One SSE response from decoded frames. */
function sse(frames, { failAfter = '' } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      if (failAfter) {
        controller.error(new Error(failAfter))
        return
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** One JSON response. */
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A store with one model and two known channels. */
function setup(pin = { upstreams: ['a', 'b'], pinMode: 'preferred' }) {
  const store = createStore({ directory: '' })
  store.learn('m', { upstreams: ['a', 'b'], channels: { planner: ['a', 'b'], direct: ['a', 'b'] } })
  return { store, pinFor: () => pin }
}

/** A fetch that plays the given responses and records each request. */
function scripted(responses) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected request')
    return typeof next === 'function' ? next(calls.length) : next
  }
  return { calls, fetchImpl }
}

const chatBody = (stream) => ({ model: 'cline-pass/m', messages: [{ role: 'user', content: 'hi' }], stream })

test('non-streaming success unwraps Cline en enclosure and sends the pin', async () => {
  const { store, pinFor } = setup({ upstreams: ['a'], pinMode: 'strict' })
  const { calls, fetchImpl } = scripted([
    json(200, { data: { choices: [{ message: { content: 'hello' } }], provider: 'a' } }),
  ])
  const fetch = createChatFetch({ apiKey: 'k', pinFor, store, fetchImpl })
  const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(false)),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.choices[0].message.content, 'hello')
  assert.equal(body.data, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer k')
  assert.deepEqual(calls[0].body.provider.only, ['a'])
  assert.deepEqual(calls[0].body.providerOptions.gateway.only, ['a'])
  assert.equal(store.snapshot().history[0].actual, 'a')
})

test('non-streaming retries a pin failure on the next channel', async () => {
  const { store, pinFor } = setup()
  const { calls, fetchImpl } = scripted([
    json(400, { error: { message: 'no allowed providers' } }),
    json(200, { choices: [{ message: { content: 'second' } }], provider: 'b' }),
  ])
  const fetch = createChatFetch({ apiKey: 'k', pinFor, store, fetchImpl })
  const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(false)),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'second')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].body.provider.order, ['a', 'b'])
  assert.deepEqual(calls[1].body.provider.order, ['b', 'a'])
  const history = store.snapshot().history[0]
  assert.deepEqual(history.attempts, ['a', 'b'])
  assert.equal(history.actual, 'b')
})

test('a 200 carrying an error envelope is retried like a failure', async () => {
  const { store, pinFor } = setup()
  const { calls, fetchImpl } = scripted([
    json(200, { error: 'empty response content', success: false }),
    json(200, { choices: [{ message: { content: 'after-retry' } }], provider: 'b' }),
  ])
  const fetch = createChatFetch({ apiKey: 'k', pinFor, store, fetchImpl })
  const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(false)),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'after-retry')
  assert.equal(calls.length, 2)
})

test('a 401 is returned with the sign-in mark and is not retried', async () => {
  const { store, pinFor } = setup()
  const { calls, fetchImpl } = scripted([json(401, { error: { message: 'invalid token' } })])
  const fetch = createChatFetch({ apiKey: 'k', pinFor, store, fetchImpl })
  const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(false)),
  })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('X-Magpie-Sign-In'), 'expired')
  assert.equal(calls.length, 1)
})

test('streaming returns a 200 and fails over before the first content frame', async () => {
  const { store, pinFor } = setup()
  const { calls, fetchImpl } = scripted([
    () => sse([{ choices: [{ delta: { role: 'assistant' } }] }]),
    () => sse([{ choices: [{ delta: { content: 'from-b' } }] }]),
  ])
  const fetch = createChatFetch({ apiKey: 'k', pinFor, store, fetchImpl })
  const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(true)),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /from-b/)
  assert.doesNotMatch(text, /role/)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].body.providerOptions.gateway.order, ['a', 'b'])
  assert.deepEqual(calls[1].body.providerOptions.gateway.order, ['b', 'a'])
})

test('streaming commits the first content and does not retry afterwards', async () => {
  const { store, pinFor } = setup({ upstreams: ['a'], pinMode: 'strict' })
  const { calls, fetchImpl } = scripted([
    () => sse([{ choices: [{ delta: { content: 'kept' } }] }], { failAfter: 'network died' }),
  ])
  const fetch = createChatFetch({ apiKey: 'k', pinFor, store, fetchImpl })
  const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(true)),
  })
  await assert.rejects(response.text(), /network died/)
  assert.equal(calls.length, 1)
})

test('streaming gives up when every channel ends before content', async () => {
  const { store, pinFor } = setup({ upstreams: ['a'], pinMode: 'strict' })
  const { calls, fetchImpl } = scripted([
    () => sse([{ choices: [{ delta: { role: 'assistant' } }] }]),
  ])
  const fetch = createChatFetch({ apiKey: 'k', pinFor, store, fetchImpl })
  const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(true)),
  })
  await assert.rejects(response.text(), /content/)
  assert.equal(calls.length, 1)
})

test('streaming reports an upstream 401 before creating the stream', async () => {
  const { store, pinFor } = setup()
  const { calls, fetchImpl } = scripted([json(401, { error: { message: 'invalid token' } })])
  const fetch = createChatFetch({ apiKey: 'k', pinFor, store, fetchImpl })
  const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(true)),
  })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('X-Magpie-Sign-In'), 'expired')
  assert.equal(calls.length, 1)
})

test('a request without a key is refused locally', async () => {
  const { store, pinFor } = setup()
  const fetch = createChatFetch({ apiKey: '', pinFor, store, fetchImpl: async () => {
    throw new Error('should not run')
  } })
  const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(false)),
  })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('X-Magpie-Sign-In'), 'expired')
})
