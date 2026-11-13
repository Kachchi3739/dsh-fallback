/**
 * dsh-fallback — Host half.
 *
 * A transparent router fallback for the DeepSeek Harness LLM service: when the
 * selected router (LLM provider route) reports an exhausted quota or limit,
 * the request is re-dispatched to the next router in the user's chain, using
 * the routes already connected to this Harness profile.
 *
 * The plugin attaches one `llm/stream` waterfall listener. It plans the attempt
 * order, buffers pre-content chunks so a rejected attempt never becomes visible
 * text, marks a rejected route as cooling down, and exposes a small same-origin
 * HTTP API consumed by the settings page (`client.js`).
 *
 * @module dsh-fallback
 */

import { randomUUID } from 'node:crypto'

import {
  DEFAULT_CONFIG,
  cooldownFor,
  createHealthStore,
  planAttempts,
  resolveConfig,
  runFallbackStream,
  sanitizeAttemptOptions,
} from './lib/engine.mjs'
import { createProviderCatalog, describeProviders, resolveChainModels, PROBE_PROVIDER } from './lib/providers.mjs'
import {
  PROBE_CHAIN,
  PROBE_LOG,
  collectProbeStream,
  createProbeAdapter,
  probeRequest,
} from './lib/probe.mjs'
import {
  createEventLog,
  createStateWriter,
  loadState,
  mergeOverrides,
  normalizeOverrides,
  resolveStateFile,
} from './lib/state.mjs'

/** Must match `version` in package.json (asserted by the test suite). */
export const PLUGIN_VERSION = '1.0.0'

/** Same-origin HTTP prefix consumed by `client.js`. */
const ROUTE_PREFIX = '/dsh-fallback'

/** Host services this plugin needs. */
export const inject = ['llm', 'webServer']

/** Identity for the Loader/HMR layer. */
export const name = 'dsh-fallback'

/** Answer returned when a config/write cannot be persisted. */
const READONLY_HINT = 'the profile state file is not writable; the change applies to this process only'

export function apply(ctx, rawConfig = {}) {
  const rowConfig = typeof rawConfig === 'object' && rawConfig !== null ? rawConfig : {}
  const llm = ctx.llm
  const stateFile = resolveStateFile()
  const persisted = loadState(stateFile)
  const health = createHealthStore()
  health.hydrate(persisted.health)
  const events = createEventLog(persisted.events)
  const catalog = createProviderCatalog({ llm })
  /** Runtime mutable configuration layer owned by the settings page. */
  const runtime = {
    overrides: normalizeOverrides(persisted.overrides),
    lastResult: null,
    lastError: null,
  }
  const writer = createStateWriter(stateFile, () => ({
    overrides: runtime.overrides,
    health: health.snapshot(),
    events: events.snapshot(),
  }))
  const internalRequests = new WeakMap()
  let probeInFlight = false

  const currentConfig = () => resolveConfig(DEFAULT_CONFIG, rowConfig, runtime.overrides)

  const persist = () => writer.schedule()

  // ---------------------------------------------------------------------
  // Attempt bookkeeping (health, event log, last result)
  // ---------------------------------------------------------------------

  const recordAttemptEvent = (event, attempts, options, config) => {
    if (event.type === 'attempt-start') {
      health.markAttempt(event.attempt.provider)
      return
    }
    const attempt = event.attempt
    if (event.type === 'attempt-failed') {
      const eligible = event.eligible === true
      // Only an exhausted/ineligible-free route is cooled down: a bad request
      // (INVALID_REQUEST and friends) says nothing about route health, but a
      // zero-length window still records the failure in the stats.
      health.markFailure(attempt.provider, event.failure, eligible ? cooldownFor(event.failure, config) : 0)
      const next = attempts[event.index + 1]
      events.record({
        kind: eligible && next !== undefined ? 'fallback' : 'failure',
        sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
        from: { provider: attempt.provider, model: attempt.model },
        to: next === undefined ? null : { provider: next.provider, model: next.model },
        code: typeof event.failure?.code === 'string' ? event.failure.code : 'UNKNOWN',
        message: typeof event.failure?.message === 'string' ? event.failure.message.slice(0, 240) : '',
        latencyMs: event.latencyMs,
      })
      runtime.lastResult = {
        at: new Date().toISOString(),
        kind: eligible ? 'fallback' : 'failure',
        from: { provider: attempt.provider, model: attempt.model },
        to: next === undefined ? null : { provider: next.provider, model: next.model },
        code: typeof event.failure?.code === 'string' ? event.failure.code : 'UNKNOWN',
      }
      persist()
      return
    }
    if (event.type === 'attempt-succeeded') {
      health.markSuccess(attempt.provider)
      if (event.index > 0) {
        events.record({
          kind: 'answered',
          sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
          from: null,
          to: { provider: attempt.provider, model: attempt.model },
          code: null,
          message: '',
          latencyMs: event.latencyMs,
        })
      }
      runtime.lastResult = {
        at: new Date().toISOString(),
        kind: 'answered',
        from: null,
        to: { provider: attempt.provider, model: attempt.model },
        code: null,
      }
      persist()
    }
  }

  const recordProbeEvent = (log, event) => {
    if (event.type === 'attempt-start') {
      log.attempts.push({
        provider: event.attempt.provider,
        model: event.attempt.model,
        origin: event.attempt.origin,
        ok: null,
      })
      return
    }
    const record = log.attempts[event.index]
    if (record === undefined) return
    if (event.type === 'attempt-failed') {
      record.ok = false
      record.code = typeof event.failure?.code === 'string' ? event.failure.code : 'UNKNOWN'
      record.message = typeof event.failure?.message === 'string' ? event.failure.message.slice(0, 240) : ''
      record.latencyMs = event.latencyMs
      return
    }
    if (event.type === 'attempt-succeeded') {
      record.ok = true
      record.latencyMs = event.latencyMs
    }
  }

  // ---------------------------------------------------------------------
  // The intercepting stream listener
  // ---------------------------------------------------------------------

  const reDispatch = async function* (attempt, baseOptions, crossProvider) {
    const info = await catalog.modelInfo(attempt.provider, attempt.model)
    const sanitized = sanitizeAttemptOptions(
      { ...baseOptions, provider: attempt.provider, model: attempt.model },
      info === null ? undefined : info,
      { crossProvider },
    )
    internalRequests.set(sanitized, true)
    yield* llm.stream(sanitized)
  }

  const fallbackStream = async function* (options, next) {
    if (options === null || typeof options !== 'object' || typeof options.provider !== 'string') {
      yield* next()
      return
    }
    if (internalRequests.get(options) === true) {
      yield* next()
      return
    }
    const probeLog = options[PROBE_LOG]
    const config = currentConfig()
    if (!config.enabled && probeLog === undefined) {
      yield* next()
      return
    }
    const probeChain = options[PROBE_CHAIN]
    const chain = Array.isArray(probeChain) && probeChain.length > 0 ? probeChain : config.chain
    const maxAttempts =
      probeLog === undefined ? config.maxAttempts : Math.min(8, Math.max(config.maxAttempts, chain.length + 1))
    let attempts = planAttempts({
      provider: options.provider,
      model: options.model,
      chain,
      health,
      fallbackCodes: config.fallbackCodes,
      maxAttempts,
      ignoreHealth: probeLog !== undefined,
    })
    if (attempts.some((attempt) => attempt.inherited === true)) {
      const checked = []
      for (const attempt of attempts) {
        if (attempt.inherited !== true) {
          checked.push(attempt)
          continue
        }
        const advertised = await catalog.hasModel(attempt.provider, attempt.model)
        if (advertised === false) continue
        checked.push(attempt)
      }
      attempts = checked.length > 0 ? checked : attempts.slice(0, 1)
    }
    const hasFallback =
      attempts.length > 1 ||
      (attempts.length === 1 && (attempts[0].provider !== options.provider || attempts[0].model !== options.model))
    if (!hasFallback) {
      yield* next()
      return
    }
    let nextConsumed = false
    const dispatch = ({ attempt, options: attemptOptions }) => {
      if (!nextConsumed && attempt.provider === options.provider && attempt.model === options.model) {
        nextConsumed = true
        return next()
      }
      return reDispatch(attempt, attemptOptions, attempt.provider !== options.provider)
    }
    const onEvent = (event) => {
      if (probeLog !== undefined) {
        recordProbeEvent(probeLog, event)
        return
      }
      recordAttemptEvent(event, attempts, options, config)
    }
    yield* runFallbackStream({
      options,
      attempts,
      fallbackCodes: config.fallbackCodes,
      dispatch,
      onEvent,
      signal: options.signal,
    })
  }

  ctx.on('llm/stream', fallbackStream)

  // ---------------------------------------------------------------------
  // Self-test: force one probe failure and prove the next router answers
  // ---------------------------------------------------------------------

  const probeSessionId = () => {
    try {
      const agents = ctx.get('agents')
      if (agents !== undefined && typeof agents.list === 'function') {
        const live = agents.list()
        const id = Array.isArray(live) && live.length > 0 ? live[0]?.id : undefined
        if (typeof id === 'string' && id.length > 0) return id
      }
    } catch {
      // The agents service is optional for the self-test.
    }
    try {
      return randomUUID()
    } catch {
      return `dsh-fallback-probe-${Date.now()}`
    }
  }

  const runSelfTest = async () => {
    if (probeInFlight) return { ok: false, error: 'busy', message: 'a self-test is already running' }
    const config = currentConfig()
    if (config.chain.length === 0) {
      return { ok: false, error: 'empty-chain', message: 'the fallback chain is empty' }
    }
    const resolvedChain = await resolveChainModels({ catalog, chain: config.chain, fallbackModel: '' })
    if (resolvedChain.length === 0) {
      return { ok: false, error: 'unresolved-chain', message: 'no chain entry has a usable model id' }
    }
    probeInFlight = true
    let disposeProbe = null
    const startedAt = Date.now()
    const log = { attempts: [] }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.probeTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      disposeProbe = llm.registerAdapter([PROBE_PROVIDER], createProbeAdapter())
    } catch (error) {
      probeInFlight = false
      clearTimeout(timer)
      return { ok: false, error: 'probe-unavailable', message: messageOf(error) }
    }
    try {
      const stream = llm.stream(probeRequest({ log, chain: resolvedChain, signal: controller.signal, sessionId: probeSessionId() }))
      const outcome = await collectProbeStream(stream)
      const finish = outcome.finish
      const answered = log.attempts.find((attempt) => attempt.ok === true) ?? null
      const failure = finish?.reason?.kind === 'error' ? finish.reason.failure : null
      return {
        ok: failure === null,
        finishKind: finish?.reason?.kind ?? null,
        failure,
        aborted: controller.signal.aborted === true ? true : undefined,
        answered,
        attempts: log.attempts,
        text: typeof outcome.text === 'string' ? outcome.text.slice(0, 500) : '',
        totalMs: Date.now() - startedAt,
      }
    } catch (error) {
      return { ok: false, error: 'probe-failed', message: messageOf(error), attempts: log.attempts }
    } finally {
      clearTimeout(timer)
      try {
        disposeProbe?.()
      } catch (error) {
        ctx.logger?.warn?.('dsh-fallback: probe adapter disposal failed: %o', error)
      }
      probeInFlight = false
    }
  }

  // ---------------------------------------------------------------------
  // Same-origin HTTP API for the settings page
  // ---------------------------------------------------------------------

  const statePayload = async () => {
    const config = currentConfig()
    const healthSnapshot = health.snapshot()
    const { providers, configurable } = await describeProviders({
      catalog,
      health: healthSnapshot,
      chain: config.chain,
    })
    return {
      ok: true,
      version: PLUGIN_VERSION,
      now: Date.now(),
      config: {
        enabled: config.enabled,
        chain: config.chain,
        fallbackCodes: config.fallbackCodes,
        maxAttempts: config.maxAttempts,
        cooldowns: config.cooldowns,
        probeTimeoutMs: config.probeTimeoutMs,
        logLimit: config.logLimit,
      },
      overrides: runtime.overrides,
      defaults: {
        chain: DEFAULT_CONFIG.chain,
        fallbackCodes: DEFAULT_CONFIG.fallbackCodes,
        maxAttempts: DEFAULT_CONFIG.maxAttempts,
      },
      providers,
      configurable,
      health: healthSnapshot,
      events: events.snapshot(),
      lastResult: runtime.lastResult,
      storage: {
        file: stateFile,
        writable: writer.lastError() === null,
        error: writer.lastError(),
      },
    }
  }

  // The web server reaches a named route through one of two shapes: a Fetch
  // `resource` (GET/HEAD only) or a Node `handler(req, res)` that owns the
  // whole exchange. The settings page saves with POST, so this plugin
  // registers one prefix `handler` and answers the JSON API itself.

  const readNodeBody = async (request) => {
    const chunks = []
    let total = 0
    for await (const chunk of request) {
      total += chunk.length
      if (total > 256 * 1024) throw new HttpError(413, 'request body is too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  const parseJsonBody = (text) => {
    if (typeof text !== 'string' || text.trim().length === 0) return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new HttpError(400, 'request body is not valid JSON')
    }
  }

  const applyOverrides = async (body) => {
    if (typeof body?.overrides === 'object' && body.overrides !== null) {
      runtime.overrides = normalizeOverrides(body.overrides)
    } else if (typeof body?.patch === 'object' && body.patch !== null) {
      runtime.overrides = mergeOverrides(runtime.overrides, normalizeOverrides(body.patch))
    } else {
      throw new HttpError(400, 'expected { overrides } or { patch }')
    }
    events.setLimit(currentConfig().logLimit)
    writer.schedule()
    writer.flush()
    if (writer.lastError() !== null) throw new HttpError(500, `${READONLY_HINT}: ${writer.lastError()}`)
    return statePayload()
  }

  const routeApi = async ({ path, searchParams, bodyText }) => {
    if (path === `${ROUTE_PREFIX}/state`) return { status: 200, payload: await statePayload() }
    if (path === `${ROUTE_PREFIX}/models`) {
      const config = currentConfig()
      const { providers, configurable } = await describeProviders({
        catalog,
        health: health.snapshot(),
        chain: config.chain,
        refresh: searchParams.get('refresh') === '1',
      })
      return { status: 200, payload: { ok: true, providers, configurable, now: Date.now() } }
    }
    if (path === `${ROUTE_PREFIX}/config`) {
      return { status: 200, payload: await applyOverrides(parseJsonBody(bodyText)) }
    }
    if (path === `${ROUTE_PREFIX}/selftest`) {
      return { status: 200, payload: { ok: true, result: await runSelfTest(), now: Date.now() } }
    }
    if (path === `${ROUTE_PREFIX}/health/reset`) {
      health.reset()
      runtime.lastResult = null
      writer.schedule()
      writer.flush()
      return { status: 200, payload: await statePayload() }
    }
    if (path === `${ROUTE_PREFIX}/overrides/reset`) {
      runtime.overrides = {}
      events.setLimit(currentConfig().logLimit)
      writer.schedule()
      writer.flush()
      return { status: 200, payload: await statePayload() }
    }
    if (path === `${ROUTE_PREFIX}/events/clear`) {
      events.clear()
      writer.schedule()
      writer.flush()
      return { status: 200, payload: await statePayload() }
    }
    if (path === `${ROUTE_PREFIX}/ping`) return { status: 200, payload: { ok: true, version: PLUGIN_VERSION } }
    return { status: 404, payload: { ok: false, error: 'not-found', path } }
  }

  const handleNodeRequest = async (request, response) => {
    const method = String(request.method ?? 'GET').toUpperCase()
    let status = 500
    let payload = { ok: false, error: 'internal' }
    try {
      const url = new URL(String(request.url ?? '/'), 'http://localhost')
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
        status = 405
        payload = { ok: false, error: 'method-not-allowed' }
      } else {
        const bodyText = method === 'POST' ? await readNodeBody(request) : ''
        const routed = await routeApi({ path: url.pathname, searchParams: url.searchParams, bodyText })
        status = routed.status
        payload = routed.payload
      }
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status
        payload = { ok: false, error: 'bad-request', message: error.message }
      } else {
        ctx.logger?.warn?.('dsh-fallback: request failed: %o', error)
        payload = { ok: false, error: 'internal', message: messageOf(error) }
      }
    }
    try {
      const text = JSON.stringify(payload)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      if (method === 'HEAD') response.end()
      else response.end(text)
    } catch (writeError) {
      ctx.logger?.warn?.('dsh-fallback: response write failed: %o', writeError)
      try {
        response.destroy?.()
      } catch {
        // The socket is already gone; nothing else to release.
      }
    }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (request, response) => handleNodeRequest(request, response),
    })
    return () => dispose()
  }, 'dsh-fallback: settings API routes')

  ctx.effect(() => {
    events.setLimit(currentConfig().logLimit)
    return () => writer.dispose()
  }, 'dsh-fallback: flush persisted state on unload')

  ctx.logger?.info?.(
    'dsh-fallback: router fallback ready (chain: %s)',
    currentConfig().chain.length === 0 ? 'not configured' : currentConfig().chain.map((entry) => entry.provider).join(' -> '),
  )
}

/** One HTTP error with a status code. */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}


/** Render an arbitrary failure without leaking a stack trace. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
