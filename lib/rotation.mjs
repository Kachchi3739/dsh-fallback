/**
 * Account rotation for pooled API keys on one provider route.
 *
 * Pooled accounts are not separate provider routes: every account speaks to the
 * same endpoint and model catalog, only the API key differs. This module decides
 * which account a request starts on and in which order the remaining accounts
 * are tried when that key is exhausted.
 *
 * Three modes are supported:
 *
 * - `rotate`   — round-robin per request. Every request advances the cursor, so
 *                consecutive calls spread across all healthy accounts.
 * - `sticky`   — round-robin per session. The first request of a session picks
 *                an account and later requests of that session keep it, which
 *                preserves the provider's prompt cache; a new session picks the
 *                next account, and an exhausted account is replaced on the next
 *                request.
 * - `failover` — the configured order (default account first). Later accounts
 *                are only used when the earlier ones fail.
 *
 * Nothing here touches Cordis, the filesystem, or the network; the Host passes
 * the live account list and health store in and receives the ordered list back.
 *
 * @module dsh-fallback/rotation
 */

/** Account usage modes accepted by the settings page. */
export const ACCOUNT_MODES = Object.freeze(['rotate', 'sticky', 'failover'])

/** Usage mode used when none is configured. */
export const DEFAULT_ACCOUNT_MODE = 'rotate'

/** Bound on retained session assignments (keeps memory stable in long runs). */
const MAX_SESSION_ASSIGNMENTS = 512

/**
 * Normalize one account usage mode from configuration or state.
 * @param {unknown} value - candidate mode.
 * @returns {'rotate' | 'sticky' | 'failover'} a supported mode.
 */
export function normalizeAccountMode(value) {
  return typeof value === 'string' && ACCOUNT_MODES.includes(value) ? value : DEFAULT_ACCOUNT_MODE
}

/** Create the mutable rotation bookkeeping shared by every request. */
export function createRotationState() {
  return {
    /** Per-provider round-robin cursor. */
    cursors: {},
    /** `${provider}\u0000${sessionId}` -> account id (insertion ordered). */
    sessions: new Map(),
  }
}

/**
 * Drop one removed account from the session assignments.
 * The cursor is left alone: it only ever points at a list position, which the
 * next call normalizes against the current list length.
 * @param {ReturnType<typeof createRotationState>} state - rotation state.
 * @param {string} provider - provider route id.
 * @param {string} id - removed account id.
 */
export function forgetAccountRotation(state, provider, id) {
  if (typeof state !== 'object' || state === null || !(state.sessions instanceof Map)) return
  const prefix = `${provider}\u0000`
  for (const [key, value] of state.sessions) {
    if (key.startsWith(prefix) && value === id) state.sessions.delete(key)
  }
}

/**
 * Order one provider's accounts for the request that is about to start.
 *
 * The returned list is the attempt order: the chosen account first, then the
 * remaining healthy accounts, then accounts currently inside their cooldown
 * window (the plan step removes those, and falls back to the first listed
 * account when nothing is healthy).
 *
 * @param {object} input - rotation input.
 * @param {ReadonlyArray<{id: string, healthKey: string}>} input.accounts - canonical account list (default first).
 * @param {'rotate' | 'sticky' | 'failover'} input.mode - usage mode.
 * @param {string} input.provider - provider route id.
 * @param {string | undefined} input.sessionId - conversation id, when the caller has one.
 * @param {{isDegraded: (key: string, now?: number) => boolean} | undefined} input.health - health store.
 * @param {number} [input.now] - clock override for tests.
 * @param {ReturnType<typeof createRotationState>} input.state - rotation state.
 * @returns {Array<{id: string, healthKey: string}>} ordered accounts (empty only when the input is empty).
 */
export function orderAccounts(input) {
  const accounts = Array.isArray(input.accounts) ? input.accounts.slice() : []
  if (accounts.length <= 1) return accounts
  const mode = normalizeAccountMode(input.mode)
  if (mode === 'failover') return accounts
  const state = input.state ?? createRotationState()
  if (!(state.sessions instanceof Map)) state.sessions = new Map()
  if (typeof state.cursors !== 'object' || state.cursors === null) state.cursors = {}
  const now = input.now ?? Date.now()
  const healthy =
    input.health === undefined
      ? accounts
      : accounts.filter((account) => !input.health.isDegraded(account.healthKey, now))
  // Every account is cooling down: keep the canonical order. The planner has
  // its own last-resort rule and will attempt the first one anyway.
  if (healthy.length === 0) return accounts

  if (mode === 'sticky' && typeof input.sessionId === 'string' && input.sessionId.length > 0) {
    const key = `${input.provider}\u0000${input.sessionId}`
    const assigned = state.sessions.get(key)
    const match = typeof assigned === 'string' ? healthy.find((account) => account.id === assigned) : undefined
    if (match !== undefined) {
      const others = healthy.filter((account) => account.id !== match.id)
      return pruneAndReturn(state, [match, ...others])
    }
    const cursor = Number.isFinite(Number(state.cursors[input.provider])) ? Math.trunc(Number(state.cursors[input.provider])) : 0
    const index = ((cursor % healthy.length) + healthy.length) % healthy.length
    const picked = healthy[index]
    state.cursors[input.provider] = (index + 1) % healthy.length
    state.sessions.set(key, picked.id)
    trimSessions(state)
    const others = healthy.filter((account) => account.id !== picked.id)
    return [picked, ...others]
  }

  const cursor = Number.isFinite(Number(state.cursors[input.provider])) ? Math.trunc(Number(state.cursors[input.provider])) : 0
  const index = ((cursor % healthy.length) + healthy.length) % healthy.length
  const picked = healthy[index]
  state.cursors[input.provider] = (index + 1) % healthy.length
  return [picked, ...healthy.slice(index + 1), ...healthy.slice(0, index)]
}

/**
 * Trim the session assignment map to its bound (oldest insertion first).
 * @param {ReturnType<typeof createRotationState>} state - rotation state.
 */
function trimSessions(state) {
  while (state.sessions.size > MAX_SESSION_ASSIGNMENTS) {
    const oldest = state.sessions.keys().next()
    if (oldest.done === true) return
    state.sessions.delete(oldest.value)
  }
}

/**
 * Bookkeeping helper kept separate so the early-return path above stays flat.
 * @param {ReturnType<typeof createRotationState>} state - rotation state.
 * @param {Array<{id: string, healthKey: string}>} accounts - ordered accounts.
 * @returns {Array<{id: string, healthKey: string}>} the same list.
 */
function pruneAndReturn(state, accounts) {
  trimSessions(state)
  return accounts
}
