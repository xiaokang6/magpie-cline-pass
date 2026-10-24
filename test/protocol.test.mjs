import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apiIdOf,
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  extractAvailableProviders,
  injectPrefs,
  mergeUpstreams,
  modelKeyOf,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
  redactSecrets,
} from '../lib/protocol.js'

test('model keys and API ids round-trip', () => {
  assert.equal(modelKeyOf('cline-pass/glm-5.3'), 'glm-5.3')
  assert.equal(modelKeyOf('glm-5.3'), 'glm-5.3')
  assert.equal(apiIdOf('glm-5.3'), 'cline-pass/glm-5.3')
  assert.equal(apiIdOf('cline-pass/glm-5.3'), 'cline-pass/glm-5.3')
})

test('strict pin writes both spellings and the capability filter', () => {
  const meta = { channels: { planner: ['baseten', 'deepseek'], direct: ['baseten', 'deepseek'] } }
  const body = injectPrefs({ model: 'x' }, meta, {
    upstream: 'baseten',
    strict: true,
    sort: null,
    orderRest: [],
    excludeList: [],
    has: ['vision', 'implicit-caching'],
  })
  assert.deepEqual(body.providerOptions.gateway.only, ['baseten'])
  assert.deepEqual(body.providerOptions.gateway.has, ['vision', 'implicit-caching'])
  assert.deepEqual(body.provider.only, ['baseten'])
  assert.equal(body.provider.has, undefined)
})

test('a pin without has writes no gateway.has', () => {
  const meta = { channels: { planner: ['baseten'], direct: ['baseten'] } }
  const body = injectPrefs({ model: 'x' }, meta, { upstream: 'baseten', strict: true, sort: null, orderRest: [], excludeList: [] })
  assert.equal(body.providerOptions.gateway.has, undefined)
})

test('an existing gateway.has survives when the attempt names none', () => {
  const meta = { channels: { planner: ['baseten'], direct: ['baseten'] } }
  const original = { model: 'x', providerOptions: { gateway: { has: ['vision'] } } }
  const body = injectPrefs(original, meta, { upstream: 'baseten', strict: true, sort: null, orderRest: [], excludeList: [] })
  assert.deepEqual(body.providerOptions.gateway.has, ['vision'])
})

test('preferred pin writes order, and aliases Z.AI per pipeline', () => {
  const meta = { channels: { planner: ['zai', 'deepseek'], direct: ['z-ai', 'deepseek'] } }
  const body = injectPrefs({ model: 'x' }, meta, {
    upstream: 'zai',
    strict: false,
    orderRest: ['deepseek'],
    excludeList: [],
    sort: 'cost',
  })
  assert.deepEqual(body.providerOptions.gateway.order, ['zai', 'deepseek'])
  assert.equal(body.providerOptions.gateway.sort, 'cost')
  assert.deepEqual(body.provider.order, ['z-ai', 'deepseek'])
  assert.equal(body.provider.sort, 'price')
  assert.equal(channelNameFor('zai', 'direct'), 'z-ai')
  assert.equal(channelNameFor('z-ai', 'planner'), 'zai')
})

test('exclusions compile into allow-lists and OpenRouter ignore', () => {
  const meta = { channels: { planner: ['baseten', 'deepseek'], direct: ['baseten', 'deepseek'] } }
  const body = injectPrefs({ model: 'x' }, meta, { upstream: null, strict: true, sort: null, orderRest: [], excludeList: ['baseten'] })
  assert.deepEqual(body.providerOptions.gateway.only, ['deepseek'])
  assert.deepEqual(body.provider.only, ['deepseek'])
  assert.deepEqual(body.provider.ignore, ['baseten'])
})

test('no pin leaves the body untouched', () => {
  const original = { model: 'x', provider: { order: ['mine'] } }
  const body = injectPrefs(original, {}, { upstream: null, strict: true, sort: null, orderRest: [], excludeList: [] })
  assert.deepEqual(body, original)
})

test('buildAttempts expands preferred pins and drops excluded candidates', () => {
  const withHas = buildAttempts({ upstreams: ['a'], pinMode: 'strict', has: ['vision', 'implicit-caching'] })
  assert.deepEqual(withHas[0].has, ['vision', 'implicit-caching'])

  const strict = buildAttempts({ upstreams: ['a', 'b'], pinMode: 'strict' })
  assert.equal(strict.length, 2)
  assert.deepEqual(strict[0].orderRest, [])

  const preferred = buildAttempts({ upstreams: ['a', 'b'], pinMode: 'preferred' })
  assert.deepEqual(preferred[0].orderRest, ['b'])
  assert.deepEqual(preferred[1].orderRest, ['a'])

  const excluded = buildAttempts({ upstreams: ['a', 'b'], exclude: ['b'], pinMode: 'preferred' })
  assert.equal(excluded.length, 1)
  assert.equal(excluded[0].upstream, 'a')

  const auto = buildAttempts({ exclude: ['a'] })
  assert.equal(auto.length, 1)
  assert.equal(auto[0].upstream, null)
  assert.deepEqual(auto[0].excludeList, ['a'])
})

test('pin adherence distinguishes adopted, fallback, violation and unresolved', () => {
  const attempt = { upstream: 'baseten', orderRest: ['deepseek'], excludeList: ['fireworks'] }
  assert.equal(pinAdherence(attempt, { finalProvider: 'baseten' }), 'adopted')
  assert.equal(pinAdherence(attempt, { finalProvider: 'deepseek' }), 'fallback')
  assert.equal(pinAdherence(attempt, { finalProvider: 'fireworks' }), 'violated')
  assert.equal(pinAdherence(attempt, { finalProvider: 'other' }), 'not-adopted')
  assert.equal(pinAdherence(attempt, { finalProvider: null }), 'unresolved')
  assert.equal(pinAdherence({ upstream: null }, { finalProvider: 'x' }), 'unresolved')
})

test('pin warnings explain an exclusion that cannot be expressed', () => {
  assert.match(pinWarnings({ upstream: null, excludeList: ['a'], has: ['vision'] }, { upstreams: [] })[0], /excludeUnresolved/)
  assert.match(pinWarnings({ upstream: null, excludeList: ['a'], has: ['vision'] }, { upstreams: ['a'] })[0], /PIN_UNRESOLVED/)
  assert.match(pinWarnings({ upstream: 'a', excludeList: ['b'] }, { upstreams: ['a', 'b'] })[0], /pin-without-has/)
  assert.deepEqual(pinWarnings({ upstream: 'a', excludeList: ['b'], has: ['vision'] }, { upstreams: ['a', 'b'] }), [])
})

test('parseRouting reads the planner and the direct pipelines', () => {
  const planner = parseRouting({
    model: 'zai/glm-5.3',
    choices: [{ message: { content: 'ok', provider_metadata: { gateway: { routing: {
      finalProvider: 'zai', canonicalSlug: 'zai/glm-5.3', fallbacksAvailable: ['baseten'],
      planningReasoning: 'zai won tier 0 over baseten and deepseek',
    } } } } }],
  })
  assert.equal(planner.pipeline, 'planner')
  assert.equal(planner.finalProvider, 'zai')
  assert.deepEqual(planner.fallbacks, ['baseten'])

  const direct = parseRouting({ provider: 'Baseten', choices: [{ message: { content: 'ok' } }] })
  assert.equal(direct.pipeline, 'direct')
  assert.equal(direct.finalProvider, 'baseten')
  assert.deepEqual(parseTier0(planner.plan), ['zai', 'baseten', 'deepseek'])
})

test('extractAvailableProviders reads each pipeline error shape', () => {
  assert.deepEqual(
    extractAvailableProviders('No allowed providers. Available providers are: zai, baseten, deepseek.', 'planner'),
    ['zai', 'baseten', 'deepseek'],
  )
  const direct = 'upstream error: {"error":{"metadata":{"available_providers":["Together AI","baseten"]}}}'
  assert.deepEqual(extractAvailableProviders(direct, 'direct'), ['Together AI', 'baseten'])
  assert.equal(extractAvailableProviders('nothing here', 'planner'), null)
})

test('classifyUpstreamError names the actionable failures', () => {
  assert.equal(classifyUpstreamError('429 rate limited'), 'limited')
  assert.equal(classifyUpstreamError('no allowed providers'), 'bad')
  assert.equal(classifyUpstreamError('invalid API key'), 'auth')
  assert.equal(classifyUpstreamError('empty response content'), 'ok')
  assert.equal(classifyUpstreamError('boom'), 'unknown')
})

test('key-shaped text is masked in errors and stored notes', () => {
  assert.equal(redactSecrets('refused sk_abc123456789 now'), 'refused sk_… now')
  assert.match(redactSecrets('no key here'), /^no key here$/)
})

test('mergeUpstreams dedupes, keeps order and caps the list', () => {
  assert.deepEqual(mergeUpstreams(['a', 'b'], ['b', 'c'], []), ['a', 'b', 'c'])
  const many = Array.from({ length: 80 }, (_, index) => `c${index}`)
  assert.equal(mergeUpstreams(many).length, 64)
})
