# Changelog

## 1.3.0 — 2026-11-14

### Security

- The settings API now validates every request with DSH's `connection` trust
  service (Host/Origin checks and browser authentication) when it is mounted.
  Without that service it accepts only loopback hosts, same-origin JSON POSTs
  carrying the `x-dsh-fallback-request: 1` marker, and rejects cross-site
  requests. This closes the cross-origin write path that allowed a malicious
  page to add accounts or change the routing configuration.
- Requests carry `X-Content-Type-Options: nosniff`, and provider error envelopes
  returned by self-test/rotation endpoints no longer include provider URLs or
  organization identifiers.
- The expensive account-test and rotation-test endpoints are single-flight with
  a short cooldown, so a caller cannot parallelize quota-consuming probes.
- The state writer creates its directory with mode `0700` and its file with mode
  `0600` where the filesystem honors POSIX modes.

### Privacy

- State events store a short hash of the session id (`session:<8 hex>`) instead
  of the full id, and stored provider failure messages redact URLs, `org_*`
  identifiers and key-shaped tokens.
- `/state` and `/accounts` redact the user's home directory from the state and
  catalog paths.
- The README screenshot no longer includes the DSH sidebar/session list, and the
  repository history was rewritten so earlier screenshots are not recoverable
  from normal git history.
- `.gitignore` now excludes `.env*`, `.credentials*`, `*.pem`, `*.key`, `*.p12`,
  `*.pfx` and `.dsh-fallback/`.
- Added `SECURITY.md` documenting the local API trust model and the credential
  store's at-rest caveat.

### Changed

- CI uses Node 24 (the local test runtime), pins `actions/checkout` and
  `actions/setup-node` to commit SHAs, disables persisted credentials and grants
  only `contents: read`.
- Tests cover request marker/content-type/Origin/Host rejection, connection
  rejection, and state redaction.

## 1.2.1 — 2026-11-14

### Fixed

- The Router fallback page is now its own scroll container (`flex: 1 1 auto`,
  `min-height: 0`, `overflow: auto`). The shell clips the panel area, so a page
  taller than the window previously could not be scrolled with the mouse wheel;
  the account pool, chain, trigger codes and event log below the fold are now
  reachable.

## 1.2.0 — 2026-11-14

### Added

- **DSH-wide account pooling.** The `opencode-go` / `opencode` accounts now
  serve every request on that route — ordinary chats, subagents and the route's
  turn as a fallback target — and keep rotating when router fallback is turned
  off. Previously an added account only took over after the default account
  failed, and only while fallback was enabled.
- **Account usage modes** in the panel: `rotate` (round-robin per request,
  default), `sticky` (one account per session for prompt-cache reuse), and
  `failover` (priority order). The mode is stored with the other overrides.
- **Rotation test** button: sends two tiny requests through the ordinary request
  path and reports the per-account request/success split, proving the pool
  without switching the chat model.
- Per-account request/success counters are shown in the accounts panel.
- Pools now apply to account-capable routes inside the fallback chain, not only
  to the selected route (`planAttempts` accepts per-provider account lists).

### Changed

- Rotation bookkeeping lives in `lib/rotation.mjs` and is covered by unit tests;
  the state file gains only the `accountMode` override (no new secrets).
- Tests grew from 64 to 85 (rotation, DSH-wide pool, sticky/failover, chain-route
  pools and the rotation-test endpoint).

### Fixed

- A route whose default key is cooling down now still uses its remaining added
  account. Previously a single healthy account was mistaken for "no fallback"
  and the exhausted route key was called directly.

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
