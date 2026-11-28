# SDK tests

`pnpm typecheck`, `pnpm build`, and `pnpm test` at the root run every
package. GitHub Actions (`.github/workflows/tests.yml`) runs all three on pull
requests and main. `pnpm test` also runs `scripts/sync-versions.mjs --check`
and `scripts/zero-dependencies.test.mjs` (no runtime dependencies and no
install scripts in either package). `.github/workflows/security.yml` runs
`pnpm audit` and zizmor.

On 2026-11-28 (local run): `pnpm install --frozen-lockfile`, `pnpm typecheck`,
and `pnpm build` passed, and `pnpm test` passed 4 repository script tests, 149
web tests, and 43 Node SDK tests. On 2026-11-26: `npm publish --dry-run` passed for both packed tarballs,
and the packed `@manalens/node` loads with `require` and `import`.

## @manalens/web (packages/web)

`pnpm test` runs `pnpm test:example`. The examples build the actual ESM and browser bundles. Tests cover page/custom
events, the script snippet (including `data-cross-subdomain`), the first-party
`anonymous_id` cookie with localStorage and memory fallbacks, cookie migration
to the apex domain, publishable-key scoping (only `mana_pk_` keys pass), the 30-minute `session_id` and its 24-hour maximum age (also a stored session of a pre-release SDK build, which is not continued), `getSessionId()`, the reason codes of a refused batch, a 413 that halves the batch (sent again at once without backoff or a counted retry, one event dropped, full size after a success, no second send from the pagehide keepalive send), identify
events with persisted `user_id`, `reset()`, `optOut()` / `optIn()`, the
optional consent mode (`requireConsent`, `setConsent`, `data-require-consent`),
failed in-flight batches after `reset()`, `setConsent(false)` (also then `true`), `optOut()` (also then `optIn()`), deletion and
opt-out persistence before consent, sanitized
URLs/referrers, route changes, retry identity, disabled tracking (no storage
access) and validation, the `app` option and `data-app-*` attributes (valid,
invalid and dropped with a warning), publishable key prefix checks, pagehide keepalive flush, the keepalive size
limit (30 events of about 4 KB on `pagehide`: each body and all keepalive
bodies in flight together at most 60000 bytes, measured as the UTF-8 bytes of
the exact body; the rest stay queued and stored and go with the next normal
send; a hidden page and `pagehide` share the budget; one event over the limit
goes alone without keepalive), `shutdown()` (game mode: `session_end` with
`duration_s`, sent with normal requests, then the instance is stopped; it
resolves within `timeoutMs` when the network hangs and the unsent events stay
stored; without game mode it only sends the queue; the snippet instance has
it), and lifecycle cleanup.
Game mode (`game: true`, P-2800): `session_start` and `game_open` on each start, the stored first open (and the key of the old setup snippet), `session_end` on `pagehide`, `reset()` and after 30 minutes idle, the flush timer that keeps a visible and focused session alive, consent mode, captured window errors and unhandled rejections without personal data, `trackError()`, the fingerprint of the game SDKs (checked against two Unity fixture fingerprints), the error limits and `errors_dropped`, the property limits, a 1 MB message and stack (cut to 4096 characters before any regular expression runs), `data-game`, game mode off without a valid `app`, `game_crash` at the next load (P-2835: a focused tab that closed without `pagehide`, in the old session with `previous_session_id`, `previous_build` and `previous_app_version`; none after `pagehide`, `shutdown()`, `destroy()`, or for a hidden or unfocused tab; a second look after 20 s for an entry that can be an open tab, skipped after `reset()`; dropped for another anonymous ID, sent with the saved user ID; one entry per tab; nothing saved before consent or in website mode; deleted by `setConsent(false)` and `optOut()`), and the breadcrumbs of errors (the last 20 `track` names without errors and page views, cut to the last 1024 characters, cleared by `reset()` and `setConsent(false)`, none from before consent), and hang detection (P-2833: `game_hang` with `hang_duration_s` from the 500 ms timer fallback with a mocked clock; none under the limit, while hidden, just after the page is visible again, or for a sleep of the computer; `hangThresholdMs` and `data-hang-threshold-ms`, 0 turns it off; none in website mode; `hang_message_id` on the next `game_crash`; with a `long-animation-frame` observer stand-in: the place and the stack from the longest script, without query). Persistent queue (`persistQueue`, G-2526): replay on the next load in order with the same `message_id` (localStorage and a small IndexedDB stand-in), removal only after the collector accepts, the 1000-event and 7-day caps, and consent and `optOut()` (nothing written, stored events deleted).
Installed-app pages (`app://` and `file://` with the `app` option): app events with `channel: 'app'`, `context.app` and no `context.page`, referrer or campaign fields (no file path or query sent); `sent_at` in every request body (normal, keepalive on `pagehide`, and `shutdown()`); no page views (`autoPageviews` on, `page()`, back and forward, `manalens:navigate`; history not wrapped; one `console.warn` from `page()`); no cookie read or written, the anonymous ID and session in localStorage and kept on the next load, the user ID in sessionStorage and removed by `reset()`; game mode (`session_start`, `game_open` and the stored first open, captured and manual errors with breadcrumbs, `session_end` from `shutdown()`, `game_crash` at the next load, `game_hang`), all as app events. Without a valid `app` option on such a page: one `console.warn` and web events as before. `http` and `https` pages after an app page: channel `web`, `context.page`, page views, cookies, and no `sent_at`.

```sh
pnpm --filter @manalens/web typecheck
pnpm --filter @manalens/web test:example
```

The examples simulate browser APIs (including a `document.cookie` jar with
domain scoping and public-suffix rejection) and use a local HTTP collector
where needed.
They do not establish real browser hydration or hosted collector behavior. The
analytics monorepo's `docs/TESTING.md` describes the separate collector → SQS →
worker → Tinybird Local integration suite and current verification limits.

## @manalens/node (packages/node)

`pnpm test` builds the package and runs `test/*.test.mjs` (node:test) against
`dist/esm`, the published code. A mocked `fetch` stands in for the collector;
there is no network. Tests cover key and mode checks (secret key in server
mode, publishable key in app mode, API keys refused), the event envelope of
both channels, app context, app sessions (30 minutes idle, 24 hours maximum),
batch limits (100 server, 50 app), `flushAt` and `flushInterval`, retries with
the same `message_id` (5xx, 408, 429, network errors), backoff, jitter and
`Retry-After`, a 413 that halves the batch (sent again at once, not counted as
a retry; one event is dropped), refused events of an accepted batch, validation (events dropped,
never thrown), and `shutdown()`.

The contract tests read `packages/node/test/fixtures/collector-contract.json`:
the SDK must send the request bodies in it, and its app enums, key format, and
property limits must agree. The Manalens collector repository keeps the same
file (`tests/fixtures/node-sdk-contract.json`) and checks it against the
collector schemas and key rules. Change both copies together. The end-to-end
test against a local collector and Tinybird Local stays in that repository
(`pnpm test:node-sdk:local`).

## Release tooling

`packages/web/scripts/generate-sri.sh` was checked locally on 2026-11-08 against `npm pack`
output: its SHA-384 matches a direct `openssl` hash of
`dist/snippet.global.js` from the tarball, and repeated packs give the same
hash. It exits non-zero for an empty tarball, a missing or empty bundle, a
version mismatch, an invalid version, an unpublished version, and when npm or
the CDN never serve matching bytes. The registry and CDN success path was
checked against the published `@formo/analytics@1.42.1` (via the
`SRI_PACKAGE` / `SRI_FILE` test overrides). `npm publish --dry-run` on the
packed tarball succeeds. The workflow YAML parses; actionlint was not run
locally.
