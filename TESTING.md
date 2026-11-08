# SDK tests

On 2026-11-08, `pnpm typecheck` and all 43 tests in `pnpm test:example` passed.
GitHub Actions runs both on pull requests and main.

The examples build the actual ESM and browser bundles. Tests cover page/custom
events, the script snippet (including `data-cross-subdomain`), the first-party
`anonymous_id` cookie with localStorage and memory fallbacks, cookie migration
to the apex domain, write-key scoping, the 30-minute `session_id`, identify
events with persisted `user_id`, `reset()`, `optOut()` / `optIn()`, the
optional consent mode (`requireConsent`, `setConsent`, `data-require-consent`),
failed in-flight batches after `reset()`, `setConsent(false)` (also then `true`), `optOut()` (also then `optIn()`), deletion and
opt-out persistence before consent, sanitized
URLs/referrers, route changes, retry identity, disabled tracking (no storage
access) and validation, sparse one-per-load Web Vitals, and lifecycle cleanup.

```sh
pnpm typecheck
pnpm test:example
```

The examples simulate browser APIs (including a `document.cookie` jar with
domain scoping and public-suffix rejection) and use a local HTTP collector
where needed.
They do not establish real browser hydration,
Web Vitals measurements from a real page, or hosted collector behavior. The
analytics monorepo's `docs/TESTING.md` describes the separate collector → SQS →
worker → Tinybird Local integration suite and current verification limits.
