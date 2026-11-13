/**
 * Runtime provider/model discovery for `dsh-fallback`.
 *
 * Everything here is read from the live `llm` service, so the settings page
 * lists exactly the routers already connected to this Harness profile — no
 * second credential store and no duplicated route configuration.
 *
 * @module dsh-fallback/providers
 */

/** Maximum models returned per provider in one state payload. */
const MAX_MODELS_PER_PROVIDER = 400

/** Remove the plugin's own probe route from every public provider list. */
export const PROBE_PROVIDER = 'fallback-probe'

/**
 * Create a cached provider catalog over the live LLM service.
 * @param {object} options - catalog options.
 * @param {object} options.llm - the `llm` service (`ctx.llm`).
 * @param {() => number} [options.now] - clock override for tests.
 * @param {number} [options.ttlMs] - model-cache lifetime.
 * @param {number} [options.timeoutMs] - per-call discovery timeout.
 * @returns {object} the catalog.
 */
export function createProviderCatalog(options) {
  const { llm } = options
  const clock = options.now ?? Date.now
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 60_000
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8_000
  /** @type {Map<string, {at: number, models: Array<object>}>} */
  const modelCache = new Map()
  /** @type {Map<string, {at: number, info: object | null}>} */
  const infoCache = new Map()

  const withTimeout = async (promise, label) => {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  const listRegistered = () => {
    try {
      const providers = llm.listProviders()
      return Array.isArray(providers) ? providers.filter((provider) => provider?.id !== PROBE_PROVIDER) : []
    } catch {
      return []
    }
  }

  const listConfigurable = () => {
    try {
      const providers = llm.listConfigurableProviders()
      return Array.isArray(providers) ? providers.filter((provider) => provider?.provider !== PROBE_PROVIDER) : []
    } catch {
      return []
    }
  }

  /**
   * List one route's advertised models, cached briefly.
   * @param {string} provider - provider route id.
   * @param {{refresh?: boolean}} [flags] - refresh bypasses the cache.
   * @returns {Promise<Array<{id: string, name: string, contextWindow?: number, maxTokens?: number}>>} normalized models.
   */
  const modelsFor = async (provider, flags = {}) => {
    const cached = modelCache.get(provider)
    if (flags.refresh !== true && cached !== undefined && clock() - cached.at < ttlMs) return cached.models
    try {
      const models = await withTimeout(llm.listModels(provider), `model discovery for "${provider}"`)
      const normalized = (Array.isArray(models) ? models : [])
        .filter((model) => typeof model?.id === 'string' && model.id.length > 0)
        .slice(0, MAX_MODELS_PER_PROVIDER)
        .map((model) => ({
          id: model.id,
          name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
        }))
      modelCache.set(provider, { at: clock(), models: normalized })
      return normalized
    } catch (error) {
      const failed = { at: clock(), models: [], error: error instanceof Error ? error.message : String(error) }
      modelCache.set(provider, failed)
      return []
    }
  }

  /**
   * Resolve exact model metadata (context window, reasoning efforts) once.
   * @param {string} provider - provider route id.
   * @param {string} model - model id.
   * @returns {Promise<object | null>} resolved info or null.
   */
  const modelInfo = async (provider, model) => {
    const key = `${provider}\u0000${model}`
    const cached = infoCache.get(key)
    if (cached !== undefined && clock() - cached.at < ttlMs) return cached.info
    try {
      const info = await withTimeout(llm.resolveModelInfo(provider, model), `model info for "${provider}/${model}"`)
      const detached = typeof info === 'object' && info !== null ? info : null
      infoCache.set(key, { at: clock(), info: detached })
      return detached
    } catch {
      infoCache.set(key, { at: clock(), info: null })
      return null
    }
  }

  /**
   * Whether one route advertises a model id (cached discovery).
   * @param {string} provider - provider route id.
   * @param {string} model - model id.
   * @returns {Promise<boolean | null>} true/false, or null when discovery failed.
   */
  const hasModel = async (provider, model) => {
    const models = await modelsFor(provider)
    const cached = modelCache.get(provider)
    if (cached !== undefined && Array.isArray(cached.error) === false && models.length === 0) return null
    return models.some((entry) => entry.id === model)
  }

  /** Forget every cached model list (used after an adapter-topology change). */
  const refresh = () => {
    modelCache.clear()
    infoCache.clear()
  }

  return { listRegistered, listConfigurable, modelsFor, modelInfo, hasModel, refresh }
}

/**
 * Assemble the provider section of the settings-page payload.
 * @param {object} input - assembly input.
 * @param {object} input.catalog - provider catalog.
 * @param {object} [input.health] - health snapshot (`{degraded, stats}`).
 * @param {ReadonlyArray<object>} [input.chain] - current chain, to mark included routes.
 * @param {number} [input.now] - clock override.
 * @param {boolean} [input.loadModels] - await model discovery (false answers fast).
 * @param {boolean} [input.refresh] - bypass the model cache.
 * @returns {Promise<object>} `{providers, configurable}`.
 */
export async function describeProviders(input) {
  const now = input.now ?? Date.now()
  const catalog = input.catalog
  const health = input.health ?? { degraded: {}, stats: {} }
  const loadModels = input.loadModels !== false
  const chainProviders = new Set((input.chain ?? []).map((entry) => entry.provider))
  const registered = catalog.listRegistered()
  const seen = new Set()
  const selected = []
  for (const provider of registered) {
    const id = provider?.id
    if (typeof id !== 'string' || id.length === 0 || id === PROBE_PROVIDER || seen.has(id)) continue
    seen.add(id)
    selected.push({
      id,
      name: typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : id,
    })
  }
  const providers = await Promise.all(
    selected.map(async (provider) => {
      const models = loadModels ? await catalog.modelsFor(provider.id, { refresh: input.refresh === true }) : null
      const degraded = health.degraded?.[provider.id]
      return {
        ...provider,
        registered: true,
        inChain: chainProviders.has(provider.id),
        models,
        degraded:
          degraded === undefined
            ? null
            : {
                until: Number.isFinite(Number(degraded.until)) ? Number(degraded.until) : null,
                remainingMs: Math.max(0, (Number(degraded.until) || now) - now),
                code: typeof degraded.code === 'string' ? degraded.code : 'UNKNOWN',
                message: typeof degraded.message === 'string' ? degraded.message.slice(0, 300) : '',
              },
        stats: health.stats?.[provider.id] ?? null,
      }
    }),
  )
  const configurable = catalog
    .listConfigurable()
    .filter((entry) => typeof entry?.provider === 'string' && !seen.has(entry.provider))
    .map((entry) => ({
      provider: entry.provider,
      displayName: typeof entry.displayName === 'string' ? entry.displayName : entry.provider,
      settingsNs: typeof entry.settingsNs === 'string' ? entry.settingsNs : '',
      registered: false,
    }))
  return { providers, configurable }
}

/**
 * Resolve one concrete model id for every chain entry, replacing an empty
 * `model` with the route's first advertised model. Entries whose route
 * advertises nothing are dropped; the self-test uses this so an
 * "inherit the request model" chain is tested with a real model id.
 * @param {object} input - resolution input.
 * @param {object} input.catalog - provider catalog.
 * @param {ReadonlyArray<object>} input.chain - chain entries.
 * @param {string} [input.fallbackModel] - model used when discovery is empty.
 * @returns {Promise<Array<object>>} the resolved chain.
 */
export async function resolveChainModels(input) {
  const resolved = []
  for (const entry of input.chain) {
    if (entry.model.length > 0) {
      resolved.push({ ...entry })
      continue
    }
    const models = await input.catalog.modelsFor(entry.provider)
    const model = models.length > 0 ? models[0].id : input.fallbackModel
    if (typeof model !== 'string' || model.length === 0) continue
    resolved.push({ ...entry, model })
  }
  return resolved
}
