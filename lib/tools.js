/**
 * The agent-facing management surface.
 *
 * magpie turns an OpenCode `tool` hook into one MCP server shared by every
 * agent, so these are the equivalent of dsh-cline-pass's `cline_pass_*` tools:
 * inspect the route, probe a model's upstream channels, validate them, test the
 * current pin, and save a pin. They are deliberately small: the schemas ride in
 * every request's tool list.
 *
 * @module opencode-cline-pass-auth/tools
 */
import { apiIdOf, modelKeyOf } from './protocol.js'

/** One tool definition with a JSON Schema argument object. */
function define(description, properties, required, execute) {
  return {
    description,
    args: { type: 'object', properties, required, additionalProperties: false },
    execute,
  }
}

/** The model summary one row carries. */
function modelRow(apiId, store) {
  const key = modelKeyOf(apiId)
  const meta = store.metaOf(key)
  return {
    model: key,
    apiId: apiIdOf(apiId),
    pinned: store.pinOf(key),
    upstreams: meta.upstreams ?? [],
    pipeline: meta.pipeline ?? null,
    verdicts: store.verdictsOf(key),
    probedAt: meta.probedAt ?? 0,
    validatedAt: meta.validatedAt ?? 0,
  }
}

/**
 * Build the `tool` hook.
 *
 * @param {{store: any, engine: any, listModels: () => string[], build: string, provider: string, displayName: string}} options
 * @returns {{tool: Record<string, any>}}
 */
export function createTools({ store, engine, listModels, build, provider, displayName }) {
  const models = () => {
    const known = [...listModels()]
    const seen = new Set(known.map(modelKeyOf))
    for (const key of Object.keys(store.snapshot().meta)) {
      if (!seen.has(key)) {
        seen.add(key)
        known.push(apiIdOf(key))
      }
    }
    return known
  }

  return {
    tool: {
      status: define(
        'Show the Cline Pass provider, its pinned models and the last requests. Read-only.',
        {},
        [],
        async () => {
          const snapshot = store.snapshot()
          return {
            provider,
            displayName,
            build,
            models: models().length,
            pins: snapshot.pins,
            channels: Object.fromEntries(Object.entries(snapshot.meta).map(([model, meta]) => [model, {
              upstreams: meta.upstreams ?? [],
              pipeline: meta.pipeline ?? null,
            }])),
            usage: snapshot.usage,
            recent: snapshot.history.slice(0, 10),
          }
        },
      ),

      models: define(
        'List Cline Pass models with their pin, discovered upstream channels and channel verdicts.',
        { filter: { type: 'string', description: 'Only models whose id contains this text.' } },
        [],
        async ({ filter } = {}) => {
          const needle = String(filter ?? '').toLowerCase()
          const rows = models()
            .filter((apiId) => needle.length === 0 || apiId.toLowerCase().includes(needle))
            .map((apiId) => modelRow(apiId, store))
          return { count: rows.length, models: rows }
        },
      ),

      probe: define(
        'Discover which upstream channels can serve one model. Costs up to three tiny real requests.',
        { model: { type: 'string', description: 'Model key or API id, e.g. "glm-5.3".' } },
        ['model'],
        async ({ model }, ctx) => {
          const target = modelKeyOf(model)
          if (!target) throw new Error('model is required')
          return await engine.probe(target, { signal: ctx?.abort })
        },
      ),

      validate: define(
        'Send one tiny request to every known channel of a model and record whether the pin was honored. Probe first.',
        { model: { type: 'string', description: 'Model key or API id, e.g. "glm-5.3".' } },
        ['model'],
        async ({ model }, ctx) => {
          const target = modelKeyOf(model)
          if (!target) throw new Error('model is required')
          return await engine.validate(target, { signal: ctx?.abort })
        },
      ),

      test: define(
        'Test the pin that would be used for the next request, or one named channel. Nothing is saved.',
        {
          model: { type: 'string', description: 'Model key or API id, e.g. "glm-5.3".' },
          upstream: { type: 'string', description: 'Test this channel instead of the saved pin.' },
        },
        ['model'],
        async ({ model, upstream } = {}, ctx) => {
          const target = modelKeyOf(model)
          if (!target) throw new Error('model is required')
          return await engine.test(target, upstream ?? '', { signal: ctx?.abort })
        },
      ),

      pin: define(
        'Save the upstream pin for one model. `strict` uses each channel alone; `preferred` tries them in order and fails over before the first token. Clear it to fall back to the plugin options.',
        {
          model: { type: 'string', description: 'Model key or API id, e.g. "glm-5.3".' },
          upstreams: { type: 'array', items: { type: 'string' }, description: 'Channels to try, in order.' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Channels to exclude, compiled into an allow-list.' },
          pinMode: { type: 'string', enum: ['strict', 'preferred'] },
          sort: { type: 'string', enum: ['none', 'cost', 'ttft', 'tps'] },
          spelling: { type: 'string', enum: ['both', 'detected'] },
          clear: { type: 'boolean', description: 'Remove the saved pin for this model.' },
        },
        ['model'],
        async ({ model, upstreams, exclude, pinMode, sort, spelling, clear } = {}) => {
          const target = modelKeyOf(model)
          if (!target) throw new Error('model is required')
          if (clear === true) return { model: target, cleared: true, pin: store.clearPin(target) }
          const pin = {}
          if (Array.isArray(upstreams)) pin.upstreams = upstreams
          if (Array.isArray(exclude)) pin.exclude = exclude
          if (typeof pinMode === 'string') pin.pinMode = pinMode
          if (typeof sort === 'string') pin.sort = sort
          if (typeof spelling === 'string') pin.spelling = spelling
          return { model: target, pin: store.setPin(target, pin) }
        },
      ),

      history: define(
        'Show the most recent Cline Pass requests: model, channel, timing and error, never prompts.',
        { limit: { type: 'number', description: 'Rows to return (default 20, at most 100).' } },
        [],
        async ({ limit } = {}) => {
          const count = Math.max(0, Math.min(100, Number(limit) || 20))
          return { rows: store.snapshot().history.slice(0, count) }
        },
      ),
    },
  }
}
