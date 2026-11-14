/**
 * Unit tests for the pure account-rotation helpers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACCOUNT_MODES,
  DEFAULT_ACCOUNT_MODE,
  createRotationState,
  forgetAccountRotation,
  normalizeAccountMode,
  orderAccounts,
} from '../lib/rotation.mjs'

/** Minimal ordered account list. */
const accounts = [
  { id: 'default', label: 'default', kind: 'default', healthKey: 'account:opencode-go:default' },
  { id: 'a2', label: 'account 2', kind: 'added', healthKey: 'account:opencode-go:a2' },
  { id: 'a3', label: 'account 3', kind: 'added', healthKey: 'account:opencode-go:a3' },
]

/** Health double with a manual degraded set. */
function healthWith(degraded = []) {
  const set = new Set(degraded)
  return { isDegraded: (key) => set.has(key) }
}

test('normalizeAccountMode accepts only the three modes and defaults to rotate', () => {
  assert.deepEqual(ACCOUNT_MODES, ['rotate', 'sticky', 'failover'])
  assert.equal(DEFAULT_ACCOUNT_MODE, 'rotate')
  assert.equal(normalizeAccountMode('sticky'), 'sticky')
  assert.equal(normalizeAccountMode('failover'), 'failover')
  assert.equal(normalizeAccountMode('rotate'), 'rotate')
  assert.equal(normalizeAccountMode('nope'), 'rotate')
  assert.equal(normalizeAccountMode(undefined), 'rotate')
})

test('failover keeps the configured order', () => {
  const state = createRotationState()
  assert.deepEqual(
    orderAccounts({ accounts, mode: 'failover', provider: 'opencode-go', state, health: healthWith() }).map((a) => a.id),
    ['default', 'a2', 'a3'],
  )
  assert.deepEqual(state.cursors, {})
})

test('rotate advances one account per request and wraps around', () => {
  const state = createRotationState()
  const seen = []
  for (let index = 0; index < 4; index += 1) {
    seen.push(
      orderAccounts({ accounts, mode: 'rotate', provider: 'opencode-go', state, health: healthWith() }).map((a) => a.id),
    )
  }
  assert.deepEqual(seen, [
    ['default', 'a2', 'a3'],
    ['a2', 'a3', 'default'],
    ['a3', 'default', 'a2'],
    ['default', 'a2', 'a3'],
  ])
})

test('rotate skips a degraded account and advances the cursor over the healthy list', () => {
  const state = createRotationState()
  const ordered = orderAccounts({
    accounts,
    mode: 'rotate',
    provider: 'opencode-go',
    state,
    health: healthWith(['account:opencode-go:default']),
  })
  assert.deepEqual(
    ordered.map((account) => account.id),
    ['a2', 'a3'],
  )
  assert.equal(state.cursors['opencode-go'], 1)
})

test('rotate falls back to the canonical order when every account is degraded', () => {
  const state = createRotationState()
  const ordered = orderAccounts({
    accounts,
    mode: 'rotate',
    provider: 'opencode-go',
    state,
    health: healthWith(accounts.map((account) => account.healthKey)),
  })
  assert.deepEqual(
    ordered.map((account) => account.id),
    ['default', 'a2', 'a3'],
  )
})

test('sticky keeps a session on its account and starts a new session on the next one', () => {
  const state = createRotationState()
  const first = orderAccounts({
    accounts,
    mode: 'sticky',
    provider: 'opencode-go',
    sessionId: 'session-1',
    state,
    health: healthWith(),
  })
  assert.equal(first[0].id, 'default')
  const again = orderAccounts({
    accounts,
    mode: 'sticky',
    provider: 'opencode-go',
    sessionId: 'session-1',
    state,
    health: healthWith(),
  })
  assert.equal(again[0].id, 'default')
  const second = orderAccounts({
    accounts,
    mode: 'sticky',
    provider: 'opencode-go',
    sessionId: 'session-2',
    state,
    health: healthWith(),
  })
  assert.equal(second[0].id, 'a2')
  assert.equal(state.sessions.get('opencode-go\u0000session-1'), 'default')
})

test('sticky replaces a degraded assignment on the next request', () => {
  const state = createRotationState()
  orderAccounts({ accounts, mode: 'sticky', provider: 'opencode-go', sessionId: 's', state, health: healthWith() })
  const replaced = orderAccounts({
    accounts,
    mode: 'sticky',
    provider: 'opencode-go',
    sessionId: 's',
    state,
    health: healthWith(['account:opencode-go:default']),
  })
  assert.equal(replaced[0].id, 'a3')
  assert.equal(state.sessions.get('opencode-go\u0000s'), 'a3')
})

test('sticky without a session id behaves like rotate', () => {
  const state = createRotationState()
  const first = orderAccounts({ accounts, mode: 'sticky', provider: 'opencode-go', state, health: healthWith() })
  const second = orderAccounts({ accounts, mode: 'sticky', provider: 'opencode-go', state, health: healthWith() })
  assert.equal(first[0].id, 'default')
  assert.equal(second[0].id, 'a2')
})

test('forgetAccountRotation drops only the removed account assignments', () => {
  const state = createRotationState()
  orderAccounts({ accounts, mode: 'sticky', provider: 'opencode-go', sessionId: 'one', state, health: healthWith() })
  orderAccounts({ accounts, mode: 'sticky', provider: 'opencode-go', sessionId: 'two', state, health: healthWith() })
  forgetAccountRotation(state, 'opencode-go', 'default')
  assert.deepEqual([...state.sessions.keys()], ['opencode-go\u0000two'])
})

test('one account keeps the list unchanged in every mode', () => {
  for (const mode of ACCOUNT_MODES) {
    const state = createRotationState()
    assert.deepEqual(
      orderAccounts({ accounts: accounts.slice(0, 1), mode, provider: 'opencode-go', state, health: healthWith() }).map(
        (account) => account.id,
      ),
      ['default'],
    )
  }
})
