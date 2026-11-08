# Untitled Analytics Web SDK

The browser SDK preserves the generic Formo event envelope and uses the same
identity model as the Formo Web SDK: it stores a persistent first-party
anonymous ID in the browser.

## Browser storage

On first load the SDK creates a random UUID `anonymous_id` and stores it in a
first-party cookie (`ua_<hash of write key>_anonymous-id`, one year,
`SameSite=Lax`, `Secure` on HTTPS). If the browser rejects the cookie, the ID
goes to `localStorage` under the same key, and then to page memory. When a
cookie later works again, the SDK adopts the stored ID into the cookie and
removes the `localStorage` copy. Every event carries `anonymous_id`.

| Key suffix | Where | Lifetime | Purpose |
| --- | --- | --- | --- |
| `anonymous-id` | cookie, else localStorage, else memory | 1 year, refreshed on each event | Persistent browser ID |
| `session-id` | cookie, else localStorage, else memory | 30 minutes of inactivity | `session_id` on each event |
| `user-id` | cookie (browser session) | Until the browser closes or `reset()` | `user_id` set by `identify()` |
| `opt-out` | cookie and localStorage | 1 year | Set by `optOut()` |

Like Formo, cookies are scoped to the apex domain (`.example.com`) by default
(`crossSubdomainCookies: true`), so `example.com` and `play.example.com` share
one `anonymous_id`. Set `crossSubdomainCookies: false` for host-only cookies. The apex is found by probing which
domain the browser accepts, so public suffixes such as `vercel.app` stay
host-only. With apex scope, these IDs are readable by every subdomain of the
apex domain (and are sent in the `Cookie` header to every subdomain's servers),
so use `crossSubdomainCookies: false` if you host untrusted content on a
subdomain. An existing host-only cookie on the current host (for example from
SDK 0.1 or from `crossSubdomainCookies: false`) migrates to the apex domain.

By default identity is always on, like Formo. There is no remote
`attribution_enabled` check. To stop collection, pass `disabled: true` (the SDK
then reads and writes no browser storage) or call `optOut()`. Sites that need
consent before analytics storage can use the optional consent mode below.

## Quick start

```ts
import { createAnalytics } from '@untitled-analytics/web';

const analytics = createAnalytics({
  writeKey: 'site_public_key',
  endpoint: 'https://api.example.com',
  // crossSubdomainCookies: false, // optional: host-only cookies (default true)
});
analytics.track('signup_completed', { plan: 'starter' });
```

### Options

| Option | Default | Notes |
| --- | --- | --- |
| `writeKey` | required | Public write key for one site |
| `endpoint` | required | Collector base URL |
| `crossSubdomainCookies` | `true` | Apex-domain identity cookies; `false` for host-only |
| `autoPageviews` | `true` | Initial pageview plus `popstate` / `ua:navigate` |
| `batchSize` | `10` | Events per request |
| `flushIntervalMs` | `5000` | Flush timer |
| `requireConsent` | `false` | Consent mode; see below |
| `disabled` | `false` | No events and no browser storage |
| `webVitals` | none | `web-vitals` v5+ module |

### Methods

`page(properties?)`, `track(event, properties?)`, `identify(userId, traits?)`,
`reset()`, `setConsent(granted)`, `optOut()`, `optIn()`, `isOptedOut()`, `getUserId()`,
`getAnonymousId()`, `flush(keepalive?)`, `destroy()`.

### Event envelope

Each event in `POST /v1/events` (`{ events: [...] }`) has `type` (`page`,
`track`, `identify` or `web_vitals`), `event` (track only), `message_id`,
`channel: 'web'`, `version`, `original_timestamp`, `context`, `properties`,
`anonymous_id`, `session_id`, `user_id` (after `identify()`), and `traits`
(identify only). In consent mode before consent, `anonymous_id`, `session_id`
and `user_id` are absent.

## Identify logged-in users

Call `identify()` after login. No wallet is needed. Use a stable ID from your
app; email is an optional trait, not the identity key. `identify()` queues an
`identify` event with `user_id` and `traits` and flushes it. Like Formo's
`user-id` key, the user ID is stored in a first-party browser-session cookie
and is restored on later page loads, so later events carry `user_id`. Events
sent before `identify()` share the same `anonymous_id`, so the collector can
link them to the user.

Call `reset()` on logout. It clears the user ID, the anonymous ID and the
session from every storage layer. The next event starts a new anonymous ID.

```ts
await analytics.identify('user_123', { email: 'person@example.com', plan: 'pro' });
analytics.track('subscription_started');
// On logout:
analytics.reset();
```

## Opt-out

`optOut()` drops queued events, clears all identity, and stores an opt-out flag
for one year, so later page loads send nothing. `optIn()` removes the flag and
creates a new anonymous ID. `disabled: true` turns the SDK off for one instance
and does not touch browser storage.

## Optional consent mode

Default behaviour is the persistent first-party ID above. EU sites, or any site
that shows a consent banner before analytics storage, should set
`requireConsent: true` (snippet: `data-require-consent="true"`). Then:

- Until `setConsent(true)`, the SDK reads and writes no cookies or
  localStorage. Page and track events are still sent, with no
  `anonymous_id`, `session_id` or `user_id`.
- An `identify()` call made before consent is held in memory and sent when
  consent is granted.
- `setConsent(true)` creates or restores the persistent ID. Call it on each
  page load once your consent manager reports consent; the SDK does not store
  the consent choice.
- `setConsent(false)` clears all identity storage, drops the user ID, removes
  identity fields from queued events and discards queued identify events.

```ts
const analytics = createAnalytics({ writeKey, endpoint, requireConsent: true });
consentManager.onChange(granted => analytics.setConsent(granted));
```

`setConsent()` also works without `requireConsent`: `setConsent(false)` then
turns identity off for that instance.

## Script tag

```html
<script src="https://api.example.com/sdk.js" data-write-key="site_public_key"
  data-endpoint="https://api.example.com" defer></script>
```

The snippet shares identity across subdomains by default. Add
`data-cross-subdomain="false"` to set `crossSubdomainCookies: false`. Add
`data-require-consent="true"` for consent mode and call
`window.untitledAnalytics.setConsent(true)` from your banner. The instance
is available as `window.untitledAnalytics`.

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

```ts
import * as webVitals from 'web-vitals';
import { createAnalytics } from '@untitled-analytics/web';

createAnalytics({ writeKey: 'site_public_key', endpoint: 'https://api.example.com', webVitals });
```

The `web-vitals` package is an application dependency when this option is used.
This first port measures hard page loads, not separate SPA route changes.

This repository is derived from the MIT-licensed Formo Web SDK. It does not
include wallet or chain code. The anonymous ID, storage fallback and cookie
domain logic are adapted from Formo's `generateAnonymousId`, `CookieStorage`
and `cookiePolicy`.

## Local example and smoke check

`pnpm example` builds the browser bundle and serves a self-contained example at
`http://localhost:4317`. Its local collector records page and button events at
`/captured`. `pnpm test:example` exercises the built ESM package and browser
snippet against a local collector, including URL sanitization, cookie and
localStorage identity, and cross-subdomain cookie checks. No Formono or cloud services are needed.

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
cleared at UTC midnight. Reloading or creating another instance clears it; the
campaign itself is not written to browser storage. Page URLs omit
query/fragment, and only bounded, sanitized allowlisted campaign parameters are
sent.

Conversion-credit models run in Analytics' Tinybird backend, not in the SDK.
The persistent `anonymous_id` lets anonymous journeys join across days, and
`identify(userId, traits)` links them to a known user. The backend supports
first/last, last non-direct, linear, position-based and time decay; it does not
capture impressions or ad spend. Never send private provider/webhook secrets to
the browser; pass customer IDs such as `stripe_customer_id` as traits.
