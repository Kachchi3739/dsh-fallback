/**
 * Model → wire-protocol resolution for the routers this plugin pools accounts
 * on.
 *
 * The header a rotated account key must travel in depends on the protocol the
 * exact model speaks (`authorization: Bearer` for OpenAI-compatible routes,
 * `x-api-key` for Anthropic Messages, `x-goog-api-key` for Gemini). The
 * installed pi-ai catalog describes that per model, so this module reads the
 * catalog shipped with the running DeepSeek Harness and keeps a small embedded
 * snapshot as the fallback for installations whose catalog cannot be read
 * (for example a CLI install with a different layout).
 *
 * @module dsh-fallback/model-apis
 */

import fs from 'node:fs'

/** Embedded `opencode-go` model → protocol map (snapshot of 0.2.2-rc.3). */
const EMBEDDED_OPENCODE_GO = Object.freeze({
  'cat-jam-free': 'openai-completions',
  'claude-haiku-5-5': 'anthropic-messages',
  'deepseek-v4.1-flash': 'openai-completions',
  'deepseek-v4-pro': 'openai-completions',
  'gemini-4-argon-contributor': 'google-generative-ai',
  'glm-5.2': 'openai-completions',
  'glm-5.3': 'openai-completions',
  'glm-5.3-flash': 'openai-completions',
  'gpt-5.6-luna': 'openai-responses',
  'gpt-6-luna': 'openai-responses',
  'grok-4.7': 'openai-responses',
  hy3: 'openai-completions',
  'hy4-preview': 'openai-completions',
  'kimi-k2.7-code': 'openai-completions',
  'kimi-k3': 'openai-completions',
  'longcat-2.0': 'openai-completions',
  'longcat-2.5-preview-free': 'openai-completions',
  'mimo-v2.5': 'openai-completions',
  'mimo-v2.5-pro': 'openai-completions',
  'mimo-v2.6-flash': 'openai-completions',
  'mimo-v2.6-pro': 'openai-completions',
  'minimax-m3': 'anthropic-messages',
  'muse-spark-1.2-contributor': 'openai-responses',
  'muse-spark-1.3-contributor': 'openai-responses',
  'qwen3.7-plus': 'anthropic-messages',
  'qwen3.8-flash': 'anthropic-messages',
  'qwen3.8-max': 'anthropic-messages',
  'space-bunny': 'openai-completions',
  'step-5-preview-free': 'openai-completions',
})

const CATALOG_PROVIDERS = Object.freeze({
  'opencode-go': EMBEDDED_OPENCODE_GO,
  opencode: EMBEDDED_OPENCODE_GO,
})

/** Candidate catalog files: the exact path inside the running installation. */
function catalogCandidates(provider) {
  const relative = `dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/${provider}.json`
  const candidates = []
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : null
  if (resources !== null) candidates.push(`${resources}/app.asar/${relative}`)
  const execDir = typeof process.execPath === 'string' ? process.execPath.replace(/[\\/][^\\/]+$/, '') : null
  if (execDir !== null) {
    candidates.push(`${execDir}/resources/app.asar/${relative}`)
    candidates.push(`${execDir}/../resources/app.asar/${relative}`)
    candidates.push(`${execDir}/${relative}`)
    candidates.push(`${execDir}/../${relative}`)
  }
  const argv = process.argv[1]
  if (typeof argv === 'string') {
    const start = argv.replace(/[\\/][^\\/]+$/, '')
    candidates.push(`${start}/${relative}`)
    candidates.push(`${start}/../${relative}`)
  }
  return candidates
}

/** Flatten one installed catalog JSON document into model → protocol entries. */
function flattenCatalog(document) {
  const map = new Map()
  if (typeof document !== 'object' || document === null) return map
  for (const [protocol, group] of Object.entries(document)) {
    if (typeof group !== 'object' || group === null) continue
    for (const entry of Object.values(group)) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = typeof entry.id === 'string' ? entry.id : null
      if (id === null || id.length === 0) continue
      const api = typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : protocol
      map.set(id, { api, baseURL: typeof entry.baseUrl === 'string' ? entry.baseUrl : null })
    }
  }
  return map
}

/**
 * Create the protocol lookup used by account key injection.
 * @param {{readFile?: (file: string) => string}} [options] - injection points for tests.
 * @returns {object} the lookup.
 */
export function createModelProtocolLookup(options = {}) {
  const readFile = typeof options.readFile === 'function' ? options.readFile : (file) => fs.readFileSync(file, 'utf8')
  const cache = new Map()

  const load = (provider) => {
    if (cache.has(provider)) return cache.get(provider)
    let loaded = null
    for (const candidate of catalogCandidates(provider)) {
      try {
        const flattened = flattenCatalog(JSON.parse(readFile(candidate)))
        if (flattened.size > 0) {
          loaded = { map: flattened, source: 'installation', file: candidate }
          break
        }
      } catch {
        // Try the next candidate, then the embedded snapshot.
      }
    }
    if (loaded === null) {
      const embedded = CATALOG_PROVIDERS[provider]
      loaded = {
        map: new Map(embedded === undefined ? [] : Object.entries(embedded).map(([id, api]) => [id, { api, baseURL: null }])),
        source: embedded === undefined ? 'unknown' : 'embedded',
        file: null,
      }
    }
    cache.set(provider, loaded)
    return loaded
  }

  /**
   * Resolve the wire protocol for one exact model id.
   * @param {string} provider - provider route id.
   * @param {string} model - model id.
   * @returns {string} the protocol id; `openai-completions` for unknown models.
   */
  const apiFor = (provider, model) => {
    const entry = load(provider).map.get(model)
    return entry !== undefined && typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : 'openai-completions'
  }

  /** Describe where lookups came from, for the settings page diagnostics. */
  const status = () => {
    const providers = {}
    for (const provider of Object.keys(CATALOG_PROVIDERS)) {
      const loaded = load(provider)
      providers[provider] = { source: loaded.source, models: loaded.map.size, file: loaded.file }
    }
    return providers
  }

  return { apiFor, status, reload: () => cache.clear() }
}

/** Exposed for tests: the embedded snapshot itself is not mutated. */
export const EMBEDDED_OPENCODE_GO_PROTOCOLS = EMBEDDED_OPENCODE_GO
