/**
 * Routers this plugin pools multiple API accounts for.
 *
 * An account is not a provider route: every account authenticates through the
 * same provider route (same endpoint, protocol, model catalog), and the plugin
 * rotates the API key per request through the `llm-pi-ai/request-headers`
 * waterfall. The route's own configured key is the implicit first account
 * ("default"); added accounts store their keys through the Harness credentials
 * service under a generated reference name and never enter configuration or
 * the state file.
 *
 * @module dsh-fallback/accounts
 */

import { randomBytes } from 'node:crypto'

/** Id of the implicit account backed by the route's own configured key. */
export const DEFAULT_ACCOUNT_ID = 'default'

/** Prefix every account key reference this plugin stores starts with. */
export const ACCOUNT_REF_PREFIX = 'DSH_FALLBACK'

/** Longest label the settings page may store. */
const MAX_LABEL = 40

/** Cap on added accounts per provider (keeps the attempt list and UI sane). */
export const MAX_ACCOUNTS_PER_PROVIDER = 8

/** Printable-ASCII key shape the HTTP header layer can carry (space excluded). */
const API_KEY_PATTERN = /^[\x21-\x7E]{8,512}$/

/**
 * Provider routes that support account pooling out of the box. The mechanism
 * itself is provider-agnostic; the list bounds what the settings page offers.
 */
export const ACCOUNT_PROVIDERS = Object.freeze(['opencode-go', 'opencode'])

/** Generate one opaque account id. */
export function newAccountId() {
  return randomBytes(5).toString('hex')
}

/** Sanitize one provider id into a credential-reference segment. */
function refSegment(provider) {
  return String(provider)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
}

/**
 * Build the credential reference name for one added account.
 * @param {string} provider - provider route id.
 * @param {string} id - account id.
 * @returns {string} an env-style reference name accepted by the credentials service.
 */
export function refForAccount(provider, id) {
  return `${ACCOUNT_REF_PREFIX}_${refSegment(provider)}_${refSegment(id)}`
}

/**
 * Build the health-store key for one account. The provider route itself stays
 * healthy while one account is exhausted.
 * @param {string} provider - provider route id.
 * @param {string} id - account id.
 * @returns {string} a namespaced health key.
 */
export function accountHealthKey(provider, id) {
  return `account:${provider}:${id}`
}

/** Normalize one account label, falling back to a numbered default. */
export function normalizeLabel(label, fallback) {
  const text = typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : ''
  if (text.length === 0) return fallback
  return text.slice(0, MAX_LABEL)
}

/**
 * Validate one new-account submission.
 * @param {{label?: unknown, key?: unknown}} input - form values.
 * @param {string} fallbackLabel - label used when the form left it empty.
 * @returns {{ok: true, label: string, key: string} | {ok: false, error: string}} validation.
 */
export function validateNewAccount(input, fallbackLabel) {
  const rawKey = typeof input?.key === 'string' ? input.key.trim() : ''
  if (rawKey.length === 0) return { ok: false, error: 'missing-key' }
  if (!API_KEY_PATTERN.test(rawKey)) return { ok: false, error: 'invalid-key' }
  return { ok: true, label: normalizeLabel(input?.label, fallbackLabel), key: rawKey }
}

/** Normalize the persisted accounts dictionary. */
export function normalizeAccountsState(raw) {
  const out = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [provider, list] of Object.entries(raw)) {
    if (typeof provider !== 'string' || provider.length === 0 || !Array.isArray(list)) continue
    const seen = new Set()
    const accounts = []
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      if (id.length === 0 || id === DEFAULT_ACCOUNT_ID || seen.has(id)) continue
      seen.add(id)
      accounts.push({
        id,
        label: normalizeLabel(entry.label, `account ${accounts.length + 2}`),
        keyRef: typeof entry.keyRef === 'string' && entry.keyRef.length > 0 ? entry.keyRef : refForAccount(provider, id),
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
      })
      if (accounts.length >= MAX_ACCOUNTS_PER_PROVIDER) break
    }
    if (accounts.length > 0) out[provider] = accounts
  }
  return out
}

/**
 * Accounts for one provider, ordered for attempts: the route's own key first
 * unless it is cooling down, then added accounts in their configured order.
 * @param {object} accountsState - normalized accounts state.
 * @param {string} provider - provider route id.
 * @returns {Array<{id: string, label: string, kind: 'default' | 'added', keyRef: string | null, healthKey: string}>} accounts.
 */
export function listAccounts(accountsState, provider) {
  const stored = Array.isArray(accountsState?.[provider]) ? accountsState[provider] : []
  return [
    {
      id: DEFAULT_ACCOUNT_ID,
      label: 'default',
      kind: 'default',
      keyRef: null,
      healthKey: accountHealthKey(provider, DEFAULT_ACCOUNT_ID),
    },
    ...stored.map((account) => ({
      id: account.id,
      label: account.label,
      kind: 'added',
      keyRef: account.keyRef,
      healthKey: accountHealthKey(provider, account.id),
      createdAt: account.createdAt,
    })),
  ]
}

/**
 * Append one added account.
 * @param {object} accountsState - normalized accounts state.
 * @param {string} provider - provider route id.
 * @param {{id: string, label: string, keyRef: string, createdAt: string}} account - account to append.
 * @returns {{ok: true, accounts: object} | {ok: false, error: string}} the new state.
 */
export function addAccount(accountsState, provider, account) {
  const stored = Array.isArray(accountsState?.[provider]) ? accountsState[provider].slice() : []
  if (stored.length >= MAX_ACCOUNTS_PER_PROVIDER) return { ok: false, error: 'too-many-accounts' }
  if (stored.some((entry) => entry.id === account.id)) return { ok: false, error: 'duplicate-account' }
  stored.push({
    id: account.id,
    label: account.label,
    keyRef: account.keyRef,
    createdAt: account.createdAt,
  })
  return { ok: true, accounts: { ...accountsState, [provider]: stored } }
}

/**
 * Remove one added account.
 * @param {object} accountsState - normalized accounts state.
 * @param {string} provider - provider route id.
 * @param {string} id - account id.
 * @returns {{ok: true, accounts: object, removed: object} | {ok: false, error: string}} the new state.
 */
export function removeAccount(accountsState, provider, id) {
  const stored = Array.isArray(accountsState?.[provider]) ? accountsState[provider].slice() : []
  const index = stored.findIndex((entry) => entry.id === id)
  if (id === DEFAULT_ACCOUNT_ID) return { ok: false, error: 'default-account' }
  if (index < 0) return { ok: false, error: 'unknown-account' }
  const [removed] = stored.splice(index, 1)
  const accounts = { ...accountsState }
  if (stored.length === 0) delete accounts[provider]
  else accounts[provider] = stored
  return { ok: true, accounts, removed }
}

/**
 * Reorder added accounts for one provider.
 * @param {object} accountsState - normalized accounts state.
 * @param {string} provider - provider route id.
 * @param {ReadonlyArray<string>} ids - complete account id order.
 * @returns {{ok: true, accounts: object} | {ok: false, error: string}} the new state.
 */
export function reorderAccounts(accountsState, provider, ids) {
  const stored = Array.isArray(accountsState?.[provider]) ? accountsState[provider].slice() : []
  if (!Array.isArray(ids) || ids.length !== stored.length) return { ok: false, error: 'invalid-order' }
  const byId = new Map(stored.map((entry) => [entry.id, entry]))
  const ordered = []
  for (const id of ids) {
    const entry = byId.get(id)
    if (entry === undefined) return { ok: false, error: 'invalid-order' }
    byId.delete(id)
    ordered.push(entry)
  }
  return { ok: true, accounts: { ...accountsState, [provider]: ordered } }
}

/**
 * Whether one provider may pool accounts in this build.
 * @param {string} provider - provider route id.
 * @returns {boolean} true for the offered routes.
 */
export function supportsAccounts(provider) {
  return ACCOUNT_PROVIDERS.includes(provider)
}
