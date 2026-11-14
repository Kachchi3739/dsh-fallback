/**
 * Durable state for `dsh-fallback`: user overrides, provider health, and the
 * bounded fallback event log.
 *
 * The bundle row's Config is the deployment default; anything the settings
 * page changes is stored as an override in this state file so the user's
 * `cordis.patch.yml` is never rewritten by plugin code. The file contains no
 * secrets: provider ids, model ids, codes and timings only.
 *
 * @module dsh-fallback/state
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { KNOWN_FALLBACK_CODES, normalizeChain } from './engine.mjs'
import { ACCOUNT_MODES, normalizeAccountMode } from './rotation.mjs'
import { normalizeAccountsState } from './accounts.mjs'

/** Replace the user's home directory in a path returned to clients. */
export function redactPath(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  const homes = [os.homedir(), process.env.USERPROFILE, process.env.HOME]
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((entry) => entry.replace(/[\\/]+$/, ''))
    .filter((entry) => entry.length > 0)
  let out = value
  for (const home of homes) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped, 'gi'), '~')
  }
  return out
}

/** Strip provider URLs, organization ids and credential-shaped tokens from a stored message. */
export function redactMessage(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  return value
    .replace(/https?:\/\/[^\s)"']+/gi, '[url]')
    .replace(/\borg_[A-Za-z0-9]+\b/g, 'org_***')
    .replace(/\b(?:sk|oc)[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .slice(0, 240)
}

/** Replace a session id with a short stable tag so event history cannot identify the session. */
export function redactSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (/^session:[0-9a-f]{8}$/.test(value)) return value
  return `session:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`
}

/** Apply the message/session redactions to one stored event. */
export function redactEvent(event) {
  if (typeof event !== 'object' || event === null) return event
  const out = { ...event }
  if ('sessionId' in out) out.sessionId = redactSessionId(out.sessionId)
  if (typeof out.message === 'string') out.message = redactMessage(out.message)
  return out
}

/** Redact stored degradation messages before anything returns them. */
export function redactHealth(health) {
  if (typeof health !== 'object' || health === null) return health
  const out = { ...health }
  if (typeof out.degraded === 'object' && out.degraded !== null) {
    const degraded = {}
    for (const [key, record] of Object.entries(out.degraded)) {
      degraded[key] =
        typeof record === 'object' && record !== null ? { ...record, message: redactMessage(record.message) } : record
    }
    out.degraded = degraded
  }
  return out
}

/** State schema version; a different version discards overrides, not health. */
export const STATE_VERSION = 1

/** Resolve the state directory for this harness profile. */
export function resolveStateDir(env = process.env) {
  const profileDir = typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.length > 0 ? env.DSH_PROFILE_DIR : null
  if (profileDir !== null) return path.join(profileDir, '.dsh-fallback')
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(home, 'fallback')
}

/** Resolve the state file path. */
export function resolveStateFile(env = process.env) {
  return path.join(resolveStateDir(env), 'state.json')
}

/** Empty in-memory state. */
export function emptyState() {
  return { version: STATE_VERSION, overrides: {}, accounts: {}, health: {}, events: [], updatedAt: null }
}

/**
 * Read the state file. A missing, unreadable, or malformed file degrades to
 * empty state: the plugin keeps working with the row's Config.
 * @param {string} file - absolute state file path.
 * @returns {object} normalized state.
 */
export function loadState(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return emptyState()
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyState()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyState()
  const state = emptyState()
  const overrides = normalizeOverrides(parsed.overrides)
  state.overrides = overrides
  state.accounts = normalizeAccountsState(parsed.accounts)
  state.health = redactHealth(typeof parsed.health === 'object' && parsed.health !== null ? parsed.health : {})
  if (Array.isArray(parsed.events)) {
    state.events = parsed.events
      .filter((event) => typeof event === 'object' && event !== null)
      .map(redactEvent)
  }
  state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
  return state
}

/**
 * Atomically write the state file (temp file + rename) and fsync the directory
 * where the platform allows it. Failure is reported, never thrown: a read-only
 * profile must not break model calls.
 * @param {string} file - absolute state file path.
 * @param {object} state - state to persist.
 * @returns {{ok: true} | {ok: false, error: string}} the write result.
 */
export function saveState(file, state) {
  try {
    const directory = path.dirname(file)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(directory, 0o700)
    } catch {
      // Windows ACLs and read-only filesystems may reject POSIX modes.
    }
    const payload = JSON.stringify({ ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() }, null, 2)
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Windows ACLs and read-only filesystems may reject POSIX modes.
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Validate and normalize user overrides coming from the settings page.
 * Unknown fields are dropped, so a stale UI cannot inject plugin state.
 * @param {unknown} patch - candidate overrides.
 * @returns {object} a normalized overrides object.
 */
export function normalizeOverrides(patch) {
  const source = typeof patch === 'object' && patch !== null ? patch : {}
  const overrides = {}
  if (typeof source.enabled === 'boolean') overrides.enabled = source.enabled
  if (typeof source.accountMode === 'string' && ACCOUNT_MODES.includes(source.accountMode)) {
    overrides.accountMode = normalizeAccountMode(source.accountMode)
  }
  if (Array.isArray(source.chain)) overrides.chain = normalizeChain(source.chain)
  if (Array.isArray(source.fallbackCodes)) {
    overrides.fallbackCodes = source.fallbackCodes.filter(
      (code) => typeof code === 'string' && KNOWN_FALLBACK_CODES.includes(code),
    )
  }
  if (Number.isFinite(source.maxAttempts)) overrides.maxAttempts = Math.min(8, Math.max(1, Math.trunc(source.maxAttempts)))
  if (Number.isFinite(source.probeTimeoutMs)) {
    overrides.probeTimeoutMs = Math.min(120000, Math.max(1000, Math.trunc(source.probeTimeoutMs)))
  }
  if (Number.isFinite(source.logLimit)) overrides.logLimit = Math.min(200, Math.max(0, Math.trunc(source.logLimit)))
  if (typeof source.cooldowns === 'object' && source.cooldowns !== null) {
    const cooldowns = {}
    for (const [code, value] of Object.entries(source.cooldowns)) {
      if (!KNOWN_FALLBACK_CODES.includes(code)) continue
      if (!Number.isFinite(value)) continue
      cooldowns[code] = Math.min(24 * 60 * 60 * 1000, Math.max(0, Math.trunc(value)))
    }
    overrides.cooldowns = cooldowns
  }
  return overrides
}

/**
 * Merge a partial override patch into the current overrides.
 * @param {object} current - current normalized overrides.
 * @param {object} patch - partial overrides (already normalized).
 * @returns {object} the merged overrides.
 */
export function mergeOverrides(current, patch) {
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'cooldowns') {
      next.cooldowns = { ...(current.cooldowns ?? {}), ...value }
      continue
    }
    next[key] = value
  }
  return normalizeOverrides(next)
}

/**
 * Track a most-recent-fallback event log with a hard length bound.
 * @param {Array<object>} events - initial events (oldest first).
 * @param {() => number} [now] - clock override for tests.
 * @returns {object} the event log.
 */
export function createEventLog(events, now) {
  const clock = now ?? Date.now
  const buffer = Array.isArray(events) ? events.map(redactEvent) : []
  let limit = 50
  const setLimit = (next) => {
    limit = Number.isFinite(next) ? Math.min(200, Math.max(0, Math.trunc(next))) : limit
    prune()
  }
  const prune = () => {
    if (limit <= 0) buffer.length = 0
    while (buffer.length > limit) buffer.shift()
  }
  const record = (event) => {
    if (limit <= 0) return
    buffer.push(redactEvent({ at: new Date(clock()).toISOString(), ...event }))
    prune()
  }
  const snapshot = () => buffer.slice()
  const clear = () => {
    buffer.length = 0
  }
  return { record, snapshot, setLimit, clear }
}

/**
 * Debounced file writer so a burst of fallback events costs one disk write.
 * @param {string} file - state file path.
 * @param {() => object} read - returns the current state to serialize.
 * @param {{delayMs?: number}} [options] - write options.
 * @returns {{schedule: () => void, flush: () => void, lastError: () => string | null, dispose: () => void}} writer.
 */
export function createStateWriter(file, read, options = {}) {
  const delay = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 250
  let timer = null
  let pending = false
  let lastError = null
  const write = () => {
    pending = false
    const result = saveState(file, read())
    lastError = result.ok ? null : result.error
  }
  const schedule = () => {
    pending = true
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (pending) write()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) write()
  }
  const dispose = () => {
    flush()
  }
  return { schedule, flush, lastError: () => lastError, dispose }
}
