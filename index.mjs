/**
 * Cline Pass for magpie.
 *
 * One provider route, `cline-pass`, whose model ids are the short names of the
 * Cline Pass subscription (`cline-pass/deepseek-v4.1-flash` is the agent-facing
 * id, `cline-pass/deepseek-v4.1-flash` on the wire). The plugin adds what a
 * subscription gets from dsh-cline-pass: per-model upstream discovery, pinning,
 * validation and pre-first-token failover between channels.
 *
 * Everything magpie already does — the account pool, key storage, account
 * failover, quota-driven resting, model selection and routing groups — is left
 * to magpie. This plugin is not a proxy and starts no server.
 *
 * @module magpie-cline-pass
 */
import {
  createEngine,
  usageWindows,
} from './lib/engine.js'
import {
  API,
  fetchRecommendedModels,
  fetchUsageLimits,
  userOf,
} from './lib/cline.js'
import {
  MODEL_CATALOG,
} from './lib/catalog-data.js'
import {
  apiIdOf,
  modelKeyOf,
  BUILD_TAG,
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  errorText,
  extractAvailableProviders,
  injectPrefs,
  normalizePinMode,
  normalizeSort,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
} from './lib/protocol.js'
import {
  catalogEntry,
  configModel,
  modelDescriptor,
  parseRecommendedFeed,
  prettify,
  runtimeModel,
} from './lib/catalog.js'
import { readStoredApiKey } from './lib/authkey.js'
import { createChatFetch } from './lib/request.js'
import { createStore, normalizePin, normalizePins } from './lib/store.js'
import { createTools } from './lib/tools.js'
import { hasContent, SSETap, unwrapBody } from './lib/stream.js'

/** The provider id agents address. */
export const PROVIDER = 'cline-pass'

/** The name shown in magpie's provider list. */
export const DISPLAY_NAME = 'Cline Pass'

/** How long a live model list is trusted before the feed is asked again. */
const MODEL_CACHE_MS = 5 * 60 * 1000

/** The bundled fallback list, in provider order. */
const FALLBACK_MODELS = Object.keys(MODEL_CATALOG)

/** One magpie provider plugin. */
export const ClinePassPlugin = async ({ client, directory } = {}, options = {}) => {
  const store = createStore({
    directory,
    historyLimit: Number(options?.historyLimit) > 0 ? Number(options.historyLimit) : 100,
    options,
  })

  // The most recent account magpie handed us. Tools run outside an account's
  // scope, and a probe only needs one account's key; magpie's own routing still
  // owns the pool. The raw key is never returned by a tool or written to disk.
  let lastAuth = null
  const remember = (auth) => {
    if (auth && typeof auth === 'object') lastAuth = auth
    return auth
  }

  const engine = createEngine({
    // Tools run outside an account scope. Prefer the account magpie last handed
    // us; fall back to the stored login so a probe works right after a reload,
    // before the first provider request has populated `lastAuth`.
    getKey: () => String(lastAuth?.key ?? '') || readStoredApiKey({ directory, provider: PROVIDER }),
    baseURL: API,
    store,
    pinFor: (model) => store.pinOf(model),
    probeTimeoutMs: Number(options?.probeTimeoutMs) > 0 ? Number(options.probeTimeoutMs) : 60000,
  })

  // One live catalog, shared by provider.models and the tools. A failed refresh
  // keeps the previous list rather than replacing it with the bundled one.
  let catalog = { at: 0, models: [] }
  let catalogRequest = null
  const refreshCatalog = async () => {
    const fresh = Date.now() - catalog.at < MODEL_CACHE_MS && catalog.models.length > 0
    if (fresh) return catalog.models
    if (catalogRequest !== null) return await catalogRequest
    catalogRequest = (async () => {
      const result = await fetchRecommendedModels()
      if (result.models.length > 0) catalog = { at: Date.now(), models: result.models }
      return catalog.models
    })().finally(() => {
      catalogRequest = null
    })
    return await catalogRequest
  }

  const knownModels = () => (catalog.models.length > 0 ? catalog.models.map((model) => model.id) : FALLBACK_MODELS)

  const modelMap = (models) => Object.fromEntries(models.map((entry) => {
    const APIId = typeof entry === 'string' ? entry : String(entry?.id ?? '')
    if (!APIId) return null
    const descriptor = modelDescriptor(APIId)
    return [modelKeyOf(APIId), runtimeModel(APIId, PROVIDER, descriptor)]
  }).filter((row) => row !== null))

  const fallbackConfigModels = () => Object.fromEntries(FALLBACK_MODELS.map((APIId) => [
    modelKeyOf(APIId),
    configModel(APIId, modelDescriptor(APIId)),
  ]))

  const accountLabel = (auth) => userOf(auth)

  const auth = {
    provider: PROVIDER,
    methods: [
      {
        type: 'api',
        label: 'Cline Pass API key (app.cline.bot → Settings → API Keys)',
        placeholder: 'sk_…',
      },
    ],
    maxConcurrency: Number(options?.maxConcurrency) > 0 ? Number(options.maxConcurrency) : 8,

    /**
     * The request path for one account. `getAuth()` is account-scoped, so a
     * multi-account pool gets one fetch per account without this plugin ever
     * keeping a key in a module variable for routing.
     */
    async loader(getAuth) {
      const saved = remember(await getAuth())
      const apiKey = String(saved?.key ?? '')
      return {
        baseURL: API,
        apiKey: apiKey || 'cline-pass',
        fetch: createChatFetch({
          apiKey,
          baseURL: API,
          pinFor: (model) => store.pinOf(model),
          store,
        }),
      }
    },

    /**
     * Cline Pass's own quota windows. A 401 marks the account; a 404 means the
     * account has no subscription, which is a plan fact rather than a lapse.
     */
    async usage(getAuth) {
      const saved = remember(await getAuth())
      const apiKey = String(saved?.key ?? '')
      const user = accountLabel(saved)
      if (!apiKey) return { windows: [], error: 'Cline Pass: no API key is stored for this account', signIn: 'kept' }
      const reading = await fetchUsageLimits({ apiKey, baseURL: API })
      if (!reading.ok) {
        return {
          windows: [],
          error: reading.error,
          user,
          signIn: reading.status === 401 ? 'expired' : 'kept',
        }
      }
      store.setUsage(reading)
      return { plan: reading.plan, windows: reading.windows, user, signIn: 'kept' }
    },
  }

  const provider = {
    id: PROVIDER,

    /**
     * The subscription's live list. magpie calls this once per account, inside
     * that account's scope and through its proxy; the list does not depend on
     * the account, so the short cache is shared.
     *
     * A failed feed keeps the list magpie already had: returning a smaller
     * bundled list would look like models were taken away.
     */
    async models(current, context = {}) {
      remember(context?.auth)
      try {
        const models = await refreshCatalog()
        if (models.length > 0) return modelMap(models)
      } catch {
        // fall through to the list magpie already has
      }
      if (current?.models && Object.keys(current.models).length > 0) return current.models
      return modelMap(FALLBACK_MODELS)
    },
  }

  const hooks = {
    async config(cfg) {
      cfg.provider ??= {}
      const existing = cfg.provider[PROVIDER]
      if (existing === undefined || existing === null) {
        cfg.provider[PROVIDER] = {
          name: DISPLAY_NAME,
          npm: '@ai-sdk/openai-compatible',
          api: API,
          models: fallbackConfigModels(),
        }
        return
      }
      // Never overwrite a user's provider block. Fill only what is missing, so a
      // hand-written `models` choice survives.
      if (!existing.name) existing.name = DISPLAY_NAME
      if (!existing.npm) existing.npm = '@ai-sdk/openai-compatible'
      if (!existing.api) existing.api = API
      if (!existing.models || Object.keys(existing.models).length === 0) existing.models = fallbackConfigModels()
    },

    auth,
    provider,
  }

  if (options?.exposeTools !== false) {
    hooks.tool = createTools({
      store,
      engine,
      listModels: knownModels,
      build: BUILD_TAG,
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
    }).tool
  }

  // Warm the catalog without making the plugin's activation wait on the network.
  void refreshCatalog().catch(() => {})

  return hooks
}

export default { id: PROVIDER, server: ClinePassPlugin }

/**
 * Pure helpers exposed for the test suite, in the shape magpie's docs suggest
 * for community plugins. No function here is a plugin hook.
 */
export const _internal = {
  PROVIDER,
  DISPLAY_NAME,
  API,
  BUILD_TAG,
  FALLBACK_MODELS,
  MODEL_CATALOG,
  apiIdOf,
  modelKeyOf,
  catalogEntry,
  configModel,
  modelDescriptor,
  parseRecommendedFeed,
  prettify,
  runtimeModel,
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  errorText,
  extractAvailableProviders,
  injectPrefs,
  normalizePin,
  normalizePins,
  normalizePinMode,
  normalizeSort,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
  usageWindows,
  createChatFetch,
  createStore,
  hasContent,
  SSETap,
  unwrapBody,
  createEngine,
}
