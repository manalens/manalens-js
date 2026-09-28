# SDK tests

On 2026-09-28, `pnpm typecheck` and all 11 tests in `pnpm test:example` passed.
GitHub Actions runs both on pull requests and main.

The examples build the actual ESM and browser bundles. Tests cover page/custom
events, the script snippet, no cookies or persistent browser storage, sanitized
URLs/referrers, route changes, retry identity, identify/clear identity, disabled
tracking and validation, sparse one-per-load Web Vitals, lifecycle cleanup, and
replay config failing closed when disabled or offline.

```sh
pnpm typecheck
pnpm test:example
```

The examples simulate browser APIs and use a local HTTP collector where needed.
They do not establish real browser hydration, rrweb DOM recording/playback,
Web Vitals measurements from a real page, or hosted collector behavior. The
analytics monorepo's `docs/TESTING.md` describes the separate collector → SQS →
worker → Tinybird Local integration suite and current verification limits.
