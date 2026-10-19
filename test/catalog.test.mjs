import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  configModel,
  modelDescriptor,
  parseRecommendedFeed,
  prettify,
  runtimeModel,
  variantsOf,
} from '../lib/catalog.js'

test('parseRecommendedFeed keeps only the cline-pass group, in order and deduped', () => {
  const models = parseRecommendedFeed({
    clinePass: [
      { id: 'cline-pass/glm-5.3', name: 'GLM-5.3', description: 'Z-AI' },
      { id: 'cline-pass/kimi-k3', name: 'cline-pass/kimi-k3' },
      { id: 'cline-pass/glm-5.3', name: 'duplicate' },
    ],
    recommended: [{ id: 'anthropic/claude-sonnet-5.5' }, { id: 'cline-pass/glm-5.3' }],
    free: [{ id: 'cline-free/x' }],
  })
  assert.deepEqual(models.map((model) => model.id), ['cline-pass/glm-5.3', 'cline-pass/kimi-k3'])
  assert.equal(models[0].name, 'GLM-5.3')
  assert.equal(models[1].name, 'Kimi K3')
})

test('parseRecommendedFeed accepts a data envelope and a bare list', () => {
  assert.equal(parseRecommendedFeed({ data: { clinePass: [{ id: 'cline-pass/a' }] } }).length, 1)
  assert.equal(parseRecommendedFeed([{ id: 'cline-pass/a' }]).length, 1)
  assert.equal(parseRecommendedFeed({ clinePass: [] }).length, 0)
})

test('prettify produces readable labels', () => {
  assert.equal(prettify('cline-pass/deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash')
  assert.equal(prettify('cline-pass/glm-5.3'), 'GLM 5.3')
  assert.equal(prettify('cline-pass/mimo-v2.5'), 'MiMo V2.5')
})

test('the bundled descriptor carries the published caps', () => {
  const meta = modelDescriptor('cline-pass/deepseek-v4.1-flash')
  assert.equal(meta.name, 'DeepSeek V4.1 Flash')
  assert.equal(meta.contextWindow, 1000000)
  assert.equal(meta.maxTokens, 384000)
  assert.equal(meta.reasoning, true)
  assert.deepEqual(meta.efforts, ['none', 'low', 'high', 'max'])
  assert.deepEqual(meta.input, ['text', 'image'])
})

test('an unknown model falls back safely', () => {
  const meta = modelDescriptor('cline-pass/not-in-the-snapshot')
  assert.equal(meta.contextWindow, DEFAULT_CONTEXT_WINDOW)
  assert.equal(meta.maxTokens, DEFAULT_MAX_TOKENS)
  assert.equal(meta.reasoning, true)
  assert.equal(meta.efforts, null)
  assert.deepEqual(meta.input, ['text'])
})

test('a live catalog fills gaps for a model the snapshot lacks', () => {
  const meta = modelDescriptor('cline-pass/new-model', {
    name: 'New Model',
    limit: { context: 262144, output: 64000 },
    reasoning: false,
    modalities: { input: ['text', 'image'] },
  })
  assert.equal(meta.name, 'New Model')
  assert.equal(meta.contextWindow, 262144)
  assert.equal(meta.maxTokens, 64000)
  assert.equal(meta.reasoning, false)
  assert.deepEqual(meta.input, ['text', 'image'])
})

test('config models use the API id as id, the short key is the map key', () => {
  const meta = modelDescriptor('cline-pass/glm-5.3')
  const config = configModel('cline-pass/glm-5.3', meta)
  assert.equal(config.id, 'cline-pass/glm-5.3')
  assert.equal(config.name, 'GLM-5.3')
  assert.deepEqual(config.limit, { context: 1000000, output: 131072 })
  assert.deepEqual(config.modalities.input, ['text'])
  assert.equal(config.tool_call, true)
  assert.deepEqual(Object.keys(config.variants), ['low', 'high', 'max'])
})

test('runtime models keep the short id and the full API id', () => {
  const meta = modelDescriptor('cline-pass/kimi-k3')
  const runtime = runtimeModel('cline-pass/kimi-k3', 'cline-pass', meta)
  assert.equal(runtime.id, 'kimi-k3')
  assert.equal(runtime.api.id, 'cline-pass/kimi-k3')
  assert.equal(runtime.api.npm, '@ai-sdk/openai-compatible')
  assert.equal(runtime.limit.context, 1048576)
  assert.equal(runtime.capabilities.reasoning, true)
  assert.equal(runtime.capabilities.input.image, true)
  assert.equal(runtime.capabilities.attachment, true)
  assert.equal(runtime.capabilities.toolcall, true)
  assert.equal(runtime.capabilities.output.text, true)
  assert.deepEqual(Object.keys(runtime.variants), ['low', 'high', 'max'])
})

test('variantsOf keeps the whole vocabulary when no levels are published', () => {
  assert.deepEqual(Object.keys(variantsOf(null)), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
})
