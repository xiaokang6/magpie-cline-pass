/**
 * Probe, validate and test Cline Pass upstream routing.
 *
 * These are the operations dsh-cline-pass exposes as `cline_pass_*` tools:
 *
 * - **probe** learns which channels can serve a model. It asks normally once
 *   (so the answer names the channel that actually served it), then pins a
 *   channel that cannot exist for each pipeline; the router refuses before
 *   spending a token and names the providers it could have used.
 * - **validate** sends one tiny request per known channel and reads back the
 *   channel the answer names. A 200 alone is not evidence that a pin was
 *   honored: an unknown `only` value is dropped silently by the router.
 * - **test** checks the pin configuration that is about to be used.
 *
 * @module opencode-cline-pass-auth/engine
 */
import {
  chatCompletion,
  fetchRecommendedModels,
  fetchUsageLimits,
  usageWindows,
} from './cline.js'
import {
  buildAttempts,
  modelKeyOf,
  channelNameFor,
  classifyUpstreamError,
  errorText,
  extractAvailableProviders,
  injectPrefs,
  mergeUpstreams,
  parseRouting,
  parseTier0,
  pinAdherence,
  unwrapEnvelope,
  apiIdOf,
} from './protocol.js'

/** How many channels one validation runs at once. */
export const VALIDATE_CONCURRENCY = 5

/**
 * The tiny body every probe and validation sends.
 *
 * The budget is not 16: Cline's reasoning models can spend a small budget
 * thinking and then answer with an empty body, which the gateway reports as
 * HTTP 500 `empty response content`. That is a property of the ask, not of the
 * channel, so a diagnostic that wants a channel verdict asks for a real answer.
 */
function tinyBody(apiId, { probe = false } = {}) {
  return {
    model: apiId,
    messages: [{ role: 'user', content: 'Reply with the word OK' }],
    max_tokens: probe ? 256 : 64,
    stream: false,
  }
}

/** The failure message a gateway answer carries, or an empty string. */
function payloadError(payload, result) {
  if (payload?.error !== undefined && payload?.choices === undefined) {
    return errorText(payload.error) || String(payload?.message ?? '') || result.text.slice(0, 400)
  }
  if (!result.ok) return errorText(payload?.error) || String(payload?.message ?? '') || result.text.slice(0, 400) || `HTTP ${result.status}`
  return ''
}

/**
 * Build the probe/validate/test engine for one plugin instance.
 *
 * @param {{getKey: () => string, baseURL?: string, store: any, pinFor: (model: string) => any, fetchImpl?: typeof fetch, probeTimeoutMs?: number}} options
 */
export function createEngine({
  getKey,
  baseURL = 'https://api.cline.bot/api/v1',
  store,
  pinFor,
  fetchImpl = fetch,
  probeTimeoutMs = 60000,
} = {}) {
  const key = () => {
    const value = String(getKey() ?? '')
    if (value.length === 0) throw new Error('Cline Pass: no account has signed in yet; run `magpie plugin login cline-pass` first')
    return value
  }

  /**
   * Ask the router for the channels it could use for one pipeline by pinning a
   * channel that cannot exist. It fails before spending a token and names them.
   */
  async function harvest(apiId, pipeline, signal) {
    const body = pipeline === 'planner'
      ? { ...tinyBody(apiId), providerOptions: { gateway: { only: ['__probe__'] } } }
      : { ...tinyBody(apiId), provider: { only: ['__probe__'] } }
    try {
      const result = await chatCompletion({ baseURL, apiKey: key(), body, timeoutMs: probeTimeoutMs, fetchImpl, signal })
      const payload = unwrapEnvelope(result.json)
      const message = errorText(payload?.error) || result.text
      return extractAvailableProviders(message, pipeline)
    } catch {
      return null
    }
  }

  /**
   * Probe one model: what pipeline serves it, which channels exist for each
   * pipeline, and which channel served the probe.
   *
   * @param {string} model - short key or API id.
   * @returns {Promise<any>} a summary the tool can return.
   */
  async function probe(model, { signal } = {}) {
    const short = modelKeyOf(model)
    const apiId = apiIdOf(model)
    const started = Date.now()
    const previous = store.metaOf(short)
    const result = await chatCompletion({ baseURL, apiKey: key(), body: tinyBody(apiId, { probe: true }), timeoutMs: probeTimeoutMs, fetchImpl, signal })
    const payload = unwrapEnvelope(result.json)
    const ms = Date.now() - started
    const failure = payloadError(payload, result)
    if (failure || !Array.isArray(payload?.choices) || payload.choices.length === 0) {
      const message = failure || 'the gateway returned no completion'
      store.learn(short, { ok: false, lastError: message, lastMs: ms })
      return { ok: false, model: short, ms, error: message }
    }

    const routing = parseRouting(payload)
    const pipeline = routing.pipeline
    const otherPipeline = pipeline === 'planner' ? 'direct' : pipeline === 'direct' ? 'planner' : null
    const harvested = pipeline === null ? null : await harvest(apiId, pipeline, signal)
    const otherHarvested = otherPipeline === null ? null : await harvest(apiId, otherPipeline, signal)
    const servedRaw = typeof routing.finalProvider === 'string' && routing.finalProvider.length > 0 ? routing.finalProvider : null
    const served = servedRaw === null ? [] : [pipeline === null ? servedRaw : channelNameFor(servedRaw, pipeline)]
    const discovered = mergeUpstreams(served, harvested, routing.fallbacks, otherHarvested)
    const upstreams = discovered.length > 0
      ? mergeUpstreams(discovered, previous.upstreams)
      : (Array.isArray(previous.upstreams) ? previous.upstreams : [])
    const channels = { ...(previous.channels ?? {}) }
    if (pipeline !== null) {
      const scoped = mergeUpstreams(served, harvested)
      if (scoped.length > 0) channels[pipeline] = scoped
    }
    if (otherPipeline !== null && Array.isArray(otherHarvested) && otherHarvested.length > 0) {
      channels[otherPipeline] = otherHarvested
    }
    const tier0 = [...new Set([...(previous.tier0 ?? []), ...parseTier0(routing.plan)])]
    const meta = store.learn(short, {
      ok: true,
      pipeline,
      pinnable: pipeline !== null,
      canonicalSlug: routing.canonicalSlug ?? previous.canonicalSlug ?? null,
      upstreams,
      channels,
      tier0,
      lastProvider: routing.finalProvider ?? previous.lastProvider ?? null,
      lastMs: ms,
      probedAt: Date.now(),
      lastError: '',
    })
    return {
      ok: true,
      model: short,
      ms,
      pipeline: meta.pipeline,
      pinnable: meta.pinnable === true,
      canonicalSlug: meta.canonicalSlug ?? '',
      lastProvider: meta.lastProvider ?? '',
      upstreams: meta.upstreams ?? [],
      channels: meta.channels ?? {},
      tier0: meta.tier0 ?? [],
    }
  }

  /**
   * Send one tiny request per known channel and record what served it.
   *
   * @param {string} model - short key or API id.
   * @returns {Promise<{model: string, results: any[], summary: any, error: string}>}
   */
  async function validate(model, { signal } = {}) {
    const short = modelKeyOf(model)
    const keyValue = key()
    const apiId = apiIdOf(model)
    const meta = store.metaOf(short)
    const list = Array.isArray(meta.upstreams) ? meta.upstreams : []
    if (list.length === 0) {
      return { model: short, results: [], summary: {}, error: 'no channels are known for this model yet; probe it first' }
    }
    const results = []
    for (let index = 0; index < list.length; index += VALIDATE_CONCURRENCY) {
      if (signal?.aborted) break
      const batch = list.slice(index, index + VALIDATE_CONCURRENCY)
      const settled = await Promise.all(batch.map(async (upstream) => {
        const started = Date.now()
        const attempt = { upstream, strict: true, sort: null, orderRest: [], excludeList: [] }
        const body = injectPrefs(tinyBody(apiId), meta, attempt)
        try {
          const result = await chatCompletion({ baseURL, apiKey: keyValue, body, timeoutMs: probeTimeoutMs, fetchImpl, signal })
          const payload = unwrapEnvelope(result.json)
          const ms = Date.now() - started
          const failure = payloadError(payload, result)
          if (failure) {
            const status = classifyUpstreamError(failure)
            return { upstream, status, ms, note: failure.slice(0, 160) }
          }
          if (!Array.isArray(payload?.choices) || payload.choices.length === 0) {
            return { upstream, status: 'unknown', ms, note: 'the gateway returned no completion' }
          }
          const routing = parseRouting(payload)
          const adherence = pinAdherence(attempt, routing)
          if (adherence === 'adopted') return { upstream, status: 'ok', ms, note: '' }
          if (adherence === 'unresolved') {
            return { upstream, status: 'unknown', ms, note: 'the response did not name the serving channel; the pin could not be verified' }
          }
          return { upstream, status: 'not-adopted', ms, note: `pin not adopted: served by ${routing.finalProvider ?? '(unknown)'}` }
        } catch (error) {
          return { upstream, status: 'unknown', ms: Date.now() - started, note: errorText(error).slice(0, 160) }
        }
      }))
      for (const row of settled) {
        store.learnUpstream(short, row.upstream, row.status, row.note, row.ms)
        results.push(row)
      }
    }
    const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0, 'not-adopted': 0 }
    for (const row of results) summary[row.status] = (summary[row.status] ?? 0) + 1
    store.learn(short, { validatedAt: Date.now() })
    return { model: short, results, summary, error: '' }
  }

  /**
   * Check the pin configuration that would be used for the next request.
   *
   * @param {string} model - short key or API id.
   * @param {string} [upstream] - test this channel instead of the stored pin.
   * @returns {Promise<any>}
   */
  async function test(model, upstream = '', { signal } = {}) {
    const short = modelKeyOf(model)
    const keyValue = key()
    const apiId = apiIdOf(model)
    const meta = store.metaOf(short)
    const attempts = upstream
      ? [{ upstream, strict: true, sort: null, orderRest: [], excludeList: [] }]
      : buildAttempts(pinFor(short))
    const results = []
    for (const attempt of attempts) {
      const started = Date.now()
      const result = await chatCompletion({ baseURL, apiKey: keyValue, body: injectPrefs(tinyBody(apiId), meta, attempt), timeoutMs: probeTimeoutMs, fetchImpl, signal })
      const payload = unwrapEnvelope(result.json)
      const ms = Date.now() - started
      const failure = payloadError(payload, result)
      const routing = parseRouting(payload)
      const adherence = pinAdherence(attempt, routing)
      results.push({
        target: attempt.upstream ?? '(auto)',
        status: result.status,
        ok: failure === '' && Array.isArray(payload?.choices),
        actual: routing.finalProvider ?? '',
        pipeline: routing.pipeline,
        adherence,
        ms,
        note: failure.slice(0, 160),
      })
      if (failure === '' && Array.isArray(payload?.choices)) break
    }
    const last = results[results.length - 1] ?? {}
    return {
      model: short,
      ok: last.ok === true && (last.target === '(auto)' || last.adherence === 'adopted' || last.adherence === 'fallback' || last.adherence === 'unresolved'),
      results,
      targets: results.map((row) => row.target),
      actual: last.actual ?? '',
      adherence: last.adherence ?? 'unresolved',
    }
  }

  /** Read the account's usage windows for the status tool. */
  async function usage(auth = undefined) {
    const keyValue = key()
    const result = await fetchUsageLimits({ baseURL, apiKey: keyValue, fetchImpl })
    if (result.ok) store.setUsage(result)
    return { ...result, user: auth?.email ?? auth?.accountId ?? '' }
  }

  /** Refresh the live model list, for a tool or a manual check. */
  async function models() {
    return await fetchRecommendedModels({ fetchImpl })
  }

  return { probe, validate, test, usage, models, usageWindows }
}

/** Re-exported for tests that exercise the window mapping without an engine. */
export { usageWindows }
