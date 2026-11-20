# SDK tests

On 2026-11-20, `pnpm typecheck` and all 86 tests in `pnpm test:example` passed (run locally).
GitHub Actions runs both on pull requests and main.

The examples build the actual ESM and browser bundles. Tests cover page/custom
events, the script snippet (including `data-cross-subdomain`), the first-party
`anonymous_id` cookie with localStorage and memory fallbacks, cookie migration
to the apex domain, publishable-key scoping (only `mana_pk_` keys pass), the 30-minute `session_id` and its 24-hour maximum age (also a stored session of a pre-release SDK build, which is not continued), `getSessionId()`, the reason codes of a refused batch, identify
events with persisted `user_id`, `reset()`, `optOut()` / `optIn()`, the
optional consent mode (`requireConsent`, `setConsent`, `data-require-consent`),
failed in-flight batches after `reset()`, `setConsent(false)` (also then `true`), `optOut()` (also then `optIn()`), deletion and
opt-out persistence before consent, sanitized
URLs/referrers, route changes, retry identity, disabled tracking (no storage
access) and validation, the `app` option and `data-app-*` attributes (valid,
invalid and dropped with a warning), publishable key prefix checks, pagehide keepalive flush, and lifecycle cleanup.

```sh
pnpm typecheck
pnpm test:example
```

The examples simulate browser APIs (including a `document.cookie` jar with
domain scoping and public-suffix rejection) and use a local HTTP collector
where needed.
They do not establish real browser hydration or hosted collector behavior. The
analytics monorepo's `docs/TESTING.md` describes the separate collector → SQS →
worker → Tinybird Local integration suite and current verification limits.

## Release tooling

`scripts/generate-sri.sh` was checked locally on 2026-11-08 against `npm pack`
output: its SHA-384 matches a direct `openssl` hash of
`dist/snippet.global.js` from the tarball, and repeated packs give the same
hash. It exits non-zero for an empty tarball, a missing or empty bundle, a
version mismatch, an invalid version, an unpublished version, and when npm or
jsDelivr never serve matching bytes. The registry and CDN success path was
checked against the published `@formo/analytics@1.42.1` (via the
`SRI_PACKAGE` / `SRI_FILE` test overrides). `npm publish --dry-run` on the
packed tarball succeeds. The workflow YAML parses; actionlint was not run
locally.
