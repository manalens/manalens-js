# Untitled Analytics Web SDK

The browser SDK preserves the generic Formo event envelope while sending no
cookies. Daily mode uses no localStorage IDs, sessionStorage IDs, or cross-day anonymous IDs. The
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
The recorder first checks `/v1/replay/config` and records only when replay is
enabled for the project and its randomly generated recording ID is inside the
project's configured sample. The collector enforces the same deterministic
sample. It rechecks every 30 seconds and stops if the setting is disabled or
unavailable. It creates an in-memory recording ID, batches
rrweb events to `/v1/replay`, masks text and input values, and removes URL query
strings and fragments by default. Add
`data-private` to block whole sections. Call the returned stop function when
recording should end. Recordings appear on visitor profiles and expire after
30 days. The collector also enforces a rolling 30-day upload byte budget.

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

## Ad and campaign attribution

Automatically captures the five standard UTM fields plus `utm_id`,
`utm_source_platform`, `utm_creative_format`, `utm_marketing_tactic`; external
referrer origins; `ref` / `referral` / `referral_code`; Google `gclid`, `gbraid`,
`wbraid`, `gad_source`; Meta `fbclid`; Microsoft `msclkid`; TikTok `ttclid`;
X `twclid`; LinkedIn `li_fat_id`; Reddit `rdt_cid`; Snapchat `ScCid`. All
network IDs are preserved. `gad_source` marks the source but is not a click ID.
Derived `paid_source` and a deterministic `click_id` remain compatible with
Formo-style event context. Paid UTMs classify as `paid_utm` without a network ID.

A coherent campaign is carried **in memory** across SPA routes and subsequent
track/identify calls, replaced when a new tagged acquisition arrives, and
cleared at UTC midnight. Reloading or creating another instance clears it.
Daily mode reads/writes no cookies or browser identity storage. Optional Attribution mode stores a consent-gated first-party UUID in localStorage. Page URLs omit query/fragment,
and only bounded, sanitized allowlisted campaign parameters are sent.

Conversion-credit models run in Analytics' Tinybird backend, not in the SDK.
Anonymous journeys cannot join days; explicit `identify(userId, traits)` permits
known-user joins. The backend supports first/last, last non-direct, linear,
position-based and time decay; it does not capture impressions or ad spend.

## Optional Attribution mode

Daily mode is the default. Enable Attribution mode in project settings first (admin/MFA and processing acknowledgement), then supply a visitor-consent callback:

```ts
const analytics = createAnalytics({
  writeKey: 'YOUR_SDK_WRITE_KEY',
  endpoint: 'https://api.your-domain.com',
  attribution: { consent: () => consentManager.analyticsAllowed() },
});
await analytics.ready;
await analytics.identify('user_123', { stripe_customer_id: 'cus_123' });
// or paddle_customer_id: 'ctm_123'
```

The callback comes from your app's consent manager. Only with both gates satisfied does the SDK access a project-scoped localStorage UUID, expiring after 90 days. Storage failure falls back to daily identity. No analytics cookies are set. Explicit user_id remains in memory and must be set again after authenticated reloads.

On withdrawal, call `analytics.setConsent(false)` immediately; stored identity and persistent fields on queued events are removed. Alternatively the callback is rechecked on sends. `setConsent` explicitly overrides the callback until changed again, so use one mechanism consistently. Call `clearUserId()` on logout: it discards queued events and replaces the consented browser ID to prevent reattaching the next account. Consent withdrawal does not delete previously stored analytics history.

Browser snippets can use `data-attribution="true"` together with `window.untitledAnalyticsConsent = () => ...`; omit both for daily mode. The collector ignores client anonymous_id unless the project allows it and consent is true. Never send private provider/webhook secrets to the browser.
