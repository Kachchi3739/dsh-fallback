import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createEventLog,
  createStateWriter,
  emptyState,
  loadState,
  mergeOverrides,
  normalizeOverrides,
  resolveStateDir,
  resolveStateFile,
  saveState,
  STATE_VERSION,
} from '../lib/state.mjs'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'dsh-fallback-state-'))

test('resolveStateDir prefers the profile dir, then DSH_HOME', () => {
  assert.equal(resolveStateDir({ DSH_PROFILE_DIR: 'C:/profile' }), path.join('C:/profile', '.dsh-fallback'))
  const fallback = resolveStateDir({ DSH_HOME: 'C:/home' })
  assert.equal(fallback, path.join('C:/home', 'fallback'))
  assert.equal(resolveStateFile({ DSH_PROFILE_DIR: 'C:/profile' }), path.join('C:/profile', '.dsh-fallback', 'state.json'))
})

test('normalizeOverrides keeps only known, valid fields', () => {
  const normalized = normalizeOverrides({
    enabled: false,
    accountMode: 'sticky',
    chain: [{ provider: 'a', model: 'm' }, { provider: 'a', model: 'm2' }, { model: 'x' }],
    fallbackCodes: ['QUOTA', 'NOPE', 42],
    maxAttempts: 99,
    probeTimeoutMs: 10,
    logLimit: -5,
    cooldowns: { QUOTA: 1000, NOPE: 2000, RATE_LIMIT: -9 },
    unknown: 'dropped',
  })
  assert.deepEqual(normalized.chain, [{ provider: 'a', model: 'm' }])
  assert.equal(normalized.accountMode, 'sticky')
  assert.deepEqual(normalized.fallbackCodes, ['QUOTA'])
  assert.equal(normalized.maxAttempts, 8)
  assert.equal(normalized.probeTimeoutMs, 1000)
  assert.equal(normalized.logLimit, 0)
  assert.deepEqual(normalized.cooldowns, { QUOTA: 1000, RATE_LIMIT: 0 })
  assert.equal('unknown' in normalized, false)
})

test('mergeOverrides deep-merges cooldowns and revalidates', () => {
  const merged = mergeOverrides(
    { chain: [{ provider: 'a', model: 'm' }], cooldowns: { QUOTA: 1000 } },
    { chain: [{ provider: 'b', model: 'm2' }], cooldowns: { RATE_LIMIT: 250 } },
  )
  assert.deepEqual(merged.chain, [{ provider: 'b', model: 'm2' }])
  assert.deepEqual(merged.cooldowns, { QUOTA: 1000, RATE_LIMIT: 250 })
})

test('an unknown account mode is dropped instead of overriding the default', () => {
  assert.equal('accountMode' in normalizeOverrides({ accountMode: 'nope' }), false)
  assert.equal(normalizeOverrides({ accountMode: 'failover' }).accountMode, 'failover')
})

test('save and load round-trip the state file', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'nested', 'state.json')
    const state = {
      ...emptyState(),
      overrides: { enabled: true, chain: [{ provider: 'a', model: 'm' }] },
      health: { degraded: { a: { until: 123, code: 'QUOTA', message: 'q', since: 1 } } },
      events: [{ at: 'now', kind: 'fallback' }],
    }
    const saved = saveState(file, state)
    assert.equal(saved.ok, true)
    const loaded = loadState(file)
    assert.equal(loaded.overrides.chain[0].provider, 'a')
    assert.equal(loaded.health.degraded.a.code, 'QUOTA')
    assert.equal(loaded.events.length, 1)
    assert.equal(loaded.version, STATE_VERSION)
    assert.match(readFileSync(file, 'utf8'), /"updatedAt"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing or malformed state degrades to empty state', () => {
  const dir = tempDir()
  try {
    assert.deepEqual(loadState(path.join(dir, 'missing.json')), emptyState())
    const broken = path.join(dir, 'broken.json')
    writeFileSync(broken, '{not json', 'utf8')
    assert.deepEqual(loadState(broken), emptyState())
    const wrongShape = path.join(dir, 'wrong.json')
    writeFileSync(wrongShape, JSON.stringify({ overrides: null, events: 'x' }), 'utf8')
    const loaded = loadState(wrongShape)
    assert.deepEqual(loaded.overrides, {})
    assert.deepEqual(loaded.events, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveState reports an unwritable target instead of throwing', () => {
  const dir = tempDir()
  try {
    const blocker = path.join(dir, 'blocker')
    writeFileSync(blocker, 'file, not a directory', 'utf8')
    const result = saveState(path.join(blocker, 'state.json'), emptyState())
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the event log keeps the newest bounded entries and can clear', () => {
  let now = 1000
  const log = createEventLog([{ kind: 'old' }], () => now)
  log.setLimit(2)
  log.record({ kind: 'a' })
  now = 2000
  log.record({ kind: 'b' })
  const snapshot = log.snapshot()
  assert.deepEqual(
    snapshot.map((event) => event.kind),
    ['a', 'b'],
  )
  assert.equal(snapshot[0].at, new Date(1000).toISOString())
  log.clear()
  assert.deepEqual(log.snapshot(), [])
  log.setLimit(0)
  log.record({ kind: 'c' })
  assert.deepEqual(log.snapshot(), [])
})

test('the state writer debounces and flushes pending writes', async () => {
  const dir = tempDir()
  try {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'state.json')
    let value = 0
    const writer = createStateWriter(file, () => ({ ...emptyState(), overrides: { logLimit: value } }), { delayMs: 10 })
    writer.schedule()
    writer.schedule()
    value = 7
    writer.flush()
    const loaded = loadState(file)
    assert.equal(loaded.overrides.logLimit, 7)
    assert.equal(writer.lastError(), null)
    writer.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
