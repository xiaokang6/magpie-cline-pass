/**
 * The request path: Cline's chat-completions endpoint, per-model upstream
 * pinning, and failover that is invisible until the first content frame.
 *
 * The router's pin is only a preference: a gateway may drop an unknown `only`
 * and serve the request from anywhere. This module therefore reads back the
 * channel a response names, records it, and — for a `preferred` pin — tries the
 * next candidate when an attempt fails before the caller has seen anything.
 *
 * @module opencode-cline-pass-auth/request
 */
import { classifyFailure, clineHeaders, errorResponse, firstMessage } from './cline.js'
import {
  apiIdOf,
  buildAttempts,
  classifyUpstreamError,
  errorText,
  injectPrefs,
  modelKeyOf,
  parseRouting,
  pinAdherence,
  pinWarnings,
} from './protocol.js'
import { SSETap, unwrapBody } from './stream.js'

/** Read a request body as text, whatever shape magpie passes. */
export async function bodyTextOf(input, init) {
  const body = init?.body
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') return body
    if (body instanceof URLSearchParams) return body.toString()
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
    try {
      return await new Response(body).text()
    } catch {
      return ''
    }
  }
  if (input instanceof Request) {
    try {
      return await input.clone().text()
    } catch {
      return ''
    }
  }
  return ''
}

/** The URL string of a fetch input. */
export function urlOf(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return String(input ?? '')
}

/** The signal of a fetch input/init pair. */
export function signalOf(input, init) {
  if (init?.signal !== undefined && init.signal !== null) return init.signal
  if (input instanceof Request) return input.signal
  return undefined
}

/** The message an upstream error body carries. */
export function failureMessage(status, text) {
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // keep the raw text
  }
  const detail = firstMessage(parsed) || errorText(parsed?.error) || String(text ?? '').trim().slice(0, 400)
  return detail || `HTTP ${status}`
}

/** The headers a chat request carries to Cline. */
function chatHeaders(input, init, apiKey, accept) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.delete('host')
  headers.delete('content-length')
  headers.delete('content-encoding')
  for (const [key, value] of Object.entries(clineHeaders(apiKey, {
    Accept: accept,
    'Content-Type': 'application/json',
  }))) headers.set(key, value)
  return headers
}

/** A short trace row. */
function traceRow(attempt, status, ms, note) {
  return {
    upstream: attempt?.upstream ?? '(auto)',
    status: Number(status) || 0,
    ms: Number(ms) || 0,
    note: String(note ?? '').slice(0, 160),
  }
}

/** The failure a thrown fetch produces, in the same shape as an HTTP refusal. */
function networkFailure(error) {
  const message = String(error?.message ?? error)
  return { retry: true, signIn: '', status: 502, message: `the Cline gateway could not be reached: ${message}` }
}

/**
 * Build the fetch magpie's loader hands the AI SDK.
 *
 * @param {{
 *   apiKey: string,
 *   baseURL?: string,
 *   pinFor: (model: string) => any,
 *   store: any,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {(input: any, init?: any) => Promise<Response>}
 */
export function createChatFetch({
  apiKey,
  baseURL = 'https://api.cline.bot/api/v1',
  pinFor,
  store,
  fetchImpl = fetch,
} = {}) {
  const endpoint = `${String(baseURL).replace(/\/+$/, '')}/chat/completions`

  return async function chatFetch(input, init = {}) {
    const url = urlOf(input)
    let path = ''
    try {
      path = new URL(url).pathname
    } catch {
      return errorResponse(400, 'the request URL is not a valid URL')
    }
    if (!/\/chat\/completions$/.test(path)) {
      return errorResponse(404, 'only /chat/completions is served by the Cline Pass plugin')
    }
    if (!apiKey) {
      return errorResponse(401, 'Cline Pass: no API key is stored for this account; sign in again', 'expired')
    }

    let chat
    try {
      chat = JSON.parse(await bodyTextOf(input, init))
    } catch {
      return errorResponse(400, 'the request body is not a chat completion')
    }
    if (chat === null || typeof chat !== 'object' || Array.isArray(chat)) {
      return errorResponse(400, 'the request body is not a chat completion')
    }

    const model = modelKeyOf(chat.model)
    const apiId = apiIdOf(chat.model)
    if (!model) {
      return errorResponse(400, 'the request body names no model', 'kept')
    }
    const meta = store.metaOf(model)
    const attempts = buildAttempts(pinFor(model))
    const signal = signalOf(input, init)
    const startedAt = Date.now()
    const trace = []
    const warnings = pinWarnings(attempts[0], meta)
    const streaming = chat.stream === true
    const headers = chatHeaders(input, init, apiKey, streaming ? 'text/event-stream' : 'application/json')

    /**
     * Open one attempt and wait only for its response headers.
     * A non-2xx answer is returned as data so the caller can decide about
     * retrying; a thrown fetch is a retryable transport failure.
     */
    const openAttempt = async (index) => {
      const attempt = attempts[index]
      const body = JSON.stringify(injectPrefs({ ...chat, model: apiId }, meta, attempt))
      const attemptStarted = Date.now()
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) controller.abort(signal.reason)
      else signal?.addEventListener?.('abort', abort, { once: true })
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
      const cleanup = () => signal?.removeEventListener?.('abort', abort)
      try {
        const response = await fetchImpl(endpoint, { method: 'POST', headers, body, signal: combined })
        cleanup()
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          const message = failureMessage(response.status, text)
          return {
            ok: false,
            attempt,
            attemptStarted,
            status: response.status,
            message,
            failure: classifyFailure(response.status, message),
            cleanup,
          }
        }
        if (response.body === null || response.body === undefined) {
          return {
            ok: false,
            attempt,
            attemptStarted,
            status: response.status,
            message: 'the Cline gateway returned no response body',
            failure: { retry: true, signIn: '', status: 502, message: 'the Cline gateway returned no response body' },
            cleanup,
          }
        }
        return { ok: true, response, attempt, attemptStarted, controller, cleanup }
      } catch (error) {
        cleanup()
        const failure = networkFailure(error)
        return { ok: false, attempt, attemptStarted, status: 0, message: failure.message, failure, cleanup }
      }
    }

    const recordFailure = (opened, note) => {
      trace.push(traceRow(opened.attempt, opened.status, Date.now() - opened.attemptStarted, note))
      store.learnUpstream(model, opened.attempt.upstream, classifyUpstreamError(note), note, Date.now() - opened.attemptStarted)
    }

    // ── non-streaming: read the whole answer per candidate ──────────────────
    if (!streaming) {
      let lastFailure = null
      for (let index = 0; index < attempts.length; index += 1) {
        const opened = await openAttempt(index)
        if (!opened.ok) {
          lastFailure = opened.failure
          recordFailure(opened, opened.message)
          if (opened.failure.retry && index < attempts.length - 1) continue
          break
        }
        let text
        try {
          text = await opened.response.text()
        } catch (error) {
          opened.cleanup()
          lastFailure = networkFailure(error)
          recordFailure(opened, lastFailure.message)
          if (index < attempts.length - 1) continue
          break
        }
        opened.cleanup()
        const bodyText = unwrapBody(text)
        let payload = null
        try {
          payload = JSON.parse(bodyText)
        } catch {
          payload = null
        }
        // A gateway that answers 200 with an error envelope is still a
        // failure; handing it to the agent would surface "no choices" instead
        // of the gateway's own sentence.
        if (payload !== null && typeof payload === 'object' && payload.error !== undefined && payload.choices === undefined) {
          const message = errorText(payload.error) || 'the gateway returned an error'
          const failure = classifyFailure(opened.status >= 400 ? opened.status : 502, message)
          lastFailure = failure
          recordFailure(opened, message)
          if (failure.retry && index < attempts.length - 1) continue
          break
        }
        const routing = parseRouting(payload)
        const adherence = pinAdherence(opened.attempt, routing)
        const ms = Date.now() - opened.attemptStarted
        trace.push(traceRow(
          opened.attempt,
          opened.status,
          ms,
          adherence === 'adopted' || opened.attempt.upstream === null ? 'ok' : `pin ${adherence}: served by ${routing.finalProvider ?? '(unknown)'}`,
        ))
        if (opened.attempt.upstream !== null && adherence === 'adopted') store.learnUpstream(model, opened.attempt.upstream, 'ok', '', ms)
        store.record({
          model,
          stream: false,
          upstream: opened.attempt.upstream,
          actual: routing.finalProvider,
          attempts: trace.map((row) => row.upstream),
          status: 200,
          ms: Date.now() - startedAt,
          error: '',
          adherence,
          warnings,
        })
        return new Response(bodyText, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Magpie-Sign-In': 'kept' },
        })
      }
      const message = lastFailure?.message ?? 'no pinned upstream could serve the request'
      store.record({
        model,
        stream: false,
        upstream: null,
        actual: null,
        attempts: trace.map((row) => row.upstream),
        status: lastFailure?.status ?? 502,
        ms: Date.now() - startedAt,
        error: message.slice(0, 400),
        warnings,
      })
      return errorResponse(lastFailure?.status ?? 502, `${message} [model=${model}]`, lastFailure?.signIn ?? '')
    }

    // ── streaming: return headers of the first working attempt, then let the
    //    body retry until its first content frame ────────────────────────────
    let first = null
    let firstIndex = 0
    let lastFailure = null
    for (let index = 0; index < attempts.length; index += 1) {
      const opened = await openAttempt(index)
      if (opened.ok) {
        first = opened
        firstIndex = index
        break
      }
      lastFailure = opened.failure
      recordFailure(opened, opened.message)
      if (!opened.failure.retry || index === attempts.length - 1) break
    }
    if (first === null) {
      const message = lastFailure?.message ?? 'no pinned upstream could serve the request'
      store.record({
        model,
        stream: true,
        upstream: null,
        actual: null,
        attempts: trace.map((row) => row.upstream),
        status: lastFailure?.status ?? 502,
        ms: Date.now() - startedAt,
        error: message.slice(0, 400),
        warnings,
      })
      return errorResponse(lastFailure?.status ?? 502, `${message} [model=${model}]`, lastFailure?.signIn ?? '')
    }

    let current = first
    let cancelled = false
    const stream = new ReadableStream({
      async start(controller) {
        const fail = (error) => {
          if (cancelled) return
          try {
            controller.error(error)
          } catch {
            // The consumer already cancelled; there is no one to tell.
          }
        }
        try {
        let opened = first
        for (let index = firstIndex; index < attempts.length; index += 1) {
          if (cancelled) return
          if (index > firstIndex) {
            opened = await openAttempt(index)
            if (!opened.ok) {
              lastFailure = opened.failure
              recordFailure(opened, opened.message)
              if (opened.failure.retry && index < attempts.length - 1) continue
              break
            }
          }
          current = opened
          const reader = opened.response.body.getReader()
          const tap = new SSETap()
          const buffered = []
          let committed = false
          let firstContentMs = 0
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) {
                tap.flush()
                break
              }
              buffered.push(next.value)
              tap.push(next.value)
              if (tap.content) {
                committed = true
                firstContentMs = Date.now() - startedAt
                break
              }
              if (tap.error) break
            }
          } catch (error) {
            tap.error = String(error?.message ?? error)
          }

          if (committed) {
            for (const chunk of buffered) controller.enqueue(chunk)
            try {
              for (;;) {
                const next = await reader.read()
                if (next.done) {
                  tap.flush()
                  break
                }
                if (cancelled) break
                tap.push(next.value)
                controller.enqueue(next.value)
              }
            } catch (error) {
              opened.cleanup()
              fail(error)
              return
            }
            opened.cleanup()
            const routing = tap.routing
            const adherence = pinAdherence(opened.attempt, routing)
            const ms = Date.now() - opened.attemptStarted
            trace.push(traceRow(
              opened.attempt,
              200,
              ms,
              adherence === 'adopted' || opened.attempt.upstream === null
                ? 'ok'
                : `pin ${adherence}: served by ${routing?.finalProvider ?? '(unknown)'}`,
            ))
            if (opened.attempt.upstream !== null && adherence === 'adopted') store.learnUpstream(model, opened.attempt.upstream, 'ok', '', ms)
            store.record({
              model,
              stream: true,
              upstream: opened.attempt.upstream,
              actual: routing?.finalProvider ?? null,
              attempts: trace.map((row) => row.upstream),
              status: 200,
              ms: Date.now() - startedAt,
              ttft: firstContentMs,
              error: '',
              adherence,
              warnings,
            })
            controller.close()
            return
          }

          // Nothing reached the caller: this attempt can be replaced.
          try { await reader.cancel() } catch { /* already closed */ }
          opened.controller?.abort()
          opened.cleanup()
          const note = tap.error || (tap.done ? 'the upstream finished before any content' : 'the upstream stream ended before any content')
          recordFailure(opened, note)
          lastFailure = { retry: true, signIn: '', status: 502, message: note }
          if (signal?.aborted || cancelled) break
        }
        if (cancelled) return
        const message = lastFailure?.message ?? 'no pinned upstream could serve the request'
        store.record({
          model,
          stream: true,
          upstream: null,
          actual: null,
          attempts: trace.map((row) => row.upstream),
          status: lastFailure?.status ?? 502,
          ms: Date.now() - startedAt,
          error: message.slice(0, 400),
          warnings,
        })
        fail(new Error(`${message} [model=${model}]`))
        } catch (error) {
          fail(error)
        }
      },
      cancel(reason) {
        cancelled = true
        current?.controller?.abort(reason)
        current?.cleanup?.()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Magpie-Sign-In': 'kept',
      },
    })
  }
}
