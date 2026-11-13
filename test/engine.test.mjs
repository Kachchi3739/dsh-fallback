import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_CONFIG,
  DEFAULT_COOLDOWNS,
  attemptLabel,
  cooldownFor,
  createHealthStore,
  errorFinish,
  isContentChunk,
  isFallbackFailure,
  normalizeChain,
  normalizeChainEntry,
  planAttempts,
  pushBounded,
  resolveConfig,
  runFallbackStream,
  sanitizeAttemptOptions,
  stripReasoningBlocks,
} from '../lib/engine.mjs'

/** Build an async iterable from a chunk list. */
async function* chunks(list) {
  for (const chunk of list) yield chunk
}

/** A terminal error finish chunk. */
function fail(code, extra = {}) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message: `${code} failure`, ...extra } } }
}

/** A successful terminal finish chunk. */
function stop() {
  return { type: 'finish', reason: { kind: 'stop' } }
}

/** Collect a chunk stream into an array. */
async function collect(iterator) {
  const out = []
  for await (const chunk of iterator) out.push(chunk)
  return out
}

/** Build a fake dispatcher that returns one scripted stream per attempt. */
function scriptedDispatch(scripts) {
  const calls = []
  const dispatch = ({ attempt, options }) => {
    calls.push({ attempt: { ...attempt }, provider: options.provider, model: options.model })
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)]
    if (typeof script === 'function') return script({ attempt, options })
    if (Array.isArray(script) === false) return chunks([script])
    return chunks(script)
  }
  dispatch.calls = calls
  return dispatch
}

const stopChunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hello' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('normalizeChainEntry validates provider and model', () => {
  assert.deepEqual(normalizeChainEntry({ provider: ' opencode-go ', model: ' deepseek-v4.1-flash ' }), {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
  })
  assert.deepEqual(normalizeChainEntry({ provider: 'a', model: '', label: ' A ' }), { provider: 'a', model: '', label: 'A' })
  assert.equal(normalizeChainEntry({ model: 'x' }), null)
  assert.equal(normalizeChainEntry(null), null)
})

test('normalizeChain drops invalid entries and duplicate providers', () => {
  const chain = normalizeChain([
    { provider: 'a', model: 'm1' },
    { provider: 'b', model: 'm2' },
    { provider: 'a', model: 'm3' },
    { provider: '', model: 'm' },
    'nope',
  ])
  assert.deepEqual(
    chain.map((entry) => entry.provider),
    ['a', 'b'],
  )
  assert.deepEqual(normalizeChain(undefined), [])
})

test('resolveConfig layers defaults, row config, and overrides', () => {
  const config = resolveConfig(
    { ...DEFAULT_CONFIG, cooldowns: {} },
    { enabled: true, chain: [{ provider: 'row', model: 'm' }] },
    { chain: [{ provider: 'ui', model: 'm2' }], maxAttempts: 99, fallbackCodes: ['QUOTA', ''] },
  )
  assert.equal(config.enabled, true)
  assert.deepEqual(
    config.chain.map((entry) => entry.provider),
    ['ui'],
  )
  assert.equal(config.maxAttempts, 8)
  assert.deepEqual(config.fallbackCodes, ['QUOTA'])
})

test('resolveConfig keeps disabled state from any layer', () => {
  assert.equal(resolveConfig(DEFAULT_CONFIG, { enabled: false }, {}).enabled, false)
  assert.equal(resolveConfig(DEFAULT_CONFIG, { enabled: true }, { enabled: false }).enabled, false)
})

function healthFor(providers) {
  const health = createHealthStore({ now: () => 1000 })
  for (const provider of providers) health.markFailure(provider, { code: 'QUOTA', message: 'quota' }, 60_000)
  return health
}

test('planAttempts starts at the selected provider inside the chain', () => {
  const chain = normalizeChain([
    { provider: 'a', model: 'ma' },
    { provider: 'b', model: 'mb' },
    { provider: 'c', model: 'mc' },
  ])
  const attempts = planAttempts({
    provider: 'b',
    model: 'mb-selected',
    chain,
    health: createHealthStore({ now: () => 0 }),
    maxAttempts: 8,
  })
  assert.deepEqual(
    attempts.map((attempt) => `${attempt.provider}:${attempt.model}:${attempt.origin}`),
    ['b:mb-selected:chain', 'c:mc:chain'],
  )
})

test('planAttempts prepends an unlisted selected provider', () => {
  const chain = normalizeChain([
    { provider: 'a', model: 'ma' },
    { provider: 'b', model: 'mb' },
  ])
  const attempts = planAttempts({
    provider: 'z',
    model: 'mz',
    chain,
    health: createHealthStore({ now: () => 0 }),
    maxAttempts: 8,
  })
  assert.deepEqual(
    attempts.map((attempt) => attempt.provider),
    ['z', 'a', 'b'],
  )
})

test('planAttempts skips routes inside their cooldown', () => {
  const chain = normalizeChain([
    { provider: 'a', model: 'ma' },
    { provider: 'b', model: 'mb' },
    { provider: 'c', model: 'mc' },
  ])
  const health = healthFor(['b'])
  const attempts = planAttempts({ provider: 'a', model: 'ma', chain, health, maxAttempts: 8, now: 1000 })
  assert.deepEqual(
    attempts.map((attempt) => attempt.provider),
    ['a', 'c'],
  )
})

test('planAttempts falls back to the selected route when everything is cooling down', () => {
  const chain = normalizeChain([{ provider: 'b', model: 'mb' }])
  const health = healthFor(['a', 'b'])
  const attempts = planAttempts({ provider: 'a', model: 'ma', chain, health, maxAttempts: 8, now: 1000 })
  assert.deepEqual(
    attempts.map((attempt) => attempt.provider),
    ['a'],
  )
})

test('planAttempts caps attempts and drops empty model ids only at the tail', () => {
  const chain = normalizeChain([
    { provider: 'a', model: 'ma' },
    { provider: 'b', model: 'mb' },
    { provider: 'c', model: 'mc' },
  ])
  const attempts = planAttempts({
    provider: 'a',
    model: 'ma',
    chain,
    health: createHealthStore({ now: () => 0 }),
    maxAttempts: 2,
  })
  assert.equal(attempts.length, 2)
})

test('isFallbackFailure matches only configured codes', () => {
  assert.equal(isFallbackFailure({ code: 'QUOTA' }, ['QUOTA']), true)
  assert.equal(isFallbackFailure({ code: 'AUTH' }, ['QUOTA']), false)
  assert.equal(isFallbackFailure(undefined, ['QUOTA']), false)
})

test('cooldownFor prefers retry-after, then configured, then default', () => {
  const config = resolveConfig(DEFAULT_CONFIG, {}, { cooldowns: { RATE_LIMIT: 5000 } })
  assert.equal(cooldownFor({ code: 'QUOTA', providerRetryAfterMs: 1234 }, config), 1234)
  assert.equal(cooldownFor({ code: 'RATE_LIMIT' }, config), 5000)
  assert.equal(cooldownFor({ code: 'QUOTA' }, config), DEFAULT_COOLDOWNS.QUOTA)
  assert.equal(cooldownFor({ code: 'MYSTERY' }, config), 60_000)
})

test('health store expires cooldowns, clears on success, and round-trips', () => {
  let now = 100
  const health = createHealthStore({ now: () => now })
  health.markAttempt('a')
  health.markFailure('a', { code: 'QUOTA', message: 'quota exceeded' }, 1000)
  assert.equal(health.isDegraded('a'), true)
  assert.equal(health.isDegraded('b'), false)
  now = 1200
  assert.equal(health.isDegraded('a'), false)

  health.markFailure('a', { code: 'RATE_LIMIT', message: 'rate' }, 5000)
  health.markSuccess('a')
  assert.equal(health.isDegraded('a'), false)

  health.markFailure('b', { code: 'QUOTA', message: 'quota' }, 5000)
  const snapshot = health.snapshot()
  assert.equal(snapshot.degraded.b.code, 'QUOTA')
  assert.equal(snapshot.stats.a.successes, 1)
  assert.equal(snapshot.stats.a.failures, 2)

  const restored = createHealthStore({ now: () => now })
  restored.hydrate(snapshot)
  assert.equal(restored.isDegraded('b'), true)
  assert.equal(restored.snapshot().stats.b.failures, 1)
  restored.reset()
  assert.equal(restored.isDegraded('b'), false)
})

test('isContentChunk classifies chunk types', () => {
  assert.equal(isContentChunk({ type: 'text-delta' }), true)
  assert.equal(isContentChunk({ type: 'block-start' }), false)
  assert.equal(isContentChunk({ type: 'usage' }), false)
  assert.equal(isContentChunk(null), false)
})

test('runFallbackStream falls back on a quota failure before content', async () => {
  const dispatch = scriptedDispatch([
    [ { type: 'block-start', index: 0, blockType: 'text' }, fail('QUOTA') ],
    stopChunks,
  ])
  const events = []
  const out = await collect(
    runFallbackStream({
      options: { provider: 'a', model: 'ma', messages: [] },
      attempts: [
        { provider: 'a', model: 'ma', origin: 'selected' },
        { provider: 'b', model: 'mb', origin: 'chain' },
      ],
      fallbackCodes: ['QUOTA'],
      dispatch,
      onEvent: (event) => events.push(event),
    }),
  )
  assert.equal(dispatch.calls.length, 2)
  assert.equal(dispatch.calls[1].provider, 'b')
  assert.deepEqual(
    out.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'finish'],
  )
  assert.equal(out.at(-1).reason.kind, 'stop')
  assert.deepEqual(
    events.map((event) => event.type),
    ['attempt-start', 'attempt-failed', 'attempt-start', 'attempt-succeeded'],
  )
})

test('runFallbackStream does not leak buffered framing chunks from a failed attempt', async () => {
  const dispatch = scriptedDispatch([
    [{ type: 'block-start', index: 0, blockType: 'reasoning' }, fail('QUOTA')],
    stopChunks,
  ])
  const out = await collect(
    runFallbackStream({
      options: { provider: 'a', model: 'ma', messages: [] },
      attempts: [
        { provider: 'a', model: 'ma' },
        { provider: 'b', model: 'mb' },
      ],
      fallbackCodes: ['QUOTA'],
      dispatch,
    }),
  )
  assert.deepEqual(
    out.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'finish'],
  )
})

test('runFallbackStream refuses to fall back after content was streamed', async () => {
  const dispatch = scriptedDispatch([
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial' },
      fail('RATE_LIMIT'),
    ],
    stopChunks,
  ])
  const out = await collect(
    runFallbackStream({
      options: { provider: 'a', model: 'ma', messages: [] },
      attempts: [
        { provider: 'a', model: 'ma' },
        { provider: 'b', model: 'mb' },
      ],
      fallbackCodes: ['RATE_LIMIT'],
      dispatch,
    }),
  )
  assert.equal(dispatch.calls.length, 1)
  assert.equal(out.at(-1).reason.kind, 'error')
  assert.equal(out.at(-1).reason.failure.code, 'RATE_LIMIT')
  assert.equal(out.filter((chunk) => chunk.type === 'text-delta').length, 1)
})

test('runFallbackStream does not fall back on a non-trigger code', async () => {
  const dispatch = scriptedDispatch([fail('INVALID_REQUEST'), stopChunks])
  const out = await collect(
    runFallbackStream({
      options: { provider: 'a', model: 'ma', messages: [] },
      attempts: [
        { provider: 'a', model: 'ma' },
        { provider: 'b', model: 'mb' },
      ],
      fallbackCodes: ['QUOTA'],
      dispatch,
    }),
  )
  assert.equal(dispatch.calls.length, 1)
  assert.equal(out.at(-1).reason.failure.code, 'INVALID_REQUEST')
})

test('runFallbackStream reports the last failure when the chain is exhausted', async () => {
  const dispatch = scriptedDispatch([fail('QUOTA'), fail('ACCOUNT_QUOTA')])
  const out = await collect(
    runFallbackStream({
      options: { provider: 'a', model: 'ma', messages: [] },
      attempts: [
        { provider: 'a', model: 'ma' },
        { provider: 'b', model: 'mb' },
      ],
      fallbackCodes: ['QUOTA', 'ACCOUNT_QUOTA'],
      dispatch,
    }),
  )
  assert.equal(dispatch.calls.length, 2)
  assert.equal(out.length, 1)
  assert.equal(out[0].reason.failure.code, 'ACCOUNT_QUOTA')
  assert.match(out[0].reason.failure.message, /fallback chain exhausted/)
})

test('runFallbackStream passes a successful single attempt through unchanged', async () => {
  const dispatch = scriptedDispatch([stopChunks])
  const out = await collect(
    runFallbackStream({
      options: { provider: 'a', model: 'ma', messages: [] },
      attempts: [{ provider: 'a', model: 'ma' }],
      fallbackCodes: ['QUOTA'],
      dispatch,
    }),
  )
  assert.deepEqual(out, stopChunks)
})

test('runFallbackStream yields an aborted finish for an aborted request', async () => {
  const dispatch = scriptedDispatch([stopChunks])
  const out = await collect(
    runFallbackStream({
      options: { provider: 'a', model: 'ma', messages: [] },
      attempts: [{ provider: 'a', model: 'ma' }],
      fallbackCodes: ['QUOTA'],
      dispatch,
      signal: { aborted: true },
    }),
  )
  assert.equal(out[0].reason.kind, 'aborted')
  assert.equal(dispatch.calls.length, 0)
})

test('runFallbackStream synthesizes a transport failure for a finish-less stream', async () => {
  const dispatch = scriptedDispatch([[{ type: 'block-start', index: 0, blockType: 'text' }]])
  const out = await collect(
    runFallbackStream({
      options: { provider: 'a', model: 'ma', messages: [] },
      attempts: [{ provider: 'a', model: 'ma' }],
      fallbackCodes: ['TRANSPORT'],
      dispatch,
    }),
  )
  assert.equal(out.at(-1).reason.failure.code, 'TRANSPORT')
})

test('runFallbackStream handles an empty attempt list', async () => {
  const out = await collect(
    runFallbackStream({
      options: { provider: 'a', model: 'ma', messages: [] },
      attempts: [],
      fallbackCodes: ['QUOTA'],
      dispatch: scriptedDispatch([stopChunks]),
    }),
  )
  assert.equal(out[0].reason.failure.code, 'NO_ROUTE')
})

test('runFallbackStream propagates a thrown dispatch error', async () => {
  const dispatch = () => {
    throw new Error('middleware exploded')
  }
  await assert.rejects(
    collect(
      runFallbackStream({
        options: { provider: 'a', model: 'ma', messages: [] },
        attempts: [{ provider: 'a', model: 'ma' }],
        fallbackCodes: ['QUOTA'],
        dispatch,
      }),
    ),
    /middleware exploded/,
  )
})

test('sanitizeAttemptOptions drops unsupported reasoning effort and clamps nothing else', () => {
  const options = { provider: 'a', model: 'm', reasoningEffort: 'max', maxTokens: 100, temperature: 0.2, messages: [] }
  const supported = sanitizeAttemptOptions(options, { reasoning: { efforts: [{ id: 'max' }] } })
  assert.equal(supported.reasoningEffort, 'max')
  const unsupported = sanitizeAttemptOptions(options, { reasoning: { efforts: [{ id: 'low' }] } })
  assert.equal('reasoningEffort' in unsupported, false)
  assert.equal(unsupported.maxTokens, 100)
  assert.equal(options.reasoningEffort, 'max')
})

test('stripReasoningBlocks removes provider-native thinking history only', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      source: { kind: 'model', provider: 'a', model: 'm' },
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'answer' },
      ],
    },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'only thinking' }] },
    { role: 'tool', content: [{ type: 'text', text: 'result' }] },
  ]
  const stripped = stripReasoningBlocks(messages)
  assert.equal(stripped.length, 3)
  assert.equal(stripped[1].content.length, 1)
  assert.equal(stripped[1].content[0].text, 'answer')
  assert.equal(stripped[1].source.provider, 'a')
  const unchanged = messages.slice(0, 1)
  assert.equal(stripReasoningBlocks(unchanged), unchanged)
})

test('sanitizeAttemptOptions strips thinking history and pins reasoning off across providers', () => {
  const options = {
    provider: 'a',
    model: 'm',
    reasoningEffort: 'max',
    messages: [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'ok' }] },
    ],
  }
  const cross = sanitizeAttemptOptions(options, { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }, {
    crossProvider: true,
  })
  assert.equal(cross.reasoningEffort, 'off')
  assert.equal(cross.messages[0].content.length, 1)
  assert.equal(options.messages[0].content.length, 2)
  const withoutOff = sanitizeAttemptOptions(options, { reasoning: { efforts: [{ id: 'high' }] } }, {
    crossProvider: true,
  })
  assert.equal('reasoningEffort' in withoutOff, false)
})

test('errorFinish keeps the failure envelope and appends a suffix', () => {
  const finish = errorFinish({ code: 'QUOTA', message: 'nope', status: 429 }, '[x]')
  assert.equal(finish.reason.failure.code, 'QUOTA')
  assert.equal(finish.reason.failure.status, 429)
  assert.match(finish.reason.failure.message, /nope \[x\]/)
})

test('pushBounded keeps the newest events', () => {
  const buffer = []
  for (let index = 0; index < 5; index += 1) pushBounded(buffer, { index }, 3)
  assert.deepEqual(
    buffer.map((event) => event.index),
    [2, 3, 4],
  )
  assert.deepEqual(pushBounded([], { index: 0 }, 0), [])
})

test('attemptLabel renders provider/model', () => {
  assert.equal(attemptLabel({ provider: 'a', model: 'b' }), 'a/b')
})
