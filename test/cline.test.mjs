import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyFailure,
  clineHeaders,
  errorResponse,
  fetchRecommendedModels,
  fetchUsageLimits,
  usageWindows,
  userOf,
} from '../lib/cline.js'

test('usageWindows maps the three official windows and keeps their spans', () => {
  const reading = usageWindows({
    data: {
      limits: [
        { type: 'weekly', percentUsed: 12.5, resetsAt: '2026-10-22T00:00:00Z' },
        { type: 'five_hour', percentUsed: 42, resetsAt: '2026-10-19T20:00:00Z' },
        { type: 'monthly', percentUsed: 7, resetsAt: '2026-11-01T00:00:00Z' },
      ],
    },
  })
  assert.equal(reading.plan, 'Cline Pass')
  assert.deepEqual(reading.windows.map((window) => window.name), ['5 hours', 'Weekly', 'Monthly'])
  assert.equal(reading.windows[0].used, 42)
  assert.equal(reading.windows[0].span, 5 * 3600)
  assert.equal(reading.windows[1].span, 7 * 24 * 3600)
  assert.equal(reading.windows[2].resetsAt, '2026-11-01T00:00:00Z')
})

test('usageWindows passes unknown window types through and keeps over-100 readings', () => {
  const reading = usageWindows({
    limits: [
      { type: 'daily', percentUsed: 130, resetsAt: '2026-10-20T00:00:00Z' },
      { type: 'five_hour', percentUsed: 101 },
    ],
  })
  assert.deepEqual(reading.windows.map((window) => [window.name, window.used]), [['5 hours', 101], ['daily', 130]])
})

test('usageWindows tolerates an empty or malformed answer', () => {
  assert.deepEqual(usageWindows(null).windows, [])
  assert.deepEqual(usageWindows({ limits: 'nope' }).windows, [])
})

test('classifyFailure separates account lapses, plans, quota and channels', () => {
  const lapsed = classifyFailure(401, 'invalid token')
  assert.equal(lapsed.retry, false)
  assert.equal(lapsed.signIn, 'expired')
  assert.equal(lapsed.status, 401)

  const unauthorised = classifyFailure(403, 'Unauthorized')
  assert.equal(unauthorised.retry, false)
  assert.equal(unauthorised.signIn, 'expired')

  const plan = classifyFailure(403, 'the user is not subscribed to required model plan')
  assert.equal(plan.retry, false)
  assert.equal(plan.signIn, 'kept')

  const quota = classifyFailure(429, 'usage limit reached')
  assert.equal(quota.retry, false)
  assert.equal(quota.status, 429)

  const busy = classifyFailure(429, 'temporarily rate limited')
  assert.equal(busy.retry, true)

  assert.equal(classifyFailure(400, 'invalid provider').retry, true)
  assert.equal(classifyFailure(503, 'upstream is down').retry, true)
  assert.equal(classifyFailure(404, 'model not found').retry, true)
})

test('errorResponse carries the sign-in mark magpie reads', async () => {
  const response = errorResponse(401, 'sign in again', 'expired')
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('X-Magpie-Sign-In'), 'expired')
  const body = await response.json()
  assert.equal(body.error.message, 'sign in again')
})

test('clineHeaders names the client without leaking a key into a referer', () => {
  const headers = clineHeaders('sk-secret')
  assert.equal(headers.Authorization, 'Bearer sk-secret')
  assert.equal(headers['X-Title'], 'magpie')
  assert.doesNotMatch(JSON.stringify(headers), /sk-secret.*sk-secret/)
})

test('fetchUsageLimits reports 401, 404 and success as data', async () => {
  const lapsed = await fetchUsageLimits({
    apiKey: 'k',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'no' }), { status: 401 }),
  })
  assert.equal(lapsed.ok, false)
  assert.equal(lapsed.status, 401)

  const noPlan = await fetchUsageLimits({
    apiKey: 'k',
    fetchImpl: async () => new Response('{}', { status: 404 }),
  })
  assert.equal(noPlan.ok, false)
  assert.match(noPlan.error, /no Cline Pass subscription/)

  const ok = await fetchUsageLimits({
    apiKey: 'k',
    fetchImpl: async () => new Response(JSON.stringify({ data: { limits: [{ type: 'weekly', percentUsed: 20 }] } }), { status: 200 }),
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.windows[0].name, 'Weekly')
  assert.equal(ok.windows[0].used, 20)
})

test('fetchRecommendedModels parses the feed and reports failures', async () => {
  const ok = await fetchRecommendedModels({
    fetchImpl: async () => new Response(JSON.stringify({ clinePass: [{ id: 'cline-pass/glm-5.3' }] }), { status: 200 }),
  })
  assert.equal(ok.error, '')
  assert.equal(ok.models.length, 1)
  assert.equal(ok.models[0].id, 'cline-pass/glm-5.3')

  const bad = await fetchRecommendedModels({
    fetchImpl: async () => new Response('no', { status: 500 }),
  })
  assert.match(bad.error, /HTTP 500/)
})

test('userOf finds a label in the saved login', () => {
  assert.equal(userOf({ accountId: 'ada@example.com' }), 'ada@example.com')
  assert.equal(userOf({ metadata: { email: 'grace@example.com' } }), 'grace@example.com')
  assert.equal(userOf({}), '')
})
