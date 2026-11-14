/**
 * Pure fallback-engine core for `dsh-fallback`.
 *
 * Nothing in this module touches Cordis, the filesystem, or a network: the
 * Host plugin passes in the live request, the resolved chain, a health store,
 * and a one-attempt dispatch function, and this module decides the attempt
 * order, buffers pre-content chunks so a failed attempt stays invisible, and
 * reports every settled attempt through `onEvent`.
 *
 * The stream contract mirrors `@deepseek-ai/dsh-llm`: an async iterable of
 * `StreamChunk`s whose terminal element is `{ type: 'finish', reason }`.
 * Adapter failures arrive as `reason.kind === 'error'` with `reason.failure`.
 *
 * @module dsh-fallback/engine
 */

import { DEFAULT_ACCOUNT_MODE, normalizeAccountMode } from './rotation.mjs'

/** Failure codes that mean "this router's quota/limit is exhausted" by default. */
export const DEFAULT_FALLBACK_CODES = Object.freeze(['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT'])

/** Every code a user may add to the fallback set from the settings page. */
export const KNOWN_FALLBACK_CODES = Object.freeze([
  'QUOTA',
  'ACCOUNT_QUOTA',
  'RATE_LIMIT',
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'CONTEXT_WINDOW_EXCEEDED',
])

/** Cooldown windows used when a provider reports no retry-after hint. */
export const DEFAULT_COOLDOWNS = Object.freeze({
  QUOTA: 30 * 60 * 1000,
  ACCOUNT_QUOTA: 30 * 60 * 1000,
  RATE_LIMIT: 60 * 1000,
  AUTH: 10 * 60 * 1000,
  INVALID_CREDENTIAL: 10 * 60 * 1000,
  MISSING_CREDENTIAL: 10 * 60 * 1000,
  SERVER: 60 * 1000,
  TIMEOUT: 30 * 1000,
  TRANSPORT: 30 * 1000,
})

/**
 * Validate one chain entry.
 * @param {unknown} value - candidate from config/state.
 * @returns {{provider: string, model: string, label?: string} | null} a normalized entry or null.
 */
export function normalizeChainEntry(value) {
  if (typeof value !== 'object' || value === null) return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider.length === 0) return null
  const entry = { provider, model }
  if (typeof value.label === 'string' && value.label.trim().length > 0) entry.label = value.label.trim()
  return entry
}

/**
 * Normalize a user-supplied chain list: drop invalid entries and de-duplicate
 * by provider (the first occurrence wins, because the chain is a priority list
 * and one route cannot sit at two priorities at once).
 * @param {unknown} chain - candidate chain.
 * @returns {Array<{provider: string, model: string, label?: string}>} normalized copy.
 */
export function normalizeChain(chain) {
  if (!Array.isArray(chain)) return []
  const seen = new Set()
  const out = []
  for (const raw of chain) {
    const entry = normalizeChainEntry(raw)
    if (entry === null || seen.has(entry.provider)) continue
    seen.add(entry.provider)
    out.push(entry)
  }
  return out
}

/**
 * Resolve the effective fallback configuration from layered inputs:
 * built-in defaults, then the bundle row's Config, then user overrides stored
 * in the plugin's own state file.
 * @param {object} [defaults] - built-in defaults (normally `DEFAULT_CONFIG`).
 * @param {object} [rowConfig] - `config` of the plugin's Loader row.
 * @param {object} [overrides] - user overrides persisted by the settings page.
 * @returns {object} a frozen, fully-populated configuration.
 */
export function resolveConfig(defaults, rowConfig, overrides) {
  const base = defaults ?? DEFAULT_CONFIG
  const layer = (value) => (typeof value === 'object' && value !== null ? value : {})
  const merged = { ...base, ...layer(rowConfig), ...layer(overrides) }
  const codes = Array.isArray(merged.fallbackCodes)
    ? merged.fallbackCodes.filter((code) => typeof code === 'string' && code.length > 0)
    : [...base.fallbackCodes]
  const chain = normalizeChain(merged.chain)
  const maxAttempts = clampInt(merged.maxAttempts, 1, 8, base.maxAttempts)
  return Object.freeze({
    enabled: merged.enabled !== false,
    chain,
    accountMode: normalizeAccountMode(merged.accountMode),
    fallbackCodes: Object.freeze(codes),
    maxAttempts,
    cooldowns: Object.freeze({ ...base.cooldowns, ...layer(merged.cooldowns) }),
    probeTimeoutMs: clampInt(merged.probeTimeoutMs, 1000, 120000, base.probeTimeoutMs),
    logLimit: clampInt(merged.logLimit, 0, 200, base.logLimit),
    cooldownDefaults: DEFAULT_COOLDOWNS,
  })
}

/** Default configuration shipped with the plugin. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  chain: Object.freeze([]),
  accountMode: DEFAULT_ACCOUNT_MODE,
  fallbackCodes: DEFAULT_FALLBACK_CODES,
  maxAttempts: 3,
  cooldowns: Object.freeze({}),
  probeTimeoutMs: 30000,
  logLimit: 50,
})

/** Clamp an integer into an inclusive range, falling back when not a number. */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Decide the ordered attempts for one request.
 *
 * The chain is a priority list. When the selected provider is present in the
 * chain, attempts start at that entry and continue down the list; entries
 * above it are a higher priority the user deliberately stepped over. When the
 * selected provider is not in the chain, it is tried first and the whole chain
 * follows as the fallback list. Routes that are inside their cooldown are
 * skipped; if every route is cooling down, the selected route is attempted
 * alone so the failure the user sees is the provider's real one.
 *
 * @param {object} input - request context.
 * @param {string} input.provider - provider route selected for this request.
 * @param {string} input.model - model selected for this request.
 * @param {ReadonlyArray<object>} input.chain - resolved chain.
 * @param {{isDegraded: (provider: string, now: number) => boolean}} input.health - health store.
 * @param {ReadonlyArray<string>} input.fallbackCodes - codes that trigger a fallback.
 * @param {number} input.maxAttempts - cap on attempts.
 * @param {number} [input.now] - clock override for tests.
 * @param {boolean} [input.ignoreHealth] - plan every route, even cooling-down ones
 *   (the self-test uses this to test the chain itself rather than the current state).
 * @returns {Array<{provider: string, model: string, origin: 'selected' | 'chain', chainIndex?: number, inherited?: boolean}>} attempts.
 */
export function planAttempts(input) {
  const now = input.now ?? Date.now()
  const selected = { provider: input.provider, model: input.model, origin: 'selected' }
  const chain = Array.isArray(input.chain) ? input.chain : []
  const accountsByProvider =
    typeof input.accountsByProvider === 'object' && input.accountsByProvider !== null ? input.accountsByProvider : {}
  const selectedAccounts =
    Array.isArray(input.accounts) && input.accounts.length > 0
      ? input.accounts
      : Array.isArray(accountsByProvider[input.provider])
        ? accountsByProvider[input.provider]
        : []
  const accountsFor = (provider) =>
    provider === input.provider
      ? selectedAccounts
      : Array.isArray(accountsByProvider[provider])
        ? accountsByProvider[provider]
        : []
  const candidates = []
  const selectedIndex = chain.findIndex((entry) => entry.provider === input.provider)
  const pushChainEntry = (entry, index) => {
    const pooled = accountsFor(entry.provider)
    if (pooled.length > 0) {
      const inherited = entry.model.length === 0
      for (const account of pooled) {
        candidates.push(accountCandidate(entry.provider, inherited ? input.model : entry.model, account, index, inherited))
      }
      return
    }
    candidates.push(chainCandidate(entry, index, input.model))
  }
  if (selectedAccounts.length > 0) {
    // The selected route is served by pooled accounts: try its accounts in
    // order first, then the chain routes below it. The route's own chain entry
    // is already represented by its accounts, so it is not repeated.
    for (const account of selectedAccounts) {
      candidates.push(accountCandidate(input.provider, input.model, account))
    }
    const start = selectedIndex >= 0 ? selectedIndex : 0
    for (let index = start; index < chain.length; index += 1) {
      if (chain[index].provider === input.provider) continue
      pushChainEntry(chain[index], index)
    }
  } else if (selectedIndex >= 0) {
    for (let index = selectedIndex; index < chain.length; index += 1) {
      const entry = chain[index]
      if (entry.provider === input.provider) {
        candidates.push({ provider: entry.provider, model: input.model, origin: 'chain', chainIndex: index })
        continue
      }
      pushChainEntry(entry, index)
    }
  } else {
    candidates.push(selected)
    for (let index = 0; index < chain.length; index += 1) pushChainEntry(chain[index], index)
  }
  const deduped = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (candidate.provider.length === 0) continue
    const key = candidate.attemptKey ?? `${candidate.provider}\u0000${candidate.model ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(candidate)
  }
  const healthKeyOf = (candidate) => candidate.healthKey ?? candidate.provider
  const healthy =
    input.ignoreHealth === true
      ? deduped
      : deduped.filter((candidate) => !input.health.isDegraded(healthKeyOf(candidate), now))
  const chosen = healthy.length > 0 ? healthy : deduped.slice(0, 1)
  return chosen.slice(0, input.maxAttempts)
}

/** Build one pooled-account candidate for a route (selected or chain). */
function accountCandidate(provider, model, account, chainIndex, inherited) {
  const candidate = {
    provider,
    model,
    origin: 'account',
    accountId: account.id,
    accountLabel: account.label,
    accountKind: account.kind,
    healthKey: account.healthKey,
    attemptKey: `${provider}\u0000${model}\u0000${account.id}`,
  }
  if (chainIndex !== undefined) candidate.chainIndex = chainIndex
  if (inherited === true) candidate.inherited = true
  return candidate
}

/** Build one chain candidate, inheriting the request's model when the entry has none. */
function chainCandidate(entry, index, requestModel) {
  const candidate = {
    provider: entry.provider,
    model: entry.model.length > 0 ? entry.model : requestModel,
    origin: 'chain',
    chainIndex: index,
  }
  if (entry.model.length === 0) candidate.inherited = true
  return candidate
}

/**
 * Whether one terminal failure should move the request to the next route.
 * @param {{code?: string} | undefined} failure - terminal `LlmFailure`.
 * @param {ReadonlyArray<string>} fallbackCodes - configured trigger codes.
 * @returns {boolean} true when the code is in the trigger set.
 */
export function isFallbackFailure(failure, fallbackCodes) {
  if (failure === undefined || failure === null) return false
  if (typeof failure.code !== 'string' || failure.code.length === 0) return false
  return fallbackCodes.includes(failure.code)
}

/**
 * Compute how long a provider should be skipped after a failure.
 * A provider-supplied `providerRetryAfterMs` wins; otherwise the configured
 * per-code cooldown, then the built-in default, applies.
 * @param {{code?: string, providerRetryAfterMs?: number} | undefined} failure - terminal failure.
 * @param {object} config - resolved configuration.
 * @param {object} [defaults] - cooldown defaults (tests may override).
 * @returns {number} cooldown in milliseconds (never negative).
 */
export function cooldownFor(failure, config, defaults) {
  const hint = failure?.providerRetryAfterMs
  if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0) return Math.trunc(hint)
  const code = failure?.code ?? 'UNKNOWN'
  const configured = config?.cooldowns?.[code]
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) return Math.trunc(configured)
  const fallback = (defaults ?? DEFAULT_COOLDOWNS)[code]
  return typeof fallback === 'number' ? fallback : 60 * 1000
}

/**
 * Create the shared provider-health store.
 *
 * Degradation is a timer, not a permanent verdict: a route that reported an
 * exhausted quota is skipped until `degradedUntil`, then tried again. Success
 * clears the record immediately.
 * @param {object} [options] - store options.
 * @param {() => number} [options.now] - clock override for tests.
 * @returns {object} the health store.
 */
export function createHealthStore(options = {}) {
  const clock = options.now ?? Date.now
  /** @type {Map<string, {until: number, code: string, message: string, since: number}>} */
  const degraded = new Map()
  const stats = new Map()
  const isDegraded = (provider, now = clock()) => {
    const record = degraded.get(provider)
    if (record === undefined) return false
    if (record.until <= now) {
      degraded.delete(provider)
      return false
    }
    return true
  }
  const markFailure = (provider, failure, cooldownMs) => {
    const now = clock()
    const record = {
      until: now + Math.max(0, Math.trunc(cooldownMs)),
      code: typeof failure?.code === 'string' ? failure.code : 'UNKNOWN',
      message: typeof failure?.message === 'string' ? failure.message.slice(0, 500) : '',
      since: now,
    }
    degraded.set(provider, record)
    const entry = statsEntry(stats, provider)
    entry.failures += 1
    entry.lastFailureAt = now
    entry.lastCode = record.code
    return record
  }
  const markSuccess = (provider) => {
    degraded.delete(provider)
    const entry = statsEntry(stats, provider)
    entry.successes += 1
    entry.lastSuccessAt = clock()
  }
  const markAttempt = (provider) => {
    const entry = statsEntry(stats, provider)
    entry.requests += 1
    entry.lastAttemptAt = clock()
  }
  const reset = () => {
    degraded.clear()
  }
  const snapshot = (now = clock()) => {
    pruneExpired(degraded, now)
    const providers = {}
    for (const [provider, record] of degraded) providers[provider] = { ...record }
    const counters = {}
    for (const [provider, entry] of stats) counters[provider] = { ...entry }
    return { degraded: providers, stats: counters }
  }
  const hydrate = (state) => {
    if (typeof state !== 'object' || state === null) return
    if (typeof state.degraded === 'object' && state.degraded !== null) {
      for (const [provider, record] of Object.entries(state.degraded)) {
        if (typeof record !== 'object' || record === null) continue
        const until = Number(record.until)
        if (!Number.isFinite(until)) continue
        degraded.set(provider, {
          until,
          code: typeof record.code === 'string' ? record.code : 'UNKNOWN',
          message: typeof record.message === 'string' ? record.message : '',
          since: Number.isFinite(Number(record.since)) ? Number(record.since) : until,
        })
      }
    }
    if (typeof state.stats === 'object' && state.stats !== null) {
      for (const [provider, entry] of Object.entries(state.stats)) {
        if (typeof entry !== 'object' || entry === null) continue
        const target = statsEntry(stats, provider)
        for (const key of ['requests', 'successes', 'failures']) {
          if (Number.isFinite(Number(entry[key]))) target[key] = Number(entry[key])
        }
        if (Number.isFinite(Number(entry.lastAttemptAt))) target.lastAttemptAt = Number(entry.lastAttemptAt)
        if (Number.isFinite(Number(entry.lastSuccessAt))) target.lastSuccessAt = Number(entry.lastSuccessAt)
        if (Number.isFinite(Number(entry.lastFailureAt))) target.lastFailureAt = Number(entry.lastFailureAt)
        if (typeof entry.lastCode === 'string') target.lastCode = entry.lastCode
      }
    }
  }
  return { isDegraded, markFailure, markSuccess, markAttempt, reset, snapshot, hydrate }
}

/** Return the mutable stats bucket for one provider, creating it on first use. */
function statsEntry(stats, provider) {
  let entry = stats.get(provider)
  if (entry === undefined) {
    entry = { requests: 0, successes: 0, failures: 0 }
    stats.set(provider, entry)
  }
  return entry
}

/** Drop expired degradation records so the snapshot cannot grow without bound. */
function pruneExpired(degraded, now) {
  for (const [provider, record] of degraded) if (record.until <= now) degraded.delete(provider)
}

/**
 * Anything that is not a terminal frame and carries user-visible output counts
 * as content. Once content is emitted a retry would duplicate visible text, so
 * the engine stops falling back at that point.
 * @param {{type?: string}} chunk - one stream chunk.
 * @returns {boolean} true for content-bearing chunks.
 */
export function isContentChunk(chunk) {
  if (typeof chunk !== 'object' || chunk === null) return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-call-delta':
    case 'block-end':
      return true
    default:
      return false
  }
}

/**
 * Build a terminal error finish chunk, preserving the failure envelope.
 * @param {{code?: string, message?: string, status?: number, providerRetryAfterMs?: number}} failure - source failure.
 * @param {string} [suffix] - text appended to the message.
 * @returns {{type: 'finish', reason: {kind: 'error', failure: object}}} a finish chunk.
 */
export function errorFinish(failure, suffix) {
  const message = typeof failure?.message === 'string' && failure.message.length > 0 ? failure.message : 'model request failed'
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        ...failure,
        message: suffix === undefined ? message : `${message} ${suffix}`,
        code: typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN',
      },
    },
  }
}

/**
 * Drop provider-native reasoning blocks from conversation history.
 *
 * Reasoning/thinking blocks are only replayable on the provider that emitted
 * them. When an attempt moves to a different router, keeping them makes the
 * target reject the whole history (for example DeepSeek's thinking mode
 * demands its own thinking blocks back). Assistant messages that carried only
 * reasoning disappear; every other block (text, tool calls) is preserved.
 *
 * @param {ReadonlyArray<object>} messages - request messages.
 * @returns {ReadonlyArray<object>} the same array when nothing changed, else a filtered copy.
 */
export function stripReasoningBlocks(messages) {
  if (!Array.isArray(messages)) return messages
  let changed = false
  const out = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || message.role !== 'assistant' || !Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    const content = message.content.filter((block) => block === null || typeof block !== 'object' || block.type !== 'reasoning')
    if (content.length === message.content.length) {
      out.push(message)
      continue
    }
    changed = true
    if (content.length === 0) continue
    out.push({ ...message, content })
  }
  return changed ? out : messages
}

/**
 * Drop request controls the target route cannot honor.
 *
 * `reasoningEffort` is validated before dispatch and would reject the attempt
 * outright on a route that does not offer the same level, so an attempt that
 * moves to another router keeps the request but clears controls the target
 * model does not advertise.
 *
 * A cross-provider attempt additionally drops provider-native reasoning
 * history and, when the target advertises an `off` level, pins reasoning off:
 * the target cannot continue another provider's thinking mode, and disabling
 * it is what keeps the request answerable instead of failing on history it
 * never produced.
 *
 * @param {object} options - original GenerateOptions.
 * @param {{reasoning?: {efforts?: ReadonlyArray<{id: string}>}, defaultMaxTokens?: number} | undefined} modelInfo - resolved target model info, when known.
 * @param {{crossProvider?: boolean}} [context] - whether the target differs from the request's provider.
 * @returns {object} a shallow-copied options object (the caller owns it).
 */
export function sanitizeAttemptOptions(options, modelInfo, context = {}) {
  const next = { ...options }
  const crossProvider = context.crossProvider === true
  if (crossProvider) next.messages = stripReasoningBlocks(next.messages)
  const efforts = Array.isArray(modelInfo?.reasoning?.efforts) ? modelInfo.reasoning.efforts : null
  if (next.reasoningEffort !== undefined && modelInfo?.reasoning !== undefined) {
    const supports = efforts !== null && efforts.some((effort) => effort?.id === next.reasoningEffort)
    if (!supports) delete next.reasoningEffort
  }
  if (crossProvider) {
    if (efforts !== null && efforts.some((effort) => effort?.id === 'off')) next.reasoningEffort = 'off'
    else if (efforts === null || modelInfo?.reasoning === undefined) delete next.reasoningEffort
    else delete next.reasoningEffort
  }
  return next
}

/**
 * Map `planAttempts` output into dispatch descriptors, adding the model id used
 * for model-info resolution.
 * @param {ReadonlyArray<object>} attempts - planned attempts.
 * @returns {Array<{provider: string, model: string, origin: string, chainIndex?: number}>} dispatch descriptors.
 */
export function describeAttempts(attempts) {
  return attempts.map((attempt) => ({ ...attempt }))
}

/**
 * Render one human-readable attempt label.
 * @param {{provider: string, model: string}} attempt - attempt descriptor.
 * @returns {string} `provider/model`.
 */
export function attemptLabel(attempt) {
  return `${attempt.provider}/${attempt.model}`
}

/**
 * Append an event to a bounded ring buffer (oldest first, newest last).
 * @param {Array<object>} buffer - mutable ring buffer.
 * @param {object} event - event to append.
 * @param {number} limit - maximum retained events (0 disables logging).
 * @returns {Array<object>} the same buffer for chaining.
 */
export function pushBounded(buffer, event, limit) {
  if (!Array.isArray(buffer) || limit <= 0) return buffer
  buffer.push(event)
  while (buffer.length > limit) buffer.shift()
  return buffer
}

/**
 * Run the fallback chain for one request.
 *
 * The first attempt is dispatched through the caller-supplied `dispatch`
 * (which forwards to the next waterfall listener, i.e. the real adapter); a
 * later attempt re-dispatches `{...options, provider, model}` through the same
 * function, which the Host wires to a fresh `llm.stream()` call. Chunks are
 * buffered until the first content-bearing chunk of an attempt succeeds, so a
 * failed attempt that produced only framing chunks leaves no visible trace.
 *
 * The generator never throws for provider failures; it always ends with a
 * terminal `finish` chunk, exactly like the LLM service contract.
 *
 * @param {object} input - stream context.
 * @param {object} input.options - original GenerateOptions.
 * @param {ReadonlyArray<object>} input.attempts - planned attempts (non-empty).
 * @param {ReadonlyArray<string>} input.fallbackCodes - trigger codes.
 * @param {(descriptor: {attempt: object, options: object, index: number}) => AsyncIterable<object>} input.dispatch - one-attempt dispatcher.
 * @param {(event: object) => void} [input.onEvent] - attempt lifecycle sink.
 * @param {{aborted?: boolean} | undefined} [input.signal] - abort signal (optional).
 * @returns {AsyncGenerator<object>} the chunk stream.
 */
export async function* runFallbackStream(input) {
  const { options, attempts, fallbackCodes, dispatch, onEvent } = input
  if (!Array.isArray(attempts) || attempts.length === 0) {
    yield errorFinish({ code: 'NO_ROUTE', message: 'dsh-fallback: no attempt was planned for this request' })
    return
  }
  let lastFailure = null
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    if (input.signal?.aborted === true) {
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { code: 'ABORTED', message: 'model request aborted before the fallback attempt' },
        },
      }
      return
    }
    const attemptOptions = index === 0 ? options : { ...options, provider: attempt.provider, model: attempt.model }
    const startedAt = Date.now()
    if (typeof onEvent === 'function') onEvent({ type: 'attempt-start', attempt, index })
    const buffered = []
    let streaming = false
    let finish = null
    for await (const chunk of dispatch({ attempt, options: attemptOptions, index })) {
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') {
        finish = chunk
        break
      }
      if (streaming) {
        yield chunk
        continue
      }
      buffered.push(chunk)
      if (isContentChunk(chunk)) {
        streaming = true
        for (const pending of buffered) yield pending
        buffered.length = 0
      }
    }
    if (finish === null) {
      finish = errorFinish(
        { code: 'TRANSPORT', message: `dsh-fallback: the stream for "${attempt.provider}" ended without a finish chunk` },
      )
    }
    const latencyMs = Date.now() - startedAt
    const reason = finish.reason ?? { kind: 'error', failure: { code: 'UNKNOWN', message: 'missing finish reason' } }
    if (reason.kind !== 'error') {
      if (typeof onEvent === 'function') onEvent({ type: 'attempt-succeeded', attempt, index, latencyMs })
      for (const pending of buffered) yield pending
      yield finish
      return
    }
    const failure = reason.failure ?? { code: 'UNKNOWN', message: 'unknown model failure' }
    lastFailure = failure
    const eligible = isFallbackFailure(failure, fallbackCodes)
    const hasNext = index < attempts.length - 1
    if (typeof onEvent === 'function') {
      onEvent({
        type: 'attempt-failed',
        attempt,
        index,
        failure,
        eligible,
        hasNext,
        latencyMs,
      })
    }
    if (streaming || !eligible || !hasNext) {
      for (const pending of buffered) yield pending
      // When earlier routes were already bypassed, name the chain in the
      // failure the user finally sees; the code stays the provider's own so
      // the loop's retry policy still recognises it.
      yield index > 0 ? errorFinish(failure, '[dsh-fallback: fallback chain exhausted]') : finish
      return
    }
    // Drop the buffered framing chunks: the next route restarts the message.
    buffered.length = 0
  }
  const failure = lastFailure ?? { code: 'NO_ROUTE', message: 'dsh-fallback: no route answered' }
  yield errorFinish(failure, '[dsh-fallback: fallback chain exhausted]')
}
