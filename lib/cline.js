/**
 * Transport to Cline's gateway and its public catalogs.
 *
 * Transport only: pinning, retry and failover policy live in `request.js` and
 * `engine.js`. Nothing here writes a secret to a log or to disk.
 *
 * @module magpie-cline-pass/cline
 */
import { parseRecommendedFeed } from './catalog.js'
import { API_PREFIX, redactSecrets, RECOMMENDED_MODELS_URL, USAGE_LIMITS_PATH } from './protocol.js'

/** The gateway's base URL. */
export const API = 'https://api.cline.bot/api/v1'

/** The plugin's own version, sent as a courtesy User-Agent. */
export const CLIENT_VERSION = '0.1.2'

/** Combine a caller signal with a timeout signal. */
export function withTimeout(signal, timeoutMs) {
  const signals = []
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signal !== undefined && signal !== null) signals.push(signal)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

/** Strip a trailing slash so paths can be appended literally. */
export function trimBase(baseURL) {
  return String(baseURL ?? '').trim().replace(/\/+$/, '')
}

/** The gateway's own chat-completions endpoint for one base URL. */
export function chatURL(baseURL = API) {
  return `${trimBase(baseURL)}/chat/completions`
}

/** The headers every Cline request carries. */
export function clineHeaders(apiKey, extra = {}) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': `magpie-cline-pass/${CLIENT_VERSION}`,
    'HTTP-Referer': 'https://usemagpie.ai',
    'X-Title': 'magpie',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  }
  return headers
}

/**
 * Send one JSON request and decode whatever comes back.
 * @returns {Promise<{status: number, ok: boolean, json: any, text: string, headers: Headers}>}
 */
export async function sendJSON(url, {
  method = 'GET',
  apiKey = '',
  body,
  signal,
  timeoutMs = 30000,
  headers = {},
  fetchImpl = fetch,
} = {}) {
  const outgoing = {
    method,
    headers: clineHeaders(apiKey, {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: withTimeout(signal, timeoutMs),
  }
  const response = await fetchImpl(url, outgoing)
  const text = await response.text()
  let json = null
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: response.status, ok: response.ok, json, text, headers: response.headers }
}

/**
 * One non-streaming chat completion, the shape probes and validations use.
 * @returns {Promise<{status: number, ok: boolean, json: any, text: string}>}
 */
export function chatCompletion({ baseURL = API, apiKey, body, signal, timeoutMs = 60000, fetchImpl = fetch } = {}) {
  return sendJSON(chatURL(baseURL), { method: 'POST', apiKey, body, signal, timeoutMs, fetchImpl })
}

/**
 * Read the subscription's model list from Cline's public recommended feed.
 * @returns {Promise<{models: {id: string, name: string, description: string}[], error: string}>}
 */
export async function fetchRecommendedModels({ signal, timeoutMs = 10000, fetchImpl = fetch } = {}) {
  try {
    const result = await sendJSON(RECOMMENDED_MODELS_URL, { signal, timeoutMs, fetchImpl })
    if (!result.ok) return { models: [], error: `Cline's model feed answered HTTP ${result.status}` }
    const models = parseRecommendedFeed(result.json)
    if (models.length === 0) return { models: [], error: 'Cline listed no Cline Pass models' }
    return { models, error: '' }
  } catch (error) {
    return { models: [], error: `Cline's model feed is unavailable: ${String(error?.message ?? error)}` }
  }
}

/** The three windows Cline publishes, in display order, with their spans. */
export const USAGE_WINDOWS = [
  ['five_hour', '5 hours', 5 * 3600],
  ['weekly', 'Weekly', 7 * 24 * 3600],
  ['monthly', 'Monthly', 30 * 24 * 3600],
]

/**
 * Turn the usage-limits answer into magpie's `usage` windows.
 *
 * Unknown window types are passed through rather than dropped, so a window
 * Cline adds later reaches the account card without a release of this plugin.
 *
 * @param {any} raw - the decoded `/users/me/plan/usage-limits` answer.
 * @returns {{plan: string, windows: any[]}}
 */
export function usageWindows(raw) {
  const payload = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : raw
  const limits = Array.isArray(payload?.limits) ? payload.limits : []
  const byType = new Map()
  for (const limit of limits) {
    const type = String(limit?.type ?? '')
    if (type.length > 0) byType.set(type, limit)
  }
  const windows = []
  const used = (limit) => {
    const n = Number(limit?.percentUsed)
    return Number.isFinite(n) ? n : 0
  }
  for (const [type, name, span] of USAGE_WINDOWS) {
    const limit = byType.get(type)
    if (limit === undefined) continue
    byType.delete(type)
    windows.push({
      name,
      used: used(limit),
      ...(limit?.resetsAt ? { resetsAt: String(limit.resetsAt) } : {}),
      span,
    })
  }
  for (const [type, limit] of byType) {
    windows.push({
      name: type,
      used: used(limit),
      ...(limit?.resetsAt ? { resetsAt: String(limit.resetsAt) } : {}),
    })
  }
  return { plan: 'Cline Pass', windows }
}

/**
 * Read one account's official quota windows.
 *
 * A refusal is data, never an exception: the account card keeps working when
 * the usage endpoint does not. A 404 means an account without a Cline Pass
 * subscription; a 401 means the key itself was refused.
 *
 * @returns {Promise<{ok: boolean, windows: any[], error: string, status: number}>}
 */
export async function fetchUsageLimits({
  baseURL = API,
  apiKey,
  signal,
  timeoutMs = 30000,
  fetchImpl = fetch,
} = {}) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}${USAGE_LIMITS_PATH}`, { apiKey, signal, timeoutMs, fetchImpl })
    if (!result.ok) {
      const detail = firstMessage(result.json) ?? result.text.slice(0, 160)
      const suffix = detail === '' ? '' : `: ${detail}`
      if (result.status === 404) {
        return { ok: false, windows: [], error: 'this account has no Cline Pass subscription (HTTP 404)', status: 404 }
      }
      return { ok: false, windows: [], error: `the usage endpoint answered HTTP ${result.status}${suffix}`, status: result.status }
    }
    return { ok: true, ...usageWindows(result.json), error: '', status: result.status }
  } catch (error) {
    return { ok: false, windows: [], error: String(error?.message ?? error), status: 0 }
  }
}

/** The gateway's own one-line explanation, when it sent one. */
export function firstMessage(envelope) {
  const message = envelope?.error?.message ?? envelope?.error ?? envelope?.message
  return typeof message === 'string' ? redactSecrets(message.slice(0, 240)) : ''
}

/**
 * Turn an upstream HTTP failure into an OpenAI-style response magpie can relay.
 * @param {number} status - the upstream status.
 * @param {string} message - the message to show.
 * @param {string} [signIn] - `expired` when the account's key was refused.
 * @returns {Response}
 */
export function errorResponse(status, message, signIn = '') {
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502
  const headers = { 'Content-Type': 'application/json' }
  if (signIn) headers['X-Magpie-Sign-In'] = signIn
  return new Response(JSON.stringify({ error: { message: String(message ?? '').slice(0, 2000), type: 'cline_pass_error', code } }), { status: code, headers })
}

/**
 * Classify an upstream refusal for the request layer: which statuses are worth
 * another channel, and which mean the account itself is the problem.
 *
 * @param {number} status - HTTP status.
 * @param {string} message - the gateway's message.
 * @returns {{retry: boolean, signIn: string, status: number, message: string}}
 */
export function classifyFailure(status, message) {
  const text = String(message ?? '').trim()
  const lower = text.toLowerCase()
  const refused = status === 401 || (status === 403 && /unauthori[sz]ed|invalid[ _-]?(?:api[ _-]?)?(?:key|token)|sign[ -]?in|token (?:expired|invalid|revoked)/i.test(text))
  if (refused) {
    return { retry: false, signIn: 'expired', status: 401, message: text || 'the Cline Pass sign-in was refused — sign in again' }
  }
  // A model the account is not entitled to is a plan fact, not a channel fact.
  if (status === 403) {
    return { retry: false, signIn: 'kept', status: 403, message: text || 'this account is not entitled to that Cline Pass model' }
  }
  // Out of quota is account-wide for a subscription: let magpie move accounts.
  if (status === 402 || /out of credits|insufficient[ _]credits|usage limit|quota exceeded/i.test(lower)) {
    return { retry: false, signIn: '', status: 429, message: text || 'the Cline Pass quota is spent' }
  }
  const retry = status === 400 || status === 404 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
  return { retry, signIn: '', status, message: text || `HTTP ${status}` }
}

/**
 * The account label magpie should show for an auth object, when it has one.
 * @param {any} auth - the saved login.
 * @returns {string} the user label.
 */
export function userOf(auth) {
  for (const value of [auth?.accountId, auth?.metadata?.email, auth?.email, auth?.user]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/** The API id a short key maps to. */
export function apiIdOfKey(key) {
  const value = String(key ?? '').trim()
  return value.startsWith(API_PREFIX) ? value : `${API_PREFIX}${value}`
}
