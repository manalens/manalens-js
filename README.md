# Untitled Analytics Web SDK

The browser SDK preserves the generic Formo event envelope while sending no
cookies, localStorage IDs, sessionStorage IDs, or cross-day anonymous IDs. The
ingestion server assigns a site-scoped daily rotating `session_id`.

That inherited server field is currently a daily anonymous ID. A distinct
inactivity-bounded session ID is planned; the SDK never persists the anonymous
ID in the browser.

```ts
import { createAnalytics } from '@untitled-analytics/web';

const analytics = createAnalytics({
  writeKey: 'site_public_key',
  endpoint: 'https://api.example.com',
});
analytics.track('signup_completed', { plan: 'starter' });
```

## Identify logged-in users

Call `identify()` after login and on each authenticated page load. Use a stable
ID from your app; email is an optional profile property, not the identity key.
Identity lives in SDK memory only. Call `clearUserId()` on logout. The API stores
the custom properties in a project-scoped profile, and subsequent events carry
`user_id`. Previously anonymous events are not retroactively merged.

```ts
await analytics.identify('user_123', { email: 'person@example.com', plan: 'pro' });
analytics.track('subscription_started');
// On logout:
analytics.clearUserId();
```

## Optional session replay

Replay is a separate import so ordinary analytics installs do not load rrweb.
It creates an in-memory recording ID, batches rrweb events to `/v1/replay`, and
masks every input value. Add `data-private` to whole sections that should be
blocked and `data-mask` to text that should be hidden. Call the returned stop
function when recording should end. Recordings appear on visitor profiles.

```ts
import { startSessionReplay } from '@untitled-analytics/web/replay';

const stopReplay = startSessionReplay({
  writeKey: 'site_public_key',
  endpoint: 'https://api.example.com',
  getUserId: () => analytics.getUserId(),
});
```

For script tags, load `/sdk-replay.js` separately and call
`UntitledAnalyticsReplay.startSessionReplay({ writeKey, endpoint,
getUserId: () => window.untitledAnalytics?.getUserId() })`.

`page()` tracks the current page. By default the SDK also sends an initial
pageview and listens for `popstate`. For routers that do not emit
`popstate`, call `analytics.page()` after each route change. `destroy()` clears
pending events and listeners. The SDK sends only URL origin and path; query
strings and fragments are omitted, while selected UTM fields are sanitized.

## Optional Web Vitals

Pass `web-vitals` 5 or later to collect LCP, INP, CLS, FCP and TTFB. The SDK
does not bundle the library or load it unless you supply it. One
`web_vitals` event is queued on the first page hide, with the measured landing
page, navigation-start timestamp, and only the metrics the browser reported.
No analytics cookie or browser-stored visitor ID is added.

```ts
import * as webVitals from 'web-vitals';
import { createAnalytics } from '@untitled-analytics/web';

createAnalytics({ writeKey: 'site_public_key', endpoint: 'https://api.example.com', webVitals });
```

The `web-vitals` package is an application dependency when this option is used.
This first port measures hard page loads, not separate SPA route changes.

This repository is derived from the MIT-licensed Formo Web SDK. It does not
include wallet, chain, or persistent anonymous identity code.

## Local example and smoke check

`pnpm example` builds the browser bundle and serves a self-contained example at
`http://localhost:4317`. Its local collector records page and button events at
`/captured`. `pnpm test:example` exercises the built ESM package and browser
snippet against a local collector, including URL sanitization and browser
storage checks. No Formono or cloud services are needed.
