# Changelog

## 1.1.0 — 2026-11-14

### Added

- **Multiple API accounts on one router.** `opencode-go` (and `opencode`) can
  now pool several accounts. Each request rotates the account key through the
  documented `llm-pi-ai/request-headers` waterfall, so the rotation works for
  every model on the route, including Anthropic Messages and Gemini protocols.
- **Accounts panel**: add (label + key), test, skip/resume, reorder and remove
  accounts; health and cooldown are tracked per account (`account:<provider>:<id>`
  health keys), and an exhausted account falls through to the next account
  before the fallback chain.
- Keys are stored only in the Harness credentials store under generated
  `DSH_FALLBACK_<PROVIDER>_<ID>` references; the state file keeps labels and
  references only.
- The model → wire-protocol map is read from the pi-ai catalog shipped with the
  running Harness (`installation` source) with an embedded snapshot as the
  fallback.

### Changed

- Account attempts are planned by `lib/engine.mjs`; existing single-key routing
  is unchanged when no added account exists.
- Verified against DeepSeek Harness 0.2.2-rc.3 (Electron 44).

## 1.0.0 — 2026-11-13

- Initial release: transparent router fallback on quota/limit failures, chain
  built from the routers already connected to the profile, per-code cooldowns,
  cross-provider thinking-history sanitization, forced-quota self-test, and the
  sidebar panel with status and recent events.
