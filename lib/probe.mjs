/**
 * The quota probe used by the settings page's "연결 테스트 / Test fallback"
 * button.
 *
 * The probe is a real LLM adapter registered only for the duration of one
 * self-test. It answers with the same terminal failure a provider returns when
 * its quota is exhausted, which forces the fallback engine to walk the real
 * chain and proves, end to end, that the configured next router answers. It
 * never appears in the model selector and is never registered outside the
 * self-test window.
 *
 * @module dsh-fallback/probe
 */

import { PROBE_PROVIDER } from './providers.mjs'

/** The probe's synthetic model id. */
export const PROBE_MODEL = 'quota-probe'

/** Request purpose marker for self-test calls. */
export const PROBE_PURPOSE = 'dsh-fallback-probe'

/**
 * Symbol carrying the per-test attempt log on a hand-built request. The
 * fallback interceptor copies this into every attempt event instead of the
 * shared event log.
 */
export const PROBE_LOG = Symbol('dsh-fallback.probe-log')

/**
 * Symbol carrying the chain the self-test must actually walk (every entry has
 * a concrete model id, resolved before dispatch).
 */
export const PROBE_CHAIN = Symbol('dsh-fallback.probe-chain')

/** Prompt sent through the chain. Small enough to cost almost nothing. */
export const PROBE_PROMPT = 'Reply with the single word OK.'

/**
 * Build a duck-typed `LlmAdapter` whose stream starts like a real one and then
 * fails with the configured quota-style code.
 * @param {{code?: string, status?: number, message?: string}} [options] - failure shape.
 * @returns {object} the adapter.
 */
export function createProbeAdapter(options = {}) {
  const code = typeof options.code === 'string' && options.code.length > 0 ? options.code : 'QUOTA'
  const status = Number.isInteger(options.status) ? options.status : 429
  const message =
    typeof options.message === 'string' && options.message.length > 0
      ? options.message
      : `fallback probe: simulated ${code} failure (the router never leaves the probe)`
  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: 'Fallback probe' }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },
    listModels() {
      return Promise.resolve([])
    },
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: 'Quota probe' })
    },
    prepareCall(provider, model) {
      return Promise.resolve({
        model: { provider, id: model, name: 'Quota probe' },
        stream: () => adapter.stream(),
      })
    },
    async *stream() {
      // A real attempt usually opens the assistant message before the gateway
      // rejects it; emitting one framing chunk makes the test exercise the
      // engine's "discard pre-content output" path instead of a bare throw.
      yield { type: 'block-start', index: 0, blockType: 'text' }
      const error = new Error(message)
      error.code = code
      error.failure = { code, message, status }
      throw error
    },
  }
  return adapter
}

/**
 * Consume a probe stream, collecting the visible answer and the terminal frame.
 * @param {AsyncIterable<object>} stream - chunk stream from `llm.stream()`.
 * @returns {Promise<{text: string, finish: object | null, chunks: number}>} the collected outcome.
 */
export async function collectProbeStream(stream) {
  let text = ''
  let finish = null
  let chunks = 0
  for await (const chunk of stream) {
    chunks += 1
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'finish') {
      finish = chunk
      break
    }
  }
  return { text, finish, chunks }
}

/**
 * Build a hand-built request for the probe (mutable, so the plugin can attach
 * the attempt-log symbol; loop-built requests are deep-frozen and never reach
 * this path).
 * @param {{log?: object, chain?: ReadonlyArray<object>, sessionId?: string, signal?: AbortSignal}} [options] - request extras.
 * @returns {object} GenerateOptions for `llm.stream()`.
 */
export function probeRequest(options = {}) {
  return {
    provider: PROBE_PROVIDER,
    model: PROBE_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }] }],
    maxTokens: 24,
    purpose: PROBE_PURPOSE,
    // Some routes (opencode) require a per-conversation routing header derived
    // from the session id; a self-test borrows a live session so the real
    // router accepts the request exactly as a conversation would.
    ...typeof options.sessionId === 'string' && options.sessionId.length > 0 ? { sessionId: options.sessionId } : {},
    ...options.log === undefined ? {} : { [PROBE_LOG]: options.log },
    ...options.chain === undefined ? {} : { [PROBE_CHAIN]: options.chain },
    ...options.signal === undefined ? {} : { signal: options.signal },
  }
}
