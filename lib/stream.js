/**
 * Server-sent-event inspection for the streaming request path.
 *
 * The bytes are always passed through untouched; this tap reads a decoded copy
 * only to answer three questions the failover logic needs:
 *
 * 1. has the caller seen content yet (so a retry can no longer un-deliver it)?
 * 2. did the frame carry an error?
 * 3. which upstream does the gateway say served the request?
 *
 * @module magpie-cline-pass/stream
 */
import { errorText, parseRouting } from './protocol.js'

/**
 * Whether one decoded chat frame carries content the agent would see.
 *
 * A role-only delta, a usage frame and a keep-alive comment are all "nothing
 * yet": retrying after any of them is still invisible to the caller.
 *
 * @param {any} frame - one decoded SSE `data:` frame.
 * @returns {boolean} true when content, reasoning or a tool call is present.
 */
export function hasContent(frame) {
  const choice = frame?.choices?.[0]
  const delta = choice?.delta ?? choice?.message ?? {}
  if (typeof delta?.content === 'string' && delta.content.length > 0) return true
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true
  if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) return true
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) return true
  if (delta?.function_call && typeof delta.function_call === 'object') return true
  if (typeof choice?.text === 'string' && choice.text.length > 0) return true
  return false
}

/** The error text a frame carries, or an empty string. */
export function frameError(frame) {
  if (frame === null || typeof frame !== 'object') return ''
  const value = frame.error ?? frame.choices?.[0]?.error
  return value === undefined || value === null ? '' : (errorText(value) || 'the upstream reported an error')
}

/**
 * A line-by-line reader for one upstream response's SSE body.
 *
 * One instance belongs to one attempt. `push` takes the raw bytes that will be
 * forwarded, and never mutates them.
 */
export class SSETap {
  constructor() {
    this.decoder = new TextDecoder()
    this.buffer = ''
    this.routing = null
    this.error = ''
    this.done = false
    this.content = false
  }

  /** Feed one raw chunk; returns this tap. */
  push(chunk) {
    if (chunk === undefined || chunk === null) return this
    this.buffer += this.decoder.decode(chunk, { stream: true })
    this.drain(false)
    return this
  }

  /** Flush a trailing partial line at end of stream; returns this tap. */
  flush() {
    this.buffer += this.decoder.decode()
    this.drain(true)
    return this
  }

  /** Process complete lines from the buffer. */
  drain(force) {
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      this.line(line)
    }
    if (force && this.buffer.length > 0) {
      const line = this.buffer.replace(/\r$/, '')
      this.buffer = ''
      this.line(line)
    }
  }

  /** Inspect one line. Only `data:` carries JSON. */
  line(line) {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data.length === 0) return
    if (data === '[DONE]') {
      this.done = true
      return
    }
    let frame
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    const failure = frameError(frame)
    if (failure) this.error = failure
    const routing = parseRouting(frame)
    if (routing.pipeline !== null || routing.finalProvider !== null || routing.canonicalSlug !== null) {
      this.routing = { ...(this.routing ?? {}), ...routing }
    }
    if (hasContent(frame)) this.content = true
  }
}

/**
 * The non-streaming answer with Cline's `{ data: … }` envelope removed.
 *
 * A finished chat completion rides as `{"data": …}`, the shape Cline's own
 * clients take apart; a plain JSON answer is returned untouched.
 *
 * @param {string} text - the upstream body.
 * @returns {string} a body magpie can hand to the AI SDK.
 */
export function unwrapBody(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.data?.choices)) return JSON.stringify(parsed.data)
  return text
}
