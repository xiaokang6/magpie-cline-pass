/**
 * Cline Pass wire protocol: pipeline detection, pin injection, failover
 * expansion, response read-back and error classification.
 *
 * This is a port of the MIT-licensed logic in dsh-cline-pass. Every function
 * here is pure and synchronous, which is what lets the provider hook, the
 * tools and the tests agree about what a pin means.
 *
 * Cline's gateway fronts two routers and they spell a pin differently:
 * - **direct** (OpenRouter): top-level `provider.only/order/ignore/sort`.
 * - **planner** (Vercel AI Gateway): only `providerOptions.gateway.*`.
 *
 * A request carries both spellings by default. Each router ignores the other's
 * field, and the pipeline a model runs on is chosen by the gateway, so writing
 * only the spelling the last probe saw would silently lose the pin whenever the
 * pipeline changed.
 *
 * @module magpie-cline-pass/protocol
 */

/** Identity of this build, surfaced by the status tool. */
export const BUILD_TAG = 'magpie-0.2.0'

/** The public Cline endpoint that lists subscription models without auth. */
export const RECOMMENDED_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'

/** The subscription's quota windows. */
export const USAGE_LIMITS_PATH = '/users/me/plan/usage-limits'

/** The account's plan, when the gateway publishes one. */
export const PLAN_PATH = '/users/me/plan'

/** The gateway's own model catalog. */
export const GATEWAY_MODELS_PATH = '/models'

/** Cline's whole cloud catalog, where context windows live. */
export const CLOUD_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/models'

/** The API prefix every model id already carries. */
export const API_PREFIX = 'cline-pass/'

/**
 * Strip the gateway prefix so magpie's model key is the part a person reads.
 * `cline-pass/deepseek-v4.1-flash` becomes `deepseek-v4.1-flash`, and an agent
 * addresses it as `cline-pass/deepseek-v4.1-flash`.
 *
 * @param {string} value - an API id, a model key, or a full magpie id.
 * @returns {string} the short key.
 */
export function modelKeyOf(value) {
  const id = String(value ?? '').trim()
  if (id.startsWith(`${API_PREFIX}`)) return id.slice(API_PREFIX.length)
  if (id.startsWith('cline-pass/')) return id.slice('cline-pass/'.length)
  return id
}

/**
 * The API id a model key is sent as.
 *
 * @param {string} value - a short key or an already-prefixed id.
 * @returns {string} the id Cline's gateway expects.
 */
export function apiIdOf(value) {
  const id = String(value ?? '').trim()
  if (id.startsWith(API_PREFIX)) return id
  if (id.startsWith('cline-pass/')) return id
  return `${API_PREFIX}${id}`
}

/**
 * The gateway wraps some answers in a `{ data: … }` envelope; unwrap it.
 * @param {unknown} json - decoded response body.
 * @returns {any} the OpenAI-shaped payload.
 */
export function unwrapEnvelope(json) {
  if (json !== null && typeof json === 'object' && json.data !== null && typeof json.data === 'object' && json.data.choices !== undefined) {
    return json.data
  }
  return json
}

/** Mask anything that looks like a stored API key in text that may be shown. */
export function redactSecrets(value) {
  return String(value ?? '').replace(/\bsk_[A-Za-z0-9._-]{6,}/g, 'sk_…')
}

/** Turn any error-shaped value into display text, with key-shaped text masked. */
export function errorText(value) {
  let text = ''
  if (value === undefined || value === null) text = ''
  else if (typeof value === 'string') text = value
  else if (typeof value === 'object' && typeof value.message === 'string') text = value.message
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  return redactSecrets(text)
}

/** Account authentication refusals, including responses with no useful body. */
export function isAuthenticationError(message, status) {
  const detail = String(message ?? '').replace(/[_-]/g, ' ')
  return status === 401 || status === 403 || /unauthorized|re\s*authenticate|invalid\s*(?:api\s*key|token)|\b401\b|\b403\b/i.test(detail)
}

/**
 * Read the routing facts out of one gateway response or stream frame.
 *
 * Cline's planner reports `provider_metadata.gateway.routing`; the direct
 * pipeline reports a top-level `provider` name. Either may be absent, and a
 * request that names no serving channel is "unresolved" rather than a success.
 *
 * @param {any} json - raw decoded response body or SSE frame.
 * @returns {{content: string|null, toolCalls: any[], usage: any, pipeline: 'planner'|'direct'|null, canonicalSlug: string|null, finalProvider: string|null, finalProviderName: string|null, fallbacks: string[], plan: string}}
 */
export function parseRouting(json) {
  const payload = unwrapEnvelope(json)
  const message = payload?.choices?.[0]?.message ?? payload?.choices?.[0]?.delta
  const routing = message?.provider_metadata?.gateway?.routing
    ?? payload?.provider_metadata?.gateway?.routing
    ?? payload?.routing
    ?? {}
  const direct = typeof payload?.provider === 'string' ? payload.provider : null
  return {
    content: typeof message?.content === 'string' ? message.content : null,
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
    usage: payload?.usage ?? null,
    pipeline: routing.finalProvider ? 'planner' : (direct === null ? null : 'direct'),
    canonicalSlug: routing.canonicalSlug ?? (typeof payload?.model === 'string' && payload.model.includes('/') ? payload.model : null),
    finalProvider: routing.finalProvider ?? (direct === null ? null : slugify(direct)),
    finalProviderName: routing.finalProvider ?? direct,
    fallbacks: Array.isArray(routing.fallbacksAvailable) ? routing.fallbacksAvailable.map(String) : [],
    plan: typeof routing.planningReasoning === 'string' ? routing.planningReasoning : '',
  }
}

/** Lowercase a display name into an upstream slug. */
export function slugify(value) {
  return String(value).toLowerCase().replace(/\s+/g, '-')
}

/** OpenRouter's names for the three sort metrics. */
export const OPENROUTER_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' }

/**
 * Channels the two routers spell differently, as `[planner, direct]` pairs.
 *
 * Z.AI is `zai` to the Vercel gateway and `z-ai` to OpenRouter. Writing one
 * name into both spellings matters: an unknown provider in `provider.only` is
 * refused by OpenRouter rather than ignored, so the wrong spelling of a real
 * channel fails a request the right spelling would have served.
 */
export const CHANNEL_ALIASES = [['zai', 'z-ai']]

/**
 * Translate a channel name into the spelling one pipeline uses.
 * @param {string} name - the configured channel name, in either spelling.
 * @param {'planner'|'direct'} pipeline - the router whose vocabulary is needed.
 * @returns {string} the name that pipeline expects; unknown names pass through.
 */
export function channelNameFor(name, pipeline) {
  const needle = normalizeSlug(name)
  for (const [planner, direct] of CHANNEL_ALIASES) {
    if (normalizeSlug(planner) === needle) return pipeline === 'direct' ? direct : planner
    if (normalizeSlug(direct) === needle) return pipeline === 'planner' ? planner : direct
  }
  return name
}

/**
 * Normalize a configured sort into a wire value or `null`.
 *
 * Both `''` and `none` mean "no sort" and must be dropped before the request is
 * built: neither is a metric, and the gateway rejects them with HTTP 400.
 *
 * @param {unknown} value - the configured sort.
 * @returns {string|null} the sort, or null when none is set.
 */
export function normalizeSort(value) {
  if (typeof value !== 'string') return null
  const sort = value.trim()
  return sort.length === 0 || sort === 'none' ? null : sort
}

/**
 * Normalize a configured pin mode to the one value the router compares against.
 * @param {unknown} value - `strict`, `preferred`, or anything else.
 * @returns {'strict'|'preferred'} the mode that will actually run.
 */
export function normalizePinMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'preferred' ? 'preferred' : 'strict'
}

/**
 * The channel vocabulary one spelling should be resolved against.
 *
 * The two pipelines publish different lists, so the merged list is the wrong
 * basis for an allow-list: it can miss the channel that actually serves the
 * request, which is how an exclusion leaks.
 *
 * @param {any} meta - discovered model metadata.
 * @param {'planner'|'direct'} pipeline - which pipeline's list to prefer.
 * @returns {string[]} that pipeline's channel names, falling back to the merged list.
 */
function knownChannels(meta, pipeline) {
  const scoped = meta?.channels?.[pipeline]
  if (Array.isArray(scoped) && scoped.length > 0) return scoped
  return Array.isArray(meta?.upstreams) ? meta.upstreams : []
}

/**
 * Write one attempt's upstream preference into a request body.
 *
 * Excludes are compiled into an `only` allow-list because the gateway ignores
 * the exclude/ignore fields. Both spellings are written unless the caller asks
 * for `spelling: 'detected'`.
 *
 * @param {any} body - the decoded chat-completions request.
 * @param {any} meta - discovered model metadata.
 * @param {any} attempt - one candidate from {@link buildAttempts}.
 * @returns {any} a new body with the pin applied.
 */
export function injectPrefs(body, meta, attempt) {
  const next = { ...body }
  const { upstream = null, orderRest = [], excludeList = [], strict = true } = attempt ?? {}
  const sort = normalizeSort(attempt?.sort)
  const has = Array.isArray(attempt?.has) ? attempt.has.filter((name) => typeof name === 'string' && name.length > 0) : []
  const excluded = excludeList.filter((name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ''))
  const excludedIds = new Set(excluded.map(normalizeSlug))
  const spell = (names, pipeline) => names.map((name) => channelNameFor(name, pipeline))
  const gatewayAllow = excluded.length > 0 ? knownChannels(meta, 'planner').filter((name) => !excludedIds.has(normalizeSlug(name))) : null
  const openRouterAllow = excluded.length > 0 ? knownChannels(meta, 'direct').filter((name) => !excludedIds.has(normalizeSlug(name))) : null
  const pipeline = meta?.pipeline ?? null
  const both = attempt?.spelling !== 'detected'
  const useGateway = both || pipeline === 'planner' || pipeline === null
  const useOpenRouter = both || pipeline === 'direct' || pipeline === null
  const gatewayUsable = useGateway && (upstream !== null || sort !== null || has.length > 0 || (gatewayAllow !== null && gatewayAllow.length > 0))
  // `ignore` is OpenRouter's own exclusion field: written alongside the
  // allow-list so an exclusion still bites when no channel list exists yet.
  const openRouterUsable = useOpenRouter && (upstream !== null || sort !== null || excluded.length > 0 || (openRouterAllow !== null && openRouterAllow.length > 0))
  if (!gatewayUsable && !openRouterUsable) return next
  if (gatewayUsable) {
    const gateway = {}
    if (upstream !== null) {
      if (strict) gateway.only = spell([upstream], 'planner')
      else {
        gateway.order = spell([upstream, ...orderRest], 'planner')
        if (gatewayAllow !== null && gatewayAllow.length > 0) gateway.only = spell(gatewayAllow, 'planner')
      }
    } else if (gatewayAllow !== null && gatewayAllow.length > 0) {
      gateway.only = spell(gatewayAllow, 'planner')
    }
    // `has` is the capability filter that makes the planner honor `only`. A
    // private fallback can otherwise serve a request even when `only` names an
    // impossible channel; the capability filter excludes that landing spot and
    // the request reaches the router that enforces `only`.
    if (has.length > 0) gateway.has = [...has]
    if (sort !== null) gateway.sort = sort
    next.providerOptions = { ...(next.providerOptions ?? {}), gateway: { ...(next.providerOptions?.gateway ?? {}), ...gateway } }
  }
  if (openRouterUsable) {
    const provider = { ...(next.provider ?? {}) }
    if (upstream !== null) {
      if (strict) provider.only = spell([upstream], 'direct')
      else {
        provider.order = spell([upstream, ...orderRest], 'direct')
        if (openRouterAllow !== null && openRouterAllow.length > 0) provider.only = spell(openRouterAllow, 'direct')
      }
    } else if (openRouterAllow !== null && openRouterAllow.length > 0) {
      provider.only = spell(openRouterAllow, 'direct')
    }
    if (sort !== null) provider.sort = OPENROUTER_SORT[sort] ?? sort
    if (excluded.length > 0) provider.ignore = spell(excluded, 'direct')
    next.provider = provider
  }
  return next
}

/**
 * Read back whether the router honored one attempt's pin.
 *
 * A 200 is not evidence: an unknown or unavailable `only` value is dropped by
 * the router, which then serves the request from any channel it likes. The only
 * honest test is the channel the response reports.
 *
 * @param {any} attempt - the attempt that was sent.
 * @param {any} routing - the routing facts read out of the response.
 * @returns {'adopted'|'fallback'|'not-adopted'|'violated'|'unresolved'}
 */
export function pinAdherence(attempt, routing) {
  const expected = attempt?.upstream ?? null
  const excluded = (attempt?.excludeList ?? [])
    .filter((name) => normalizeSlug(name) !== normalizeSlug(expected ?? ''))
    .map(normalizeSlug)
  const raw = routing?.finalProvider ?? null
  const actual = raw === null || raw === undefined || String(raw).length === 0 ? null : normalizeSlug(raw)
  // An excluded channel serving the request is a breach in every mode, and it
  // is the one failure nothing else can reveal: the response is a clean 200.
  if (actual !== null && excluded.includes(actual)) return 'violated'
  if (expected === null || expected === undefined || String(expected).length === 0) return 'unresolved'
  if (actual === null) return 'unresolved'
  if (actual === normalizeSlug(expected)) return 'adopted'
  if ((attempt?.orderRest ?? []).map(normalizeSlug).includes(actual)) return 'fallback'
  return 'not-adopted'
}

/** Whether an adherence reading means the pin was honored, or cannot be judged. */
export function isAdherenceOk(adherence) {
  return adherence === 'adopted' || adherence === 'fallback' || adherence === 'unresolved'
}

/**
 * Name the configuration problems that make a pin impossible to honor.
 * @param {any} attempt - the attempt about to be sent.
 * @param {any} meta - discovered model metadata.
 * @returns {string[]} human-readable warnings, empty when the pin is expressible.
 */
export function pinWarnings(attempt, meta) {
  const upstream = attempt?.upstream ?? null
  const excluded = (attempt?.excludeList ?? []).filter((name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ''))
  const has = Array.isArray(attempt?.has) ? attempt.has.filter((name) => typeof name === 'string' && name.length > 0) : []
  const warnings = []
  // `only` alone is not enough on Cline's gateway: a private fallback can serve
  // the request and silently ignore it. The capability filter is what moves the
  // request onto the router that enforces `only`.
  if (has.length === 0 && (upstream !== null || excluded.length > 0)) {
    warnings.push('pin-without-has: Cline may ignore `only` and serve this from a private fallback; add a capability filter such as has=vision,implicit-caching')
  }
  const excludedIds = new Set(excluded.map(normalizeSlug))
  if (excluded.length === 0) return warnings
  const known = Array.isArray(meta?.upstreams) ? meta.upstreams : []
  if (known.length === 0) {
    warnings.push(`excludeUnresolved: this model has no channel list yet, so ${excluded.join(', ')} could not be compiled into an allow-list — run the probe tool for it`)
    return warnings
  }
  const remaining = known.filter((name) => !excludedIds.has(normalizeSlug(name)))
  if (remaining.length === 0 && upstream === null) {
    warnings.push(`PIN_UNRESOLVED: every known channel is excluded (${known.join(', ')}), so the request falls back to the gateway's own routing`)
  }
  return warnings
}

/**
 * Expand one model's pin configuration into the ordered failover candidates.
 *
 * A model with a non-empty (post-exclusion) pin list is tried upstream by
 * upstream; a model without one is a single automatic candidate whose excludes
 * become an allow-list.
 *
 * @param {{upstreams?: string[], exclude?: string[], pinMode?: string, sort?: string, spelling?: string, has?: string[]}} config
 * @returns {any[]} the candidate attempts, in try order.
 */
export function buildAttempts(config) {
  const listed = (config?.upstreams ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  const exclude = (config?.exclude ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  const has = (config?.has ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  const excluded = new Set(exclude.map(normalizeSlug))
  const wanted = listed.filter((name) => !excluded.has(normalizeSlug(name)))
  const strict = normalizePinMode(config?.pinMode) === 'strict'
  const sort = normalizeSort(config?.sort)
  const base = { strict, sort, excludeList: exclude, ...(has.length > 0 ? { has } : {}) }
  if (typeof config?.spelling === 'string' && config.spelling.length > 0) base.spelling = config.spelling
  if (wanted.length > 0) {
    return wanted.map((upstream, index) => ({
      ...base,
      upstream,
      orderRest: strict ? [] : wanted.filter((_, other) => other !== index),
    }))
  }
  return [{ ...base, upstream: null, orderRest: [] }]
}

/**
 * Classify a pinned-request failure into one upstream availability verdict.
 * @param {string} message - the gateway's error text.
 * @returns {'ok'|'limited'|'bad'|'auth'|'unknown'}
 */
export function classifyUpstreamError(message) {
  const text = String(message ?? '')
  if (/empty response content/i.test(text)) return 'ok'
  if (/429|rate-?limited|temporarily rate/i.test(text)) return 'limited'
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported|invalid provider/i.test(text)) return 'bad'
  if (isAuthenticationError(text)) return 'auth'
  return 'unknown'
}

/**
 * Recover the gateway's own upstream list from a routing-layer error.
 *
 * The probe pins a channel that cannot exist, so the router fails before
 * spending a token and names every provider it could have used.
 *
 * @param {string} message - the error text.
 * @param {'planner'|'direct'} pipeline - which spelling was sent.
 * @returns {string[]|null} upstream slugs, or null when the error carried none.
 */
export function extractAvailableProviders(message, pipeline) {
  const text = String(message ?? '')
  if (pipeline === 'planner') {
    const match = /Available providers are:\s*([^.]+)/.exec(text)
    if (match === null) return null
    const tokens = match[1].split(/,\s*/).map((token) => token.trim()).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    return tokens.length > 0 ? tokens : null
  }
  if (pipeline === 'direct') {
    const start = text.indexOf('{')
    if (start < 0) return null
    try {
      const parsed = JSON.parse(text.slice(start))
      const list = parsed?.error?.metadata?.available_providers
      return Array.isArray(list) && list.length > 0 ? list.map(String) : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Read the tier-0 channel hint out of a planner's reasoning sentence.
 * @param {string} plan - `provider_metadata.gateway.routing.planningReasoning`.
 * @returns {string[]} the upstreams the planner considered tier 0.
 */
export function parseTier0(plan) {
  const match = /([\w-]+) won tier 0 over ([^."]+)/.exec(String(plan ?? ''))
  if (match === null) return []
  return [...new Set([match[1], ...match[2].split(/,\s*|\s+and\s+/).map((part) => part.trim()).filter(Boolean)])]
}

/**
 * How many channels one model's list may hold.
 *
 * It has to clear the largest pool the routers publish. A cap of 25 silently
 * truncated reality: `glm-5.3-flash` reported exactly 25 channels, which is the
 * cap, not the pool.
 */
export const MAX_UPSTREAMS = 64

/**
 * Merge upstream channels discovered by several means, keeping order and
 * dropping duplicates.
 * @param {...string[][]} lists - candidate lists, highest confidence first.
 * @returns {string[]} the merged, de-duplicated upstream slugs.
 */
export function mergeUpstreams(...lists) {
  const seen = []
  for (const list of lists) {
    for (const name of list ?? []) {
      const value = String(name)
      if (value.length > 0 && !seen.includes(value)) seen.push(value)
    }
  }
  return seen.slice(0, MAX_UPSTREAMS)
}

/**
 * Normalize a model id for fuzzy catalog matching (the gateway's canonical slug
 * and OpenRouter's id disagree on hyphens: `zai/…` vs `z-ai/…`).
 * @param {unknown} value - either id.
 * @returns {string} the comparable form.
 */
export function normalizeSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}
