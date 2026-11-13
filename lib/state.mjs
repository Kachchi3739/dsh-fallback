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
import { KNOWN_FALLBACK_CODES, normalizeChain } from './engine.mjs'

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
  return { version: STATE_VERSION, overrides: {}, health: {}, events: [], updatedAt: null }
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
  if (typeof parsed.health === 'object' && parsed.health !== null) state.health = parsed.health
  if (Array.isArray(parsed.events)) state.events = parsed.events.filter((event) => typeof event === 'object' && event !== null)
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
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = JSON.stringify({ ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() }, null, 2)
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, payload, 'utf8')
    fs.renameSync(temporary, file)
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
  const buffer = Array.isArray(events) ? events.slice() : []
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
    buffer.push({ at: new Date(clock()).toISOString(), ...event })
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
