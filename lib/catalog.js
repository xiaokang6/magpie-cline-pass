/**
 * Cline Pass model catalog: the bundled snapshot, the live subscription feed,
 * and the translation into the shapes magpie understands.
 *
 * The feed is authoritative about *which* models a subscription can use; the
 * snapshot is authoritative about what each one can do (window, output cap,
 * reasoning levels, input modalities). A model the feed adds after this release
 * is still selectable, described by the safest fallback rather than rejected.
 *
 * @module cline-pass-auth/catalog
 */
import { MODEL_CATALOG, REASONING_EFFORTS } from './catalog-data.js'
import { API_PREFIX, modelKeyOf } from './protocol.js'

/** Fallbacks for a model no source describes. */
export const DEFAULT_CONTEXT_WINDOW = 200000
export const DEFAULT_MAX_TOKENS = 65536

/** Input kinds a magpie model descriptor may name. */
const INPUT_KINDS = ['text', 'image', 'audio', 'video', 'pdf']

/** Words that read better uppercased in a generated label. */
const UPPER = new Set(['glm', 'gpt', 'ai', 'api', 'llm', 'k3', 'mimo', 'pdf'])
const MIXED = { mimo: 'MiMo', glm: 'GLM', gpt: 'GPT', ai: 'AI', pdf: 'PDF', deepseek: 'DeepSeek' }

/**
 * Turn a model id into a human label: `deepseek/deepseek-v4.1-flash` becomes
 * "DeepSeek V4.1 Flash".
 * @param {string} id - an API id or short key.
 * @returns {string} the label.
 */
export function prettify(id) {
  const seg = String(id ?? '').split('/').pop() ?? ''
  return seg
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => MIXED[word.toLowerCase()] ?? (UPPER.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ')
}

/**
 * The published entry for one API id, or undefined when the snapshot lacks it.
 * @param {string} apiId - e.g. `cline-pass/glm-5.3`.
 * @returns {{name: string, contextWindow: number, maxTokens: number, reasoning: boolean, efforts: string[]|null, input: string[]}|undefined}
 */
export function catalogEntry(apiId) {
  return MODEL_CATALOG[apiId] ?? MODEL_CATALOG[`${API_PREFIX}${modelKeyOf(apiId)}`]
}

/** The reasoning levels one model answers to, or the whole vocabulary. */
export function reasonEfforts(ids) {
  const named = Array.isArray(ids) && ids.length > 0
  return named ? ids : REASONING_EFFORTS.map((effort) => effort.id)
}

/** The variant map magpie's picker reads: `{ low: {}, high: {} }`. */
export function variantsOf(ids) {
  return Object.fromEntries(reasonEfforts(ids).map((id) => [id, {}]))
}

/** Build the input capability booleans from a modality list. */
function inputCapabilities(list) {
  const has = new Set((Array.isArray(list) ? list : []).map((kind) => String(kind).toLowerCase()))
  return Object.fromEntries(INPUT_KINDS.map((kind) => [kind, has.has(kind)]))
}

/** The output capability booleans every chat model shares here. */
const OUTPUT_CAPABILITIES = { text: true, image: false, audio: false, video: false, pdf: false }

/**
 * Resolve one model's descriptor, preferring the curated snapshot and filling
 * the gaps from whatever a live catalog said.
 *
 * @param {string} apiId - the gateway's model id.
 * @param {any} [discovered] - an entry from models.dev, if one was read.
 * @returns {{name: string, contextWindow: number, maxTokens: number, reasoning: boolean, efforts: string[]|null, input: string[]}}
 */
export function modelDescriptor(apiId, discovered = undefined) {
  const published = catalogEntry(apiId)
  const live = discovered && typeof discovered === 'object' ? discovered : {}
  const liveLimit = live.limit && typeof live.limit === 'object' ? live.limit : {}
  const liveInput = live.modalities?.input ?? live.input
  const liveName = typeof live.name === 'string' && live.name !== apiId && live.name !== modelKeyOf(apiId) ? live.name : undefined
  const contextWindow = Number(published?.contextWindow ?? liveLimit.context ?? live.contextWindow ?? 0) || DEFAULT_CONTEXT_WINDOW
  const maxTokens = Number(published?.maxTokens ?? liveLimit.output ?? live.maxTokens ?? 0) || DEFAULT_MAX_TOKENS
  const input = published?.input?.length
    ? published.input
    : Array.isArray(liveInput) && liveInput.length > 0
      ? liveInput.map(String)
      : ['text']
  return {
    name: published?.name ?? liveName ?? prettify(apiId),
    contextWindow,
    maxTokens,
    reasoning: published?.reasoning ?? live.reasoning !== false,
    efforts: published?.efforts ?? null,
    input,
  }
}

/**
 * The `config` hook's model entry. Config models use `id` for the API id; the
 * object key is magpie's short model key.
 *
 * @param {string} apiId - the gateway's model id.
 * @param {any} [meta] - a descriptor from {@link modelDescriptor}.
 * @returns {any} a magpie config model.
 */
export function configModel(apiId, meta = modelDescriptor(apiId)) {
  return {
    name: meta.name,
    id: apiId,
    limit: { context: meta.contextWindow, output: meta.maxTokens },
    reasoning: meta.reasoning,
    tool_call: true,
    modalities: { input: meta.input },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    variants: variantsOf(meta.efforts),
  }
}

/**
 * The `provider.models` hook's model entry: a full magpie model.
 *
 * `id` stays the short key (what magpie lists and the agent addresses);
 * `api.id` is what is sent to Cline's gateway.
 *
 * @param {string} apiId - the gateway's model id.
 * @param {string} providerID - the registered provider id.
 * @param {any} [meta] - a descriptor from {@link modelDescriptor}.
 * @returns {any} a magpie model.
 */
export function runtimeModel(apiId, providerID, meta = modelDescriptor(apiId)) {
  const input = inputCapabilities(meta.input)
  return {
    id: modelKeyOf(apiId),
    providerID,
    name: meta.name,
    api: { id: apiId, url: 'https://api.cline.bot/api/v1', npm: '@ai-sdk/openai-compatible' },
    status: 'active',
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: meta.contextWindow, output: meta.maxTokens },
    capabilities: {
      temperature: true,
      reasoning: meta.reasoning,
      attachment: input.image === true,
      toolcall: true,
      input,
      output: OUTPUT_CAPABILITIES,
      interleaved: false,
    },
    release_date: '',
    variants: variantsOf(meta.efforts),
  }
}

/**
 * Read the Cline Pass group out of the public recommended-models answer.
 *
 * The answer has four named groups (`recommended`, `free`, `clinePass`,
 * `clineCloud`). Only ids that already carry the `cline-pass/` prefix belong to
 * this provider; a feed that names none is an empty list, not an error.
 *
 * @param {any} raw - the decoded response body.
 * @returns {{id: string, name: string, description: string}[]} the models, in feed order.
 */
export function parseRecommendedFeed(raw) {
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
    ? raw.data
    : raw
  const lists = []
  if (Array.isArray(payload)) lists.push(payload)
  else if (payload && typeof payload === 'object') {
    for (const group of ['clinePass', 'recommended', 'free']) {
      if (Array.isArray(payload[group])) lists.push(payload[group])
    }
  }
  const by = new Map()
  for (const list of lists) {
    for (const entry of list) {
      const object = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
      const rawId = typeof entry === 'string' ? entry : (object.id ?? object.model ?? object.modelId ?? object.slug)
      const id = typeof rawId === 'string' ? rawId.trim() : ''
      if (!id.startsWith(API_PREFIX)) continue
      const last = id.split('/').pop()
      const given = typeof object.display_name === 'string' ? object.display_name
        : typeof object.displayName === 'string' ? object.displayName
          : typeof object.name === 'string' ? object.name
            : ''
      const name = given && given !== id && given !== last ? given : prettify(id)
      const description = typeof object.description === 'string' ? object.description : ''
      if (!by.has(id)) by.set(id, { id, name, description })
    }
  }
  return [...by.values()]
}
