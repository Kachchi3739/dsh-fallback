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
import { AsyncLocalStorage } from 'node:async_hooks'

import {
  DEFAULT_CONFIG,
  cooldownFor,
  createHealthStore,
  planAttempts,
  resolveConfig,
  runFallbackStream,
  sanitizeAttemptOptions,
} from './lib/engine.mjs'
import {
  ACCOUNT_PROVIDERS,
  DEFAULT_ACCOUNT_ID,
  MAX_ACCOUNTS_PER_PROVIDER,
  accountHealthKey,
  addAccount,
  listAccounts,
  newAccountId,
  normalizeAccountsState,
  normalizeLabel,
  refForAccount,
  removeAccount,
  reorderAccounts,
  supportsAccounts,
  validateNewAccount,
} from './lib/accounts.mjs'
import { createModelProtocolLookup } from './lib/model-apis.mjs'
import { createProviderCatalog, describeProviders, resolveChainModels, PROBE_PROVIDER } from './lib/providers.mjs'
import {
  PROBE_CHAIN,
  PROBE_LOG,
  PROBE_PROMPT,
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
export const PLUGIN_VERSION = '1.1.0'

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
  const modelApis = createModelProtocolLookup()
  const credentials = ctx.get('credentials')
  // Carries the account chosen for one attempt into the pi-ai header
  // waterfall, which only receives routing metadata (no request object).
  const headerContext = new AsyncLocalStorage()
  /** Runtime mutable configuration layer owned by the settings page. */
  const runtime = {
    overrides: normalizeOverrides(persisted.overrides),
    accounts: normalizeAccountsState(persisted.accounts),
    lastResult: null,
    lastError: null,
  }
  const writer = createStateWriter(stateFile, () => ({
    overrides: runtime.overrides,
    accounts: runtime.accounts,
    health: health.snapshot(),
    events: events.snapshot(),
  }))
  const internalRequests = new WeakMap()
  let probeInFlight = false

  /**
   * Wrap one attempt's chunk stream so every pull runs inside the account
   * context the pi-ai header waterfall reads. The provider adapter prepares its
   * request headers on the first pull, so the async-local store must be active
   * for that call rather than only while the outer request is built.
   */
  const wrapWithHeaderContext = (iterable, store) => {
    if (store === null || store === undefined) return iterable
    return {
      [Symbol.asyncIterator]() {
        const inner = iterable[Symbol.asyncIterator]()
        return {
          next: (...args) => headerContext.run(store, () => inner.next(...args)),
          return: (value) =>
            typeof inner.return === 'function'
              ? headerContext.run(store, () => inner.return(value))
              : Promise.resolve({ done: true, value }),
          throw: (error) =>
            typeof inner.throw === 'function' ? headerContext.run(store, () => inner.throw(error)) : Promise.reject(error),
        }
      },
    }
  }

  const currentConfig = () => resolveConfig(DEFAULT_CONFIG, rowConfig, runtime.overrides)

  const persist = () => writer.schedule()

  // ---------------------------------------------------------------------
  // Attempt bookkeeping (health, event log, last result)
  // ---------------------------------------------------------------------

  const healthKeyOf = (attempt) => attempt.healthKey ?? attempt.provider
  const accountOf = (attempt) =>
    typeof attempt.accountId === 'string'
      ? { id: attempt.accountId, label: attempt.accountLabel ?? attempt.accountId, kind: attempt.accountKind ?? 'added' }
      : null
  const attemptEndpoint = (attempt) => ({
    provider: attempt.provider,
    model: attempt.model,
    ...(accountOf(attempt) === null ? {} : { account: accountOf(attempt) }),
  })

  const recordAttemptEvent = (event, attempts, options, config) => {
    if (event.type === 'attempt-start') {
      health.markAttempt(healthKeyOf(event.attempt))
      return
    }
    const attempt = event.attempt
    if (event.type === 'attempt-failed') {
      const eligible = event.eligible === true
      // Only an exhausted/ineligible-free route is cooled down: a bad request
      // (INVALID_REQUEST and friends) says nothing about route health, but a
      // zero-length window still records the failure in the stats.
      health.markFailure(healthKeyOf(attempt), event.failure, eligible ? cooldownFor(event.failure, config) : 0)
      const next = attempts[event.index + 1]
      events.record({
        kind: eligible && next !== undefined ? 'fallback' : 'failure',
        sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
        from: attemptEndpoint(attempt),
        to: next === undefined ? null : attemptEndpoint(next),
        code: typeof event.failure?.code === 'string' ? event.failure.code : 'UNKNOWN',
        message: typeof event.failure?.message === 'string' ? event.failure.message.slice(0, 240) : '',
        latencyMs: event.latencyMs,
      })
      runtime.lastResult = {
        at: new Date().toISOString(),
        kind: eligible ? 'fallback' : 'failure',
        from: attemptEndpoint(attempt),
        to: next === undefined ? null : attemptEndpoint(next),
        code: typeof event.failure?.code === 'string' ? event.failure.code : 'UNKNOWN',
      }
      persist()
      return
    }
    if (event.type === 'attempt-succeeded') {
      health.markSuccess(healthKeyOf(attempt))
      if (event.index > 0) {
        events.record({
          kind: 'answered',
          sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
          from: null,
          to: attemptEndpoint(attempt),
          code: null,
          message: '',
          latencyMs: event.latencyMs,
        })
      }
      runtime.lastResult = {
        at: new Date().toISOString(),
        kind: 'answered',
        from: null,
        to: attemptEndpoint(attempt),
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
    // The account connection test dispatches with its own key context and must
    // not be re-routed by the fallback chain.
    if (options.purpose === 'dsh-fallback-account-test') {
      yield* next()
      return
    }
    const config = currentConfig()
    if (!config.enabled && probeLog === undefined) {
      yield* next()
      return
    }
    const probeChain = options[PROBE_CHAIN]
    const chain = Array.isArray(probeChain) && probeChain.length > 0 ? probeChain : config.chain
    const maxAttempts =
      probeLog === undefined ? config.maxAttempts : Math.min(8, Math.max(config.maxAttempts, chain.length + 1))
    // Pooled accounts: the selected route is served by several API keys and the
    // plugin rotates them transparently. Only explicit added accounts count; a
    // route with just its configured key keeps the legacy single-entry path.
    let accountAttempts = []
    let accountKeys = new Map()
    if (probeLog === undefined && supportsAccounts(options.provider) && Array.isArray(runtime.accounts[options.provider])) {
      const resolved = await resolveAccountKeys(options.provider, listAccounts(runtime.accounts, options.provider))
      if (resolved.accounts.some((account) => account.kind !== 'default')) {
        accountAttempts = resolved.accounts
        accountKeys = resolved.keys
      }
    }
    let attempts = planAttempts({
      provider: options.provider,
      model: options.model,
      chain,
      accounts: accountAttempts,
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
      const isDefaultAccount = attempt.accountId === undefined || attempt.accountId === DEFAULT_ACCOUNT_ID
      const key = attempt.accountId === undefined || isDefaultAccount ? null : (accountKeys.get(attempt.accountId) ?? null)
      const context = accountAttempts.length === 0 ? null : { provider: options.provider, key }
      const iterable =
        !nextConsumed && isDefaultAccount && attempt.provider === options.provider && attempt.model === options.model
          ? (nextConsumed = true, next())
          : reDispatch(attempt, attemptOptions, attempt.provider !== options.provider)
      return context === null ? iterable : wrapWithHeaderContext(iterable, context)
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

  // Account key rotation travels through the documented header waterfall: the
  // routing metadata carries the exact provider and model, and the async-local
  // store carries the key chosen for this attempt. Writing the protocol's auth
  // header overrides the route's configured key for this request only.
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    const store = headerContext.getStore()
    if (store !== undefined && store.provider === request.provider && typeof store.key === 'string' && store.key.length > 0) {
      const api = modelApis.apiFor(request.provider, request.model)
      if (api === 'anthropic-messages') headers.set('x-api-key', store.key)
      else if (api === 'google-generative-ai') headers.set('x-goog-api-key', store.key)
      else headers.set('authorization', `Bearer ${store.key}`)
    }
    return next()
  })

  /**
   * Resolve stored keys for the provider's accounts and drop added accounts
   * whose credential is missing (an account whose key was removed by hand must
   * not consume an attempt).
   */
  const resolveAccountKeys = async (provider, accounts) => {
    const keys = new Map()
    const usable = []
    for (const account of accounts) {
      if (account.kind === 'default') {
        usable.push(account)
        continue
      }
      if (credentials === undefined) continue
      try {
        const resolved = await credentials.resolve(account.keyRef)
        if (typeof resolved?.value === 'string' && resolved.value.length > 0) {
          keys.set(account.id, resolved.value)
          usable.push(account)
        }
      } catch {
        // A missing credential simply leaves this account out of the attempt list.
      }
    }
    return { accounts: usable, keys }
  }

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

  // ---------------------------------------------------------------------
  // Pooled accounts (multiple API keys on one provider route)
  // ---------------------------------------------------------------------

  const providerRegistered = (provider) => {
    try {
      return llm.listProviders().some((entry) => entry.id === provider)
    } catch {
      return false
    }
  }

  const buildAccountsPayload = async () => {
    const config = currentConfig()
    const healthSnapshot = health.snapshot()
    const degraded = healthSnapshot.degraded ?? {}
    const providers = []
    for (const provider of ACCOUNT_PROVIDERS) {
      const stored = Array.isArray(runtime.accounts[provider]) ? runtime.accounts[provider] : []
      const registered = providerRegistered(provider)
      if (!registered && stored.length === 0) continue
      const accounts = []
      for (const account of listAccounts(runtime.accounts, provider)) {
        let keyPresent = null
        if (account.kind === 'added' && credentials !== undefined) {
          try {
            keyPresent = (await credentials.describe(account.keyRef))?.configured === true
          } catch {
            keyPresent = false
          }
        }
        const record = degraded[account.healthKey]
        accounts.push({
          id: account.id,
          label: account.kind === 'default' ? null : account.label,
          kind: account.kind,
          healthKey: account.healthKey,
          keyPresent,
          degraded:
            record === undefined
              ? null
              : {
                  until: Number.isFinite(Number(record.until)) ? Number(record.until) : null,
                  remainingMs: Math.max(0, Number(record.until) - Date.now()),
                  code: typeof record.code === 'string' ? record.code : 'UNKNOWN',
                  message: typeof record.message === 'string' ? record.message.slice(0, 240) : '',
                },
        })
      }
      const models = await catalog.modelsFor(provider)
      const chainModel = config.chain.find((entry) => entry.provider === provider)?.model
      providers.push({
        provider,
        displayName: (() => {
          try {
            return llm.listProviders().find((entry) => entry.id === provider)?.name ?? provider
          } catch {
            return provider
          }
        })(),
        registered,
        accounts,
        models,
        defaultModel: chainModel ?? models[0]?.id ?? '',
        maxAccounts: MAX_ACCOUNTS_PER_PROVIDER,
        catalog: modelApis.status()[provider] ?? null,
      })
    }
    return { providers, credentialsAvailable: credentials !== undefined }
  }

  const requireAccountProvider = (value) => {
    const provider = typeof value === 'string' ? value.trim() : ''
    if (!supportsAccounts(provider)) throw new HttpError(400, 'unsupported-provider')
    if (!providerRegistered(provider)) throw new HttpError(409, 'provider-not-connected')
    return provider
  }

  const createAccount = async (body) => {
    const provider = requireAccountProvider(body?.provider)
    if (credentials === undefined) throw new HttpError(409, 'credentials-unavailable')
    const existing = Array.isArray(runtime.accounts[provider]) ? runtime.accounts[provider].length : 0
    if (existing >= MAX_ACCOUNTS_PER_PROVIDER) throw new HttpError(409, 'too-many-accounts')
    const validation = validateNewAccount(body, `account ${existing + 2}`)
    if (!validation.ok) throw new HttpError(400, validation.error)
    const id = newAccountId()
    const keyRef = refForAccount(provider, id)
    try {
      await credentials.set(keyRef, validation.key)
    } catch (error) {
      throw new HttpError(500, `cannot store the account key: ${messageOf(error)}`)
    }
    const added = addAccount(runtime.accounts, provider, {
      id,
      label: normalizeLabel(validation.label, `account ${existing + 2}`),
      keyRef,
      createdAt: new Date().toISOString(),
    })
    if (!added.ok) {
      try {
        await credentials.unset(keyRef)
      } catch {
        // The account was not recorded; the orphan ref is harmless.
      }
      throw new HttpError(409, added.error)
    }
    runtime.accounts = added.accounts
    persist()
    writer.flush()
    return { ok: true, accountId: id, accounts: await buildAccountsPayload() }
  }

  const deleteAccount = async (body) => {
    const provider = requireAccountProvider(body?.provider)
    const id = typeof body?.id === 'string' ? body.id : ''
    const removed = removeAccount(runtime.accounts, provider, id)
    if (!removed.ok) throw new HttpError(400, removed.error)
    runtime.accounts = removed.accounts
    health.markSuccess(accountHealthKey(provider, id))
    if (credentials !== undefined && typeof removed.removed?.keyRef === 'string') {
      try {
        await credentials.unset(removed.removed.keyRef)
      } catch {
        // A key left behind is not referenced by any account anymore.
      }
    }
    persist()
    writer.flush()
    return { ok: true, accounts: await buildAccountsPayload() }
  }

  const reorderAccountList = async (body) => {
    const provider = requireAccountProvider(body?.provider)
    const reordered = reorderAccounts(runtime.accounts, provider, Array.isArray(body?.ids) ? body.ids : [])
    if (!reordered.ok) throw new HttpError(400, reordered.error)
    runtime.accounts = reordered.accounts
    persist()
    writer.flush()
    return { ok: true, accounts: await buildAccountsPayload() }
  }

  const skipAccount = async (body) => {
    const provider = requireAccountProvider(body?.provider)
    const id = typeof body?.id === 'string' ? body.id : ''
    const minutes = Number.isFinite(Number(body?.minutes)) ? Math.min(24 * 60, Math.max(1, Math.trunc(Number(body.minutes)))) : 30
    const account = listAccounts(runtime.accounts, provider).find((entry) => entry.id === id)
    if (account === undefined) throw new HttpError(400, 'unknown-account')
    health.markFailure(account.healthKey, { code: 'MANUAL_SKIP', message: 'skipped from the settings page' }, minutes * 60_000)
    persist()
    writer.flush()
    return { ok: true, accounts: await buildAccountsPayload() }
  }

  const resumeAccount = async (body) => {
    const provider = requireAccountProvider(body?.provider)
    const id = typeof body?.id === 'string' ? body.id : ''
    const account = listAccounts(runtime.accounts, provider).find((entry) => entry.id === id)
    if (account === undefined) throw new HttpError(400, 'unknown-account')
    health.markSuccess(account.healthKey)
    persist()
    writer.flush()
    return { ok: true, accounts: await buildAccountsPayload() }
  }

  const testAccount = async (body) => {
    const provider = requireAccountProvider(body?.provider)
    const id = typeof body?.id === 'string' && body.id.length > 0 ? body.id : DEFAULT_ACCOUNT_ID
    const accounts = listAccounts(runtime.accounts, provider)
    const account = accounts.find((entry) => entry.id === id)
    if (account === undefined) throw new HttpError(400, 'unknown-account')
    let key = null
    if (account.kind === 'added') {
      if (credentials === undefined) throw new HttpError(409, 'credentials-unavailable')
      let resolved
      try {
        resolved = await credentials.resolve(account.keyRef)
      } catch {
        resolved = undefined
      }
      if (typeof resolved?.value !== 'string' || resolved.value.length === 0) throw new HttpError(409, 'missing-key')
      key = resolved.value
    }
    const models = await catalog.modelsFor(provider)
    const requested = typeof body?.model === 'string' && body.model.length > 0 ? body.model : null
    const model = requested ?? currentConfig().chain.find((entry) => entry.provider === provider)?.model ?? models[0]?.id
    if (typeof model !== 'string' || model.length === 0) throw new HttpError(409, 'no-model')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), currentConfig().probeTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const startedAt = Date.now()
    try {
      const stream = llm.stream({
        provider,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }] }],
        maxTokens: 24,
        purpose: 'dsh-fallback-account-test',
        sessionId: probeSessionId(),
        signal: controller.signal,
      })
      const outcome = await collectProbeStream(wrapWithHeaderContext(stream, { provider, key }))
      const failure = outcome.finish?.reason?.kind === 'error' ? outcome.finish.reason.failure : null
      return {
        ok: failure === null,
        account: { id: account.id, label: account.label, kind: account.kind },
        model,
        failure,
        text: outcome.text.slice(0, 200),
        latencyMs: Date.now() - startedAt,
      }
    } finally {
      clearTimeout(timer)
    }
  }

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
      accounts: await buildAccountsPayload(),
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
    if (path === `${ROUTE_PREFIX}/accounts` && bodyText.length === 0) {
      return { status: 200, payload: { ok: true, accounts: await buildAccountsPayload(), now: Date.now() } }
    }
    if (path === `${ROUTE_PREFIX}/accounts/create`) {
      return { status: 200, payload: await createAccount(parseJsonBody(bodyText)) }
    }
    if (path === `${ROUTE_PREFIX}/accounts/remove`) {
      return { status: 200, payload: await deleteAccount(parseJsonBody(bodyText)) }
    }
    if (path === `${ROUTE_PREFIX}/accounts/reorder`) {
      return { status: 200, payload: await reorderAccountList(parseJsonBody(bodyText)) }
    }
    if (path === `${ROUTE_PREFIX}/accounts/skip`) {
      return { status: 200, payload: await skipAccount(parseJsonBody(bodyText)) }
    }
    if (path === `${ROUTE_PREFIX}/accounts/resume`) {
      return { status: 200, payload: await resumeAccount(parseJsonBody(bodyText)) }
    }
    if (path === `${ROUTE_PREFIX}/accounts/test`) {
      return { status: 200, payload: { ok: true, result: await testAccount(parseJsonBody(bodyText)), now: Date.now() } }
    }
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
