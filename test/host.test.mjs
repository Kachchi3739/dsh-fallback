/**
 * Host-half integration tests: a minimal fake Harness (LLM service, waterfall
 * dispatch, web server, context lifecycle) exercises `apply()` end to end —
 * interception, cooldown, persistence, the settings HTTP API, and the
 * self-test that forces one simulated quota failure.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, inject, name, PLUGIN_VERSION } from '../index.js'
import { PROBE_PROVIDER } from '../lib/providers.mjs'
import packageJson from '../package.json' with { type: 'json' }

/** Collect an async iterable into an array. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/** Text of every `text-delta` chunk in a collected stream. */
const textOf = (chunks) =>
  chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')

/** Terminal finish chunk of a collected stream. */
const finishOf = (chunks) => chunks.find((chunk) => chunk.type === 'finish') ?? null

/** A well-behaved adapter that answers with `reply`. */
function textAdapter(provider, options = {}) {
  const models = options.models ?? [`${provider}-model`]
  const reply = options.reply ?? 'hello'
  const efforts = Array.isArray(options.reasoningEfforts) ? options.reasoningEfforts : null
  const adapter = {
    providerInfo: (route) => ({ id: route, name: `${provider} router` }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async (route) => models.map((id) => ({ provider: route, id, name: `${id} display` })),
    resolveModel: async (route, model) => ({
      provider: route,
      id: model,
      name: model,
      ...efforts === null ? {} : { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } },
    }),
    prepareCall: async (route, model) => ({
      model: { provider: route, id: model, name: model },
      stream: () => adapter.stream(),
    }),
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return adapter
}

/** An adapter that fails the way an exhausted router does. */
function failingAdapter(provider, code = 'QUOTA') {
  const base = textAdapter(provider)
  const adapter = {
    ...base,
    prepareCall: async (route, model) => ({
      model: { provider: route, id: model, name: model },
      stream: () => adapter.stream(),
    }),
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      const error = new Error(`${code} from ${provider}`)
      error.code = code
      error.failure = { code, message: `${code} from ${provider}`, status: code === 'RATE_LIMIT' ? 429 : 402 }
      throw error
    },
  }
  return adapter
}

/** Minimal stand-in for Cordis `ctx` plus the LLM service. */
/** Latest request headers the fake pi-ai adapter prepared (single-threaded tests). */
let testHeaders = null

/** The `Authorization` header the current attempt carried, when any. */
const currentAuthorization = () => testHeaders?.get('authorization') ?? null

function createFakeHarness() {
  const adapters = new Map()
  const streamListeners = []
  const headerListeners = []
  const routes = []
  const effects = []
  const dispatches = []
  const credentials = new Map()
  const llm = {
    listProviders: () => [...adapters.values()].map((registration) => ({ ...registration.provider })),
    listConfigurableProviders: () => [],
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (adapters.has(provider)) throw new Error(`an adapter for provider "${provider}" is already registered`)
      }
      for (const provider of providers) {
        adapters.set(provider, { provider: { id: provider, name: adapter.providerInfo(provider).name }, adapter })
      }
      const dispose = () => {
        for (const provider of providers) adapters.delete(provider)
      }
      dispose.replace = () => {}
      return dispose
    },
    listModels: async (provider) => {
      const registration = adapters.get(provider)
      if (registration === undefined) throw new Error(`no adapter for "${provider}"`)
      return registration.adapter.listModels(provider)
    },
    resolveModelInfo: async (provider, model) => {
      const registration = adapters.get(provider)
      if (registration === undefined) throw new Error(`no adapter for "${provider}"`)
      return registration.adapter.resolveModel(provider, model)
    },
    stream(options) {
      return runWaterfall(options)
    },
  }
  /** Run the plugin's pi-ai header waterfall exactly like the real adapter. */
  function prepareHeaders(options) {
    const request = Object.freeze({
      provider: options.provider,
      model: options.model,
      baseURL: 'test://gateway',
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    })
    const headers = new Headers()
    const run = (index) => {
      const listener = headerListeners[index]
      if (listener === undefined) return headers
      let called = false
      const next = () => {
        if (called) throw new Error('next() called multiple times')
        called = true
        return run(index + 1)
      }
      return listener(request, headers, next)
    }
    return run(0)
  }
  async function* adapterStream(options) {
    const registration = adapters.get(options.provider)
    if (registration === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter' } } }
      return
    }
    testHeaders = prepareHeaders(options)
    dispatches.push({ provider: options.provider, model: options.model, authorization: testHeaders.get('authorization') })
    let iterator
    try {
      const prepared = await registration.adapter.prepareCall(options.provider, options.model)
      iterator = prepared.stream(options)[Symbol.asyncIterator]()
    } catch (error) {
      yield normalizeFailure(error)
      return
    }
    while (true) {
      let step
      try {
        step = await iterator.next()
      } catch (error) {
        yield normalizeFailure(error)
        return
      }
      if (step.done === true) return
      yield step.value
    }
  }
  function normalizeFailure(error) {
    if (error instanceof Error && typeof error.code === 'string' && error.failure?.code === error.code) {
      return { type: 'finish', reason: { kind: 'error', failure: { ...error.failure } } }
    }
    return {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) } },
    }
  }
  function runWaterfall(options, index = 0) {
    const listener = streamListeners[index]
    if (listener === undefined) return adapterStream(options)
    let called = false
    const next = () => {
      if (called) throw new Error('next() called multiple times')
      called = true
      return runWaterfall(options, index + 1)
    }
    return listener.call(llm, options, next)
  }
  const ctx = {
    llm,
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    logger: { info() {}, warn() {} },
    on(event, listener) {
      if (event === 'llm/stream') streamListeners.push(listener)
      if (event === 'llm-pi-ai/request-headers') headerListeners.push(listener)
      return () => {}
    },
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            const value = credentials.get(ref)
            return value === undefined ? undefined : { value, source: 'test' }
          },
          async describe(ref) {
            return { configured: credentials.has(ref), writable: true }
          },
          async set(ref, value) {
            credentials.set(ref, value)
          },
          async unset(ref) {
            credentials.delete(ref)
          },
        }
      }
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
  }
  return { ctx, llm, routes, effects, dispatches, adapters, credentials }
}

/** Build a request for one of the plugin's routes. */
const request = (route, init) => new Request(`http://127.0.0.1:60949${route}`, init)

/** Read the JSON body of a route response. */
async function jsonOf(promise) {
  const response = await promise
  return { status: response.status, body: await response.json() }
}

/** Spin up the plugin against a fake harness in a throwaway profile dir. */
function setup({ adapters = {}, rowConfig = {}, profileDir = null } = {}) {
  const ownedProfileDir = profileDir === null
  const dir = profileDir ?? mkdtempSync(path.join(tmpdir(), 'dsh-fallback-test-'))
  const previousProfile = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  const harness = createFakeHarness()
  for (const [provider, adapter] of Object.entries(adapters)) {
    harness.llm.registerAdapter([provider], adapter)
  }
  apply(harness.ctx, {
    enabled: true,
    chain: [
      { provider: 'primary', model: 'primary-model' },
      { provider: 'backup', model: 'backup-model' },
    ],
    fallbackCodes: ['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT'],
    maxAttempts: 3,
    ...rowConfig,
  })
  const route = harness.routes.find((entry) => entry.path === '/dsh-fallback')
  const call = async (suffix, init = {}) => {
    const bodyText = typeof init.body === 'string' ? init.body : ''
    const request = {
      method: init.method ?? 'GET',
      url: `/dsh-fallback${suffix}`,
      async *[Symbol.asyncIterator]() {
        if (bodyText.length > 0) yield Buffer.from(bodyText, 'utf8')
      },
    }
    const response = {
      status: 0,
      headers: null,
      body: '',
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(text) {
        this.body = typeof text === 'string' ? text : ''
      },
      destroy() {},
    }
    await route.handler(request, response)
    return { status: response.status, body: response.body.length > 0 ? JSON.parse(response.body) : null }
  }
  const finish = () => {
    for (const dispose of harness.effects.reverse()) {
      if (typeof dispose === 'function') dispose()
    }
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    if (ownedProfileDir) rmSync(dir, { recursive: true, force: true })
  }
  return { ...harness, route, call, finish, profileDir: dir }
}

test('bundle identity is coherent', () => {
  assert.equal(name, 'dsh-fallback')
  assert.deepEqual(inject, ['llm', 'webServer'])
  assert.equal(PLUGIN_VERSION, packageJson.version)
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.exports['./client'], './client.js')
  assert.ok(existsSync(new URL('../client.js', import.meta.url)))
})

test('a quota failure falls back to the next router', async () => {
  const harness = setup({
    adapters: { primary: failingAdapter('primary'), backup: textAdapter('backup', { reply: 'hello from backup' }) },
  })
  try {
    const chunks = await collect(harness.llm.stream({ provider: 'primary', model: 'primary-model', messages: [] })); assert.equal(textOf(chunks), 'hello from backup')
    assert.equal(finishOf(chunks)?.reason.kind, 'stop')
    assert.deepEqual(
      harness.dispatches.map((entry) => entry.provider),
      ['primary', 'backup'],
    )
    const { body } = await harness.call('/state')
    assert.equal(body.ok, true)
    assert.equal(body.config.chain.length, 2)
    const primary = body.providers.find((provider) => provider.id === 'primary')
    assert.equal(primary.degraded.code, 'QUOTA')
    assert.ok(primary.degraded.remainingMs > 0)
    assert.equal(body.events.some((event) => event.kind === 'fallback'), true)
    assert.equal(body.lastResult.kind, 'answered')
    assert.equal(body.lastResult.to.provider, 'backup')
  } finally {
    harness.finish()
  }
})

test('a cooling-down router is skipped on the next request', async () => {
  const harness = setup({
    adapters: { primary: failingAdapter('primary'), backup: textAdapter('backup') },
  })
  try {
    await collect(harness.llm.stream({ provider: 'primary', model: 'primary-model', messages: [] }))
    assert.deepEqual(harness.dispatches.map((entry) => entry.provider), ['primary', 'backup'])
    harness.dispatches.length = 0
    const chunks = await collect(harness.llm.stream({ provider: 'primary', model: 'primary-model', messages: [] }))
    assert.equal(finishOf(chunks)?.reason.kind, 'stop')
    assert.deepEqual(harness.dispatches.map((entry) => entry.provider), ['backup'])
  } finally {
    harness.finish()
  }
})

test('a non-trigger failure is not retried on another router', async () => {
  const harness = setup({
    adapters: { primary: failingAdapter('primary', 'INVALID_REQUEST'), backup: textAdapter('backup') },
  })
  try {
    const chunks = await collect(harness.llm.stream({ provider: 'primary', model: 'primary-model', messages: [] }))
    assert.equal(finishOf(chunks)?.reason.failure.code, 'INVALID_REQUEST')
    assert.deepEqual(harness.dispatches.map((entry) => entry.provider), ['primary'])
  } finally {
    harness.finish()
  }
})

test('disabling the plugin restores passthrough behaviour', async () => {
  const harness = setup({
    adapters: { primary: failingAdapter('primary'), backup: textAdapter('backup') },
    rowConfig: { enabled: false },
  })
  try {
    const chunks = await collect(harness.llm.stream({ provider: 'primary', model: 'primary-model', messages: [] }))
    assert.equal(finishOf(chunks)?.reason.failure.code, 'QUOTA')
    assert.deepEqual(harness.dispatches.map((entry) => entry.provider), ['primary'])
    const { body } = await harness.call('/state')
    assert.equal(body.config.enabled, false)
  } finally {
    harness.finish()
  }
})

test('the settings endpoint lists connected routers and their models', async () => {
  const harness = setup({
    adapters: {
      primary: textAdapter('primary', { models: ['primary-model', 'primary-fast'] }),
      backup: textAdapter('backup', { models: ['backup-model'] }),
    },
  })
  try {
    const { body } = await harness.call('/models')
    assert.equal(body.ok, true)
    const primary = body.providers.find((provider) => provider.id === 'primary')
    assert.deepEqual(
      primary.models.map((model) => model.id),
      ['primary-model', 'primary-fast'],
    )
    assert.equal(primary.registered, true)
    assert.deepEqual(harness.routes.map((entry) => entry.path), ['/dsh-fallback'])
  } finally {
    harness.finish()
  }
})

test('overrides saved from the page win over the bundle config and persist', async () => {
  const harness = setup({ adapters: { primary: textAdapter('primary'), backup: textAdapter('backup') } })
  try {
    const saved = await harness.call('/config', {
      method: 'POST',
      body: JSON.stringify({
        overrides: {
          enabled: true,
          chain: [{ provider: 'backup', model: 'backup-model' }],
          fallbackCodes: ['QUOTA'],
          maxAttempts: 2,
        },
      }),
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(
      saved.body.config.chain.map((entry) => entry.provider),
      ['backup'],
    )
    assert.equal(saved.body.overrides.maxAttempts, 2)
    const stateFile = path.join(harness.profileDir, '.dsh-fallback', 'state.json')
    assert.ok(existsSync(stateFile))
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(persisted.overrides.chain[0].provider, 'backup')
    assert.equal(persisted.version, 1)

    const reset = await harness.call('/overrides/reset', { method: 'POST' })
    assert.deepEqual(
      reset.body.config.chain.map((entry) => entry.provider),
      ['primary', 'backup'],
    )
  } finally {
    harness.finish()
  }
})

test('invalid config payloads are rejected with 400', async () => {
  const harness = setup({ adapters: { primary: textAdapter('primary') } })
  try {
    const badJson = await harness.call('/config', { method: 'POST', body: '{not json' })
    assert.equal(badJson.status, 400)
    const badShape = await harness.call('/config', { method: 'POST', body: JSON.stringify({ nope: 1 }) })
    assert.equal(badShape.status, 400)
    const missing = await harness.call('/does-not-exist')
    assert.equal(missing.status, 404)
  } finally {
    harness.finish()
  }
})

test('a non-trigger failure does not cool the route down', async () => {
  const harness = setup({
    adapters: { primary: failingAdapter('primary', 'INVALID_REQUEST'), backup: textAdapter('backup') },
  })
  try {
    await collect(harness.llm.stream({ provider: 'primary', model: 'primary-model', messages: [] }))
    const state = await harness.call('/state')
    assert.equal(state.body.providers.find((provider) => provider.id === 'primary').degraded, null)
    harness.dispatches.length = 0
    await collect(harness.llm.stream({ provider: 'primary', model: 'primary-model', messages: [] }))
    assert.deepEqual(harness.dispatches.map((entry) => entry.provider), ['primary'])
  } finally {
    harness.finish()
  }
})

test('a cross-provider fallback drops foreign thinking history and pins reasoning off', async () => {
  const seen = []
  const backup = textAdapter('backup', { reasoningEfforts: ['off', 'low', 'high'] })
  const originalStream = backup.stream
  backup.stream = async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'fallback answer' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const harness = setup({
    adapters: { primary: failingAdapter('primary'), backup },
    rowConfig: { chain: [{ provider: 'backup', model: 'backup-model' }] },
  })
  // Capture the exact options handed to the fallback route.
  const originalPrepare = backup.prepareCall
  backup.prepareCall = async (route, model) => {
    const prepared = await originalPrepare(route, model)
    return {
      model: prepared.model,
      stream: (options) => {
        seen.push(options)
        return originalStream.call(backup)
      },
    }
  }
  try {
    await collect(
      harness.llm.stream({
        provider: 'primary',
        model: 'primary-model',
        reasoningEffort: 'max',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            source: { kind: 'model', provider: 'primary', model: 'primary-model' },
            content: [
              { type: 'reasoning', text: 'primary thinking' },
              { type: 'text', text: 'primary answer' },
            ],
          },
        ],
      }),
    )
    assert.equal(seen.length, 1)
    assert.equal(seen[0].provider, 'backup')
    assert.equal(seen[0].reasoningEffort, 'off')
    assert.equal(seen[0].messages[1].content.length, 1)
    assert.equal(seen[0].messages[1].content[0].text, 'primary answer')
  } finally {
    harness.finish()
  }
})

test('health reset clears degradation', async () => {
  const harness = setup({
    adapters: { primary: failingAdapter('primary'), backup: textAdapter('backup') },
  })
  try {
    await collect(harness.llm.stream({ provider: 'primary', model: 'primary-model', messages: [] }))
    const before = await harness.call('/state')
    assert.equal(before.body.providers.find((provider) => provider.id === 'primary').degraded.code, 'QUOTA')
    const after = await harness.call('/health/reset', { method: 'POST' })
    assert.equal(after.body.providers.find((provider) => provider.id === 'primary').degraded, null)
  } finally {
    harness.finish()
  }
})

test('the self-test forces a quota failure and proves the next router answers', async () => {
  const harness = setup({
    adapters: {
      primary: failingAdapter('primary'),
      backup: textAdapter('backup', { reply: 'OK' }),
    },
  })
  try {
    const { body } = await harness.call('/selftest', { method: 'POST', body: '{}' })
    assert.equal(body.ok, true)
    assert.equal(body.result.ok, true)
    assert.equal(body.result.answered.provider, 'backup')
    assert.equal(body.result.attempts[0].provider, PROBE_PROVIDER)
    assert.equal(body.result.attempts[0].ok, false)
    assert.equal(body.result.attempts[0].code, 'QUOTA')
    assert.equal(body.result.attempts[1].ok, false)
    assert.equal(body.result.attempts[2].ok, true)
    assert.match(body.result.text, /OK/)
    // The probe adapter never outlives its test.
    const providers = await harness.call('/models')
    assert.equal(providers.body.providers.some((provider) => provider.id === PROBE_PROVIDER), false)
    // The probe must not pollute real router health.
    const state = await harness.call('/state')
    assert.equal(state.body.providers.find((provider) => provider.id === 'primary').degraded, null)
  } finally {
    harness.finish()
  }
})

test('the self-test reports an empty chain instead of failing blindly', async () => {
  const harness = setup({ adapters: { primary: textAdapter('primary') }, rowConfig: { chain: [] } })
  try {
    const { body } = await harness.call('/selftest', { method: 'POST', body: '{}' })
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error, 'empty-chain')
  } finally {
    harness.finish()
  }
})

test('an unlisted selected provider is tried first, then the chain', async () => {
  const harness = setup({
    adapters: {
      other: textAdapter('other', { reply: 'other answers' }),
      backup: textAdapter('backup', { reply: 'backup answers' }),
    },
  })
  try {
    const chunks = await collect(harness.llm.stream({ provider: 'other', model: 'other-model', messages: [] }))
    assert.equal(textOf(chunks), 'other answers')
    assert.deepEqual(harness.dispatches.map((entry) => entry.provider), ['other'])
  } finally {
    harness.finish()
  }
})

// ---------------------------------------------------------------------------
// Pooled accounts on one provider route
// ---------------------------------------------------------------------------

/** An adapter that rejects one specific rotated key and answers otherwise. */
function keyAwareAdapter(provider, options = {}) {
  const failKey = options.failKey ?? null
  const code = options.code ?? 'QUOTA'
  const reply = options.reply ?? 'hello from an account'
  const adapter = {
    providerInfo: (route) => ({ id: route, name: `${provider} router` }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async (route) => [{ provider: route, id: 'flash', name: 'flash' }],
    resolveModel: async (route, model) => ({ provider: route, id: model, name: model }),
    prepareCall: async (route, model) => ({
      model: { provider: route, id: model, name: model },
      stream: () => adapter.stream(),
    }),
    async *stream() {
      const authorization = currentAuthorization()
      if (failKey !== null && authorization === `Bearer ${failKey}`) {
        const error = new Error(`${code} for the rotated account key`)
        error.code = code
        error.failure = { code, message: `${code} for the rotated account key`, status: 402 }
        throw error
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return adapter
}

const opencodeHarness = (adapters = {}) =>
  setup({
    adapters: { 'opencode-go': keyAwareAdapter('opencode-go'), backup: textAdapter('backup'), ...adapters },
    rowConfig: {
      chain: [
        { provider: 'opencode-go', model: 'flash' },
        { provider: 'backup', model: 'backup-model' },
      ],
    },
  })

const createAccount = (harness, body) =>
  harness.call('/accounts/create', {
    method: 'POST',
    body: JSON.stringify({ provider: 'opencode-go', label: '계정 2', key: 'oc_sk_test_account_2', ...body }),
  })

/** An adapter whose route key (no rotated Authorization header) is exhausted. */
function defaultKeyFailingAdapter(provider) {
  const base = keyAwareAdapter(provider, { reply: 'from a pooled chain account' })
  const original = base.stream
  base.stream = async function* stream() {
    if (currentAuthorization() === null) {
      const error = new Error('QUOTA for the route key')
      error.code = 'QUOTA'
      error.failure = { code: 'QUOTA', message: 'QUOTA for the route key', status: 402 }
      throw error
    }
    yield* original.call(base)
  }
  return base
}

test('an account key is stored in the credentials service, never in the state file', async () => {
  const harness = opencodeHarness()
  try {
    const created = await createAccount(harness, {})
    assert.equal(created.status, 200)
    assert.equal(created.body.ok, true)
    assert.equal(harness.credentials.size, 1)
    const [ref, value] = [...harness.credentials.entries()][0]
    assert.match(ref, /^DSH_FALLBACK_OPENCODE_GO_[A-F0-9]+$/)
    assert.equal(value, 'oc_sk_test_account_2')
    const accounts = created.body.accounts.providers.find((entry) => entry.provider === 'opencode-go')
    assert.equal(accounts.accounts.length, 2)
    assert.equal(accounts.accounts[0].kind, 'default')
    assert.equal(accounts.accounts[1].kind, 'added')
    assert.equal(accounts.accounts[1].label, '계정 2')
    const stateFile = path.join(harness.profileDir, '.dsh-fallback', 'state.json')
    const text = readFileSync(stateFile, 'utf8')
    assert.equal(text.includes('oc_sk_test_account_2'), false)
    assert.match(text, /DSH_FALLBACK_OPENCODE_GO_/)
  } finally {
    harness.finish()
  }
})

test('with pooled accounts configured the default account still uses the route key', async () => {
  const harness = opencodeHarness()
  try {
    await createAccount(harness, {})
    const chunks = await collect(harness.llm.stream({ provider: 'opencode-go', model: 'flash', messages: [] }))
    assert.equal(finishOf(chunks)?.reason.kind, 'stop')
    assert.equal(harness.dispatches.length, 1)
    assert.equal(harness.dispatches[0].authorization, null)
  } finally {
    harness.finish()
  }
})

test('the added account key is rotated into the request headers', async () => {
  const harness = opencodeHarness()
  try {
    await createAccount(harness, {})
    await harness.call('/accounts/skip', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode-go', id: 'default', minutes: 30 }),
    })
    const chunks = await collect(harness.llm.stream({ provider: 'opencode-go', model: 'flash', messages: [] }))
    assert.equal(textOf(chunks), 'hello from an account')
    assert.equal(finishOf(chunks)?.reason.kind, 'stop')
    assert.equal(harness.dispatches.length, 1)
    assert.equal(harness.dispatches[0].authorization, 'Bearer oc_sk_test_account_2')
  } finally {
    harness.finish()
  }
})

test('an exhausted account falls through to the next chain router', async () => {
  const harness = opencodeHarness({
    'opencode-go': keyAwareAdapter('opencode-go', { failKey: 'oc_sk_test_account_2' }),
  })
  try {
    await createAccount(harness, { label: '계정 2' })
    await harness.call('/accounts/skip', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode-go', id: 'default', minutes: 30 }),
    })
    const chunks = await collect(harness.llm.stream({ provider: 'opencode-go', model: 'flash', messages: [] }))
    assert.equal(finishOf(chunks)?.reason.kind, 'stop')
    assert.deepEqual(harness.dispatches.map((entry) => entry.provider), ['opencode-go', 'backup'])
    assert.equal(harness.dispatches[0].authorization, 'Bearer oc_sk_test_account_2')
    const state = await harness.call('/state')
    const event = state.body.events.find((entry) => entry.kind === 'fallback' && entry.from?.account !== undefined)
    assert.ok(event !== undefined)
    assert.equal(event.from.account.label, '계정 2')
    assert.equal(event.to.provider, 'backup')
    const accounts = state.body.accounts.providers.find((entry) => entry.provider === 'opencode-go')
    const added = accounts.accounts.find((entry) => entry.kind === 'added')
    assert.equal(added.degraded.code, 'QUOTA')
  } finally {
    harness.finish()
  }
})

test('an account connection test uses that account key', async () => {
  const harness = opencodeHarness()
  try {
    const created = await createAccount(harness, {})
    const id = created.body.accountId
    const tested = await harness.call('/accounts/test', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode-go', id }),
    })
    assert.equal(tested.body.result.ok, true)
    assert.equal(tested.body.result.account.kind, 'added')
    assert.equal(tested.body.result.model, 'flash')
    assert.equal(harness.dispatches.at(-1).authorization, 'Bearer oc_sk_test_account_2')
  } finally {
    harness.finish()
  }
})

test('removing an account deletes its credential and leaves the default account', async () => {
  const harness = opencodeHarness()
  try {
    const created = await createAccount(harness, {})
    const removed = await harness.call('/accounts/remove', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode-go', id: created.body.accountId }),
    })
    assert.equal(removed.body.ok, true)
    assert.equal(harness.credentials.size, 0)
    const accounts = removed.body.accounts.providers.find((entry) => entry.provider === 'opencode-go')
    assert.equal(accounts.accounts.length, 1)
    assert.equal(accounts.accounts[0].kind, 'default')
  } finally {
    harness.finish()
  }
})

test('account skip and resume drive the account health window', async () => {
  const harness = opencodeHarness()
  try {
    await createAccount(harness, {})
    const skipped = await harness.call('/accounts/skip', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode-go', id: 'default', minutes: 5 }),
    })
    let accounts = skipped.body.accounts.providers.find((entry) => entry.provider === 'opencode-go')
    assert.equal(accounts.accounts[0].degraded.code, 'MANUAL_SKIP')
    assert.ok(accounts.accounts[0].degraded.remainingMs > 0)
    const resumed = await harness.call('/accounts/resume', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode-go', id: 'default' }),
    })
    accounts = resumed.body.accounts.providers.find((entry) => entry.provider === 'opencode-go')
    assert.equal(accounts.accounts[0].degraded, null)
  } finally {
    harness.finish()
  }
})

test('account input validation rejects bad keys and unknown providers', async () => {
  const harness = opencodeHarness()
  try {
    const missing = await createAccount(harness, { key: '' })
    assert.equal(missing.status, 400)
    const bad = await createAccount(harness, { key: 'short' })
    assert.equal(bad.status, 400)
    const unsupported = await harness.call('/accounts/create', {
      method: 'POST',
      body: JSON.stringify({ provider: 'backup', key: 'oc_sk_test_account_2' }),
    })
    assert.equal(unsupported.status, 400)
    const unknownProvider = await harness.call('/accounts/create', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode', key: 'oc_sk_test_account_2' }),
    })
    assert.equal(unknownProvider.status, 409)
  } finally {
    harness.finish()
  }
})

test('accounts are loaded back from the state file after a plugin reload', async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'dsh-fallback-reload-'))
  const adapters = { 'opencode-go': keyAwareAdapter('opencode-go'), backup: textAdapter('backup') }
  const rowConfig = { chain: [{ provider: 'opencode-go', model: 'flash' }, { provider: 'backup', model: 'backup-model' }] }
  const first = setup({ adapters, rowConfig, profileDir })
  let second = null
  try {
    await createAccount(first, {})
    const stateFile = path.join(profileDir, '.dsh-fallback', 'state.json')
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(persisted.accounts['opencode-go'].length, 1)
    first.finish()
    second = setup({ adapters, rowConfig, profileDir })
    const state = await second.call('/accounts')
    const accounts = state.body.accounts.providers.find((entry) => entry.provider === 'opencode-go')
    assert.equal(accounts.accounts.length, 2)
  } finally {
    if (second !== null) second.finish()
    else first.finish()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// DSH-wide account rotation and chain-route pools
// ---------------------------------------------------------------------------

test('pooled accounts rotate on every request even with router fallback off', async () => {
  const harness = setup({
    adapters: { 'opencode-go': keyAwareAdapter('opencode-go') },
    rowConfig: { enabled: false, chain: [], accountMode: 'rotate' },
  })
  try {
    await createAccount(harness, {})
    const first = await collect(harness.llm.stream({ provider: 'opencode-go', model: 'flash', messages: [] }))
    const second = await collect(harness.llm.stream({ provider: 'opencode-go', model: 'flash', messages: [] }))
    assert.equal(finishOf(first)?.reason.kind, 'stop')
    assert.equal(finishOf(second)?.reason.kind, 'stop')
    assert.deepEqual(
      harness.dispatches.map((entry) => entry.authorization),
      [null, 'Bearer oc_sk_test_account_2'],
    )
    const { body } = await harness.call('/accounts')
    assert.equal(body.accounts.mode, 'rotate')
    const rows = body.accounts.providers.find((entry) => entry.provider === 'opencode-go').accounts
    assert.equal(rows[0].stats.requests, 1)
    assert.equal(rows[1].stats.requests, 1)
  } finally {
    harness.finish()
  }
})

test('sticky mode keeps a session on one account and moves a new session to the next', async () => {
  const harness = setup({
    adapters: { 'opencode-go': keyAwareAdapter('opencode-go') },
    rowConfig: { enabled: false, chain: [], accountMode: 'sticky' },
  })
  try {
    await createAccount(harness, {})
    const one = { provider: 'opencode-go', model: 'flash', messages: [], sessionId: 'session-one' }
    await collect(harness.llm.stream(one))
    await collect(harness.llm.stream(one))
    await collect(harness.llm.stream({ ...one, sessionId: 'session-two' }))
    assert.deepEqual(
      harness.dispatches.map((entry) => entry.authorization),
      [null, null, 'Bearer oc_sk_test_account_2'],
    )
    assert.deepEqual(harness.dispatches.map((entry) => entry.provider), ['opencode-go', 'opencode-go', 'opencode-go'])
  } finally {
    harness.finish()
  }
})

test('failover mode keeps the first account until it fails', async () => {
  const harness = setup({
    adapters: { 'opencode-go': keyAwareAdapter('opencode-go') },
    rowConfig: { enabled: false, chain: [], accountMode: 'failover' },
  })
  try {
    await createAccount(harness, {})
    const options = { provider: 'opencode-go', model: 'flash', messages: [], sessionId: 's' }
    await collect(harness.llm.stream(options))
    await collect(harness.llm.stream(options))
    assert.deepEqual(
      harness.dispatches.map((entry) => entry.authorization),
      [null, null],
    )
  } finally {
    harness.finish()
  }
})

test('a fallback chain route uses its pooled accounts', async () => {
  const harness = setup({
    adapters: {
      primary: failingAdapter('primary'),
      'opencode-go': defaultKeyFailingAdapter('opencode-go'),
      backup: textAdapter('backup'),
    },
    rowConfig: {
      chain: [
        { provider: 'primary', model: 'primary-model' },
        { provider: 'opencode-go', model: 'flash' },
        { provider: 'backup', model: 'backup-model' },
      ],
    },
  })
  try {
    await createAccount(harness, {})
    const chunks = await collect(
      harness.llm.stream({ provider: 'primary', model: 'primary-model', messages: [] }),
    )
    assert.equal(textOf(chunks), 'from a pooled chain account')
    assert.deepEqual(
      harness.dispatches.map((entry) => `${entry.provider}:${entry.authorization ?? 'route'}`),
      ['primary:route', 'opencode-go:route', 'opencode-go:Bearer oc_sk_test_account_2'],
    )
    const state = await harness.call('/state')
    const event = state.body.events.find(
      (entry) => entry.kind === 'fallback' && entry.from?.provider === 'opencode-go',
    )
    assert.equal(event.from.account.kind, 'default')
    assert.equal(event.to.account.kind, 'added')
  } finally {
    harness.finish()
  }
})

test('an added account serves alone when the default account is cooling down', async () => {
  const harness = setup({
    adapters: { 'opencode-go': keyAwareAdapter('opencode-go') },
    rowConfig: { enabled: false, chain: [], accountMode: 'rotate' },
  })
  try {
    await createAccount(harness, {})
    await harness.call('/accounts/skip', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode-go', id: 'default', minutes: 30 }),
    })
    const chunks = await collect(harness.llm.stream({ provider: 'opencode-go', model: 'flash', messages: [] }))
    assert.equal(finishOf(chunks)?.reason.kind, 'stop')
    assert.equal(textOf(chunks), 'hello from an account')
    assert.deepEqual(
      harness.dispatches.map((entry) => entry.authorization),
      ['Bearer oc_sk_test_account_2'],
    )
    const { body } = await harness.call('/accounts/rotation-test', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode-go', runs: 2 }),
    })
    assert.equal(body.result.ok, true)
    const added = body.result.accounts.find((entry) => entry.kind === 'added')
    assert.equal(added.requests, 2)
    assert.equal(added.successes, 2)
  } finally {
    harness.finish()
  }
})

test('the rotation test proves both accounts serve ordinary requests', async () => {
  const harness = opencodeHarness()
  try {
    await createAccount(harness, {})
    const { body } = await harness.call('/accounts/rotation-test', {
      method: 'POST',
      body: JSON.stringify({ provider: 'opencode-go', runs: 2 }),
    })
    assert.equal(body.result.ok, true)
    assert.equal(body.result.runs, 2)
    const byKind = Object.fromEntries(body.result.accounts.map((entry) => [entry.kind, entry]))
    assert.equal(byKind.default.requests, 1)
    assert.equal(byKind.added.requests, 1)
    assert.deepEqual(
      harness.dispatches.map((entry) => entry.authorization),
      [null, 'Bearer oc_sk_test_account_2'],
    )
  } finally {
    harness.finish()
  }
})

test('the account usage mode is saved and applies to the pool', async () => {
  const harness = opencodeHarness()
  try {
    await createAccount(harness, {})
    const saved = await harness.call('/config', {
      method: 'POST',
      body: JSON.stringify({ patch: { accountMode: 'failover' } }),
    })
    assert.equal(saved.body.config.accountMode, 'failover')
    assert.equal(saved.body.accounts.mode, 'failover')
    const options = { provider: 'opencode-go', model: 'flash', messages: [] }
    await collect(harness.llm.stream(options))
    await collect(harness.llm.stream(options))
    assert.deepEqual(
      harness.dispatches.map((entry) => entry.authorization),
      [null, null],
    )
    const persisted = JSON.parse(readFileSync(path.join(harness.profileDir, '.dsh-fallback', 'state.json'), 'utf8'))
    assert.equal(persisted.overrides.accountMode, 'failover')
  } finally {
    harness.finish()
  }
})
