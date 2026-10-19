/**
 * The plugin's small, non-secret memory: discovered channels, per-channel
 * verdicts, the last probes and a bounded request history.
 *
 * It lives in the magpie configuration directory so a restart keeps what a
 * probe learned. No key, header or prompt is ever written here: a history row
 * names the model, the channel, timing and an error string only.
 *
 * @module magpie-cline-pass/store
 */
import fs from 'node:fs'
import path from 'node:path'
import { redactSecrets } from './protocol.js'

/** How many request-history rows are retained. */
export const DEFAULT_HISTORY_LIMIT = 100

/** The state file, relative to magpie's configuration directory. */
export const STATE_FILE = 'cline-pass-state.json'

/** A fresh state object. */
function emptyState() {
  return {
    version: 1,
    pins: {},
    channels: {},
    upstreams: {},
    meta: {},
    verdicts: {},
    history: [],
    usage: null,
    updatedAt: 0,
  }
}

/** Copy a pin profile with only the fields the protocol understands. */
export function normalizePin(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  if (Array.isArray(value.upstreams)) out.upstreams = value.upstreams.filter((name) => typeof name === 'string' && name.length > 0)
  if (Array.isArray(value.exclude)) out.exclude = value.exclude.filter((name) => typeof name === 'string' && name.length > 0)
  if (typeof value.pinMode === 'string') out.pinMode = value.pinMode
  if (typeof value.sort === 'string') out.sort = value.sort
  if (typeof value.spelling === 'string') out.spelling = value.spelling
  return out
}

/**
 * Normalize a pin map: keys may be short keys or full API ids, both become the
 * short key magpie lists.
 */
export function normalizePins(value) {
  const out = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, pin] of Object.entries(value)) {
    const normalized = normalizePin(pin)
    if (Object.keys(normalized).length > 0) out[String(key).replace(/^cline-pass\//, '')] = normalized
  }
  return out
}

/** One upstream verdict, as the panel and tools read it. */
function verdict(status, note, ms) {
  return { status: String(status ?? 'unknown'), note: redactSecrets(note).slice(0, 400), ms: Number(ms ?? 0) || 0, at: Date.now() }
}

/**
 * Open the store.
 *
 * @param {{directory?: string, historyLimit?: number, options?: any}} input
 * @returns {any} the store.
 */
export function createStore({ directory = '', historyLimit = DEFAULT_HISTORY_LIMIT, options = {} } = {}) {
  const file = directory ? path.join(directory, STATE_FILE) : ''
  let state = emptyState()
  let saveTimer = null
  let saving = false
  let dirty = false

  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        state = {
          ...emptyState(),
          ...raw,
          pins: normalizePins(raw.pins),
          history: Array.isArray(raw.history) ? raw.history.slice(0, historyLimit) : [],
        }
      }
    } catch {
      // A missing or unreadable state file is a fresh start, not a failure.
    }
  }

  const defaultPins = normalizePins(options?.pins)

  /** Write the state atomically: a second host may be reading it. */
  const writeState = () => {
    if (!file) return
    const temporary = `${file}.tmp`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(state), 'utf8')
    fs.renameSync(temporary, file)
  }

  const persist = async () => {
    if (!file || saving) return
    saving = true
    dirty = false
    try {
      writeState()
    } catch {
      // A read-only config directory only costs persistence.
    } finally {
      saving = false
      if (dirty) schedule()
    }
  }

  /**
   * Write without waiting for the debounce. A plugin host is short-lived: the
   * CLI starts one for a command and exits, so an unref'd timer would lose the
   * history and channel verdicts a tool just learned. The exit hook below is
   * the last line of defence; this one runs while the process is still healthy.
   */
  const flushSync = () => {
    if (!file || !dirty) return
    try {
      writeState()
      dirty = false
    } catch {
      // A read-only config directory only costs persistence.
    }
  }

  const schedule = () => {
    dirty = true
    if (!file || saveTimer !== null) return
    // Deliberately ref'd: a 250 ms timer is not worth losing a probe over.
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persist()
    }, 250)
  }

  // The host may exit before the debounce fires (a CLI command, a reload).
  process.on?.('exit', flushSync)

  /** The meta object one model has accumulated. */
  const metaOf = (model) => state.meta[String(model)] ?? {}

  /** Merge one probe's findings into a model's meta. */
  const learn = (model, patch) => {
    const key = String(model)
    const clean = patch && typeof patch.lastError === 'string' ? { ...patch, lastError: redactSecrets(patch.lastError) } : patch
    state.meta[key] = { ...(state.meta[key] ?? {}), ...(clean ?? {}) }
    state.updatedAt = Date.now()
    schedule()
    return state.meta[key]
  }

  /** Record one channel's verdict. */
  const learnUpstream = (model, upstream, status, note = '', ms = 0) => {
    if (typeof upstream !== 'string' || upstream.length === 0) return
    const key = String(model)
    state.verdicts[key] ??= {}
    state.verdicts[key][upstream] = verdict(status, note, ms)
    state.updatedAt = Date.now()
    schedule()
  }

  /** The stored verdict for one channel, if a validation saw one. */
  const verdictOf = (model, upstream) => state.verdicts[String(model)]?.[String(upstream)] ?? null

  /** All verdicts for one model. */
  const verdictsOf = (model) => state.verdicts[String(model)] ?? {}

  /** Append one request row, newest first. */
  const record = (row) => {
    const clean = row && typeof row === 'object'
      ? { ...row, ...(typeof row.error === 'string' ? { error: redactSecrets(row.error) } : {}) }
      : row
    state.history.unshift({ ...(clean ?? {}), at: Date.now() })
    if (state.history.length > historyLimit) state.history.length = historyLimit
    state.updatedAt = Date.now()
    schedule()
  }

  /** Remember the last usage reading, for the status tool. */
  const setUsage = (usage) => {
    state.usage = usage ?? null
    state.updatedAt = Date.now()
    schedule()
  }

  /** The effective pin for one model: a tool-written pin wins over options. */
  const pinOf = (model) => {
    const key = String(model).replace(/^cline-pass\//, '')
    const value = state.pins[key] ?? defaultPins[key] ?? {}
    return normalizePin(value)
  }

  /** Every effective pin, keyed by short model key. */
  const pins = () => {
    const merged = { ...defaultPins, ...state.pins }
    return normalizePins(merged)
  }

  /** Save or replace one model's pin. */
  const setPin = (model, pin) => {
    const key = String(model).replace(/^cline-pass\//, '')
    const normalized = normalizePin(pin)
    if (Object.keys(normalized).length === 0) delete state.pins[key]
    else state.pins[key] = normalized
    state.updatedAt = Date.now()
    schedule()
    return pinOf(key)
  }

  /** Remove a tool-written pin, falling back to the plugin options. */
  const clearPin = (model) => {
    const key = String(model).replace(/^cline-pass\//, '')
    delete state.pins[key]
    state.updatedAt = Date.now()
    schedule()
    return pinOf(key)
  }

  /** Remove every tool-written pin. */
  const clearPins = () => {
    state.pins = {}
    state.updatedAt = Date.now()
    schedule()
    return pins()
  }

  /** The whole readable snapshot, secrets excluded by construction. */
  const snapshot = () => ({
    pins: pins(),
    channels: state.channels,
    upstreams: state.upstreams,
    meta: state.meta,
    verdicts: state.verdicts,
    history: state.history,
    usage: state.usage,
    updatedAt: state.updatedAt,
  })

  /** Write pending changes now (tools and tests use it). */
  const flush = async () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await persist()
  }

  /** Stop the exit hook; a test that removes its directory calls this first. */
  const dispose = () => {
    process.off?.('exit', flushSync)
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  return {
    file,
    dispose,
    metaOf,
    learn,
    learnUpstream,
    verdictOf,
    verdictsOf,
    record,
    setUsage,
    pinOf,
    pins,
    setPin,
    clearPin,
    clearPins,
    snapshot,
    flush,
  }
}
