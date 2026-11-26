# Manalens Web SDK

## What is the Manalens Web SDK?

The Manalens Web SDK is an
[open source](https://github.com/manalens/manalens-js) JavaScript
library for first-party web analytics and attribution. Use it to track page
views, custom events and identified users in your website or web app, and to
capture UTM parameters, referrers and ad click IDs (Google, Meta, Microsoft,
TikTok, X, LinkedIn, Reddit, Snapchat) for marketing attribution.

It keeps the generic Formo event envelope and uses the same identity model as
the Formo Web SDK: it stores a persistent first-party anonymous ID in the
browser (see [Browser storage](#browser-storage)).

## Installation

There are two ways to install the SDK:
- [HTML snippet](#html-snippet-cdn) is recommended for static websites
- [npm](#npm) for React, Next.js and other bundled apps

### HTML snippet (CDN)

Add this tag to the `<head>` of every page. Pin the exact version and keep the
`integrity` attribute, so the browser refuses a changed file.

```html
<script
  src="https://cdn.manalens.dev/web@0.1.0"
  integrity="sha384-REPLACE_WITH_THE_HASH_FROM_THE_RELEASE_NOTES"
  crossorigin="anonymous"
  data-publishable-key="YOUR_PUBLISHABLE_KEY"
  data-endpoint="https://YOUR_COLLECTOR_ENDPOINT"
  defer
></script>
```

Get the `integrity` value in one of two ways:
- Copy the complete tag from the GitHub release notes for that version. The
  release workflow writes it after it checks that cdn.manalens.dev serves the
  published bytes.
- Run `bash scripts/generate-sri.sh --version 0.1.0 --check-registry --check-cdn`.
  It downloads the published npm tarball, hashes `dist/snippet.global.js` from
  it, and checks that npm and cdn.manalens.dev serve the same bytes.

Change the version in the URL and the hash together. See
[Snippet attributes](#snippet-attributes) for options. The instance is
available as `window.manalens`.

### npm

```sh
npm install @manalens/web
```

## Browser storage

On first load the SDK creates a random UUID `anonymous_id` and stores it in a
first-party cookie (`mana_<hash of publishable key>_anonymous-id`, one year,
`SameSite=Lax`, `Secure` on HTTPS). If the browser rejects the cookie, the ID
goes to `localStorage` under the same key, and then to page memory. When a
cookie later works again, the SDK adopts the stored ID into the cookie and
removes the `localStorage` copy. Every event carries `anonymous_id`.

| Key suffix | Where | Lifetime | Purpose |
| --- | --- | --- | --- |
| `anonymous-id` | cookie, else localStorage, else memory | 1 year, refreshed on each event | Persistent browser ID |
| `session-id` | cookie, else localStorage, else memory | 30 minutes of inactivity, and at most 24 hours from the start of the session | `session_id` on each event |
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

## Usage

```ts
import { createAnalytics } from '@manalens/web';

const analytics = createAnalytics({
  publishableKey: 'YOUR_PUBLISHABLE_KEY',
  endpoint: 'https://api.example.com',
  // crossSubdomainCookies: false, // optional: host-only cookies (default true)
});
analytics.track('signup_completed', { plan: 'starter' });
```

### Options

| Option | Default | Notes |
| --- | --- | --- |
| `publishableKey` | required | The project publishable key (`mana_pk_...`). Safe to ship in a page or a game build. Any other value, such as a secret key (`mana_sk_`) or an API key (`mana_api_`), throws an error. Sent in the `x-publishable-key` header. |
| `endpoint` | required | Collector base URL (origin, or a reverse proxy prefix such as `/mana`). The SDK posts to `<endpoint>/v0/events`. |
| `crossSubdomainCookies` | `true` | Apex-domain identity cookies; `false` for host-only |
| `autoPageviews` | `true` | Initial pageview, SPA navigation (`history.pushState` / `replaceState`), back and forward (`popstate`) and `manalens:navigate`; see [Pageviews](#pageviews). Snippet: `data-auto-pageviews="false"` |
| `batchSize` | `30` | Events per request (the collector takes at most 50) |
| `flushIntervalMs` | `15000` | Flush timer; the page hiding or closing sends at once |
| `retryCount` | `3` | Retries after a server error (408, 429, 5xx), 0 to 10. Network errors (offline) are not counted. Other 4xx responses are not retried. |
| `maxQueueSize` | `512000` | Queue limit in bytes (200 to 500 KB). The oldest events are dropped first. |
| `requireConsent` | `false` | Consent mode; see below |
| `tracking` | `true` | `false` is the same as `disabled: true`. An object sets rules: `{ excludeHosts, excludePaths, excludeTimezones, excludeQueryParams }`; see [Tracking rules](#tracking-rules) |
| `disabled` | `false` | No events and no browser storage |
| `logger` | off | `{ enabled: true, levels?: ['trace', 'debug', 'info', 'warn', 'error'] }`; see [Logging](#logging). Snippet: `data-debug="true"` |
| `ready` | none | `(analytics) => void`, called once at the end of the constructor (also when disabled). Snippet: the `manalens:ready` event |
| `errorHandler` | none | `(error) => void`, called when events are dropped: refused by the collector, or a server error after `retryCount` retries. See [Delivery errors](#delivery-errors) |
| `app` | none | App context for a browser or Electron game; see [Browser and Electron games](#browser-and-electron-games) |

**Delivery.** Events wait in memory (never in browser storage) and are sent in
batches. After a failed send, the timer and full batches wait: 1 s, 2 s, 4 s ...
up to 30 s, with jitter, or longer when a `429` has `Retry-After` (up to 60 s).
A call to `flush()` sends at once. `pagehide` sends with `keepalive`.

### Delivery errors

`errorHandler` gets a `SendError` (`name`, `message`, `status`, `dropped`,
`reasons`) when events are dropped:

- The collector refused the batch (a 4xx other than 408 and 429, for example
  `401` for a wrong key or `403` for a page off the project domain). A refused
  batch is dropped and is not sent again. `reasons` has the reason codes of
  the collector, and `message` (also in the error log) has its text, for
  example `HTTP 400 INVALID_EVENT, SESSION_ID_REQUIRED: ...`.
- The collector accepted the batch (`202`) but refused some of its events,
  for example an event over a properties limit. The valid events are stored;
  the refused ones are dropped and are not sent again. `status` is `202`,
  `dropped` is the number of refused events, and `reasons` has their codes.
- A server error (408, 429, 5xx) repeated more than `retryCount` times.

Network errors (offline) do not call it: those events wait in memory and go
out when the network is back. An error thrown in the handler is caught.

```ts
createAnalytics({ publishableKey, endpoint, errorHandler: error => reportToSentry(error) });
```

### Logging

Logging is off by default. `logger: { enabled: true }` prints every level;
add `levels` to choose. The list is matched exactly, like Formo's SDK:
`levels: ['warn']` prints warnings only, not errors. The snippet attribute
`data-debug="true"` turns on every level.

| Level | What it prints |
| --- | --- |
| `info` | Start (with `autoPageviews` and consent mode), disabled, excluded timezone, opt-out |
| `debug` | Each queued event (type and event name), each sent batch (count), events not sent on an excluded host or path |
| `warn` | A failed send that will be retried (status or network error), a full queue that dropped an event |
| `error` | Events dropped (refused, or out of retries) |
| `trace` | Nothing at the moment |

Logs never contain property values, traits, user IDs or keys.

### Ready callback

`ready` runs once, at the end of the constructor, with the instance. It runs
also when the SDK is disabled. An error thrown in it is caught and logged.

```ts
createAnalytics({ publishableKey, endpoint, ready: analytics => analytics.track('app_loaded') });
```

The snippet makes `window.manalens` and then dispatches
`manalens:ready` on `window` (`event.detail` is the instance). Add
the listener before the snippet runs, or check `window.manalens`
first:

```html
<script>
  function onAnalytics(analytics) { analytics.track('app_loaded'); }
  if (window.manalens) onAnalytics(window.manalens);
  else window.addEventListener('manalens:ready', function (event) { onAnalytics(event.detail); }, { once: true });
</script>
```

### Tracking rules

Send nothing from some hosts, paths or timezones (adapted from Formo's SDK):

```js
createAnalytics({
  publishableKey, endpoint,
  tracking: {
    excludeHosts: ['localhost', 'staging.example.com', '*.vercel.app'],
    excludePaths: ['/admin/*', '/internal'],
    excludeTimezones: ['Europe/London'],
    excludeQueryParams: ['ref'],
  },
});
```

`tracking: false` turns the SDK off (the same as `disabled: true`), and
`tracking: true` is the default. For example, `tracking: process.env.NODE_ENV === 'production'`.

- `excludeHosts`: exact hostnames, or `*.` for every subdomain (`*.vercel.app`
  does not match `vercel.app` itself). Case-insensitive.
- `excludePaths`: exact paths, or a prefix ending in `/*` (`/admin/*` matches
  `/admin` and every path under it). Checked for each event, so a SPA that
  leaves an excluded path sends again.
- On an excluded host or path, no event is sent and no identity cookie is
  written. An identity written on an allowed page stays.
- `excludeTimezones`: IANA names, case-insensitive. A visitor in one of them is
  not tracked at all: no events, no browser storage, and an existing identity
  is deleted. This is best effort; a visitor can change the timezone. For
  strict geo rules, filter at the collector.
- Hosts are compared in lowercase punycode without a trailing dot, and paths
  after decoding escapes and collapsing repeated slashes. Timezone names match
  their renamed forms (for example `Asia/Kolkata` and `Asia/Calcutta`).
- An `identify()` on an excluded page is held and sent with the first event on
  an allowed page. A campaign from an excluded landing page is not carried.
- `excludeQueryParams`: query parameter names the SDK never reads,
  case-insensitive. The SDK never sends a full query string or fragment: page
  URLs are origin and path, and a referrer is an origin. It reads only the
  campaign parameters (see [Ad and campaign attribution](#ad-and-campaign-attribution)).
  Name one here to keep it out of every event, for example `['ref']` or
  `['gclid']`.
- The SDK tracks every host, **including `localhost`**. Manalens accepts
  `localhost` events only when the project domain allows them. Dev and live
  data go to the same project, so you can watch your own events in Activity
  as you test. In a browser game, set `build` in the
  [app context](#browser-and-electron-games) (for example `"dev"`) to tell
  local and staging runs apart, and filter by it. To send nothing from some
  environments, use `excludeHosts: ['localhost']` or `tracking: false`.

### Methods

`page(properties?)`, `track(event, properties?)`, `identify(userId, traits?)`,
`reset()`, `setConsent(granted)`, `optOut()`, `optIn()`, `isOptedOut()`, `getUserId()`,
`getAnonymousId()`, `getSessionId()`, `getClickIds()`, `flush(keepalive?)`, `destroy()`.

### Ad click IDs

When a visitor comes from an ad, the URL has a click ID: `gclid` (Google),
`fbclid` (Meta), `msclkid` (Microsoft), `li_fat_id` (LinkedIn), `ttclid`
(TikTok), `twclid` (X), `rdt_cid` (Reddit), `ScCid` (Snapchat), `gbraid` or
`wbraid`. The SDK keeps the latest ID of each network in a first-party cookie
for 90 days. With `crossSubdomainCookies` (the default), the cookie is on the
apex domain, so `example.com` and `app.example.com` share it. It follows the
same rules as the anonymous ID: nothing before consent, and `optOut()`,
`reset()` and `setConsent(false)` delete it. A parameter in
`tracking.excludeQueryParams` is never saved.

Save the IDs on the account or order when the visitor signs up or pays.
Weeks later, the ad network's own cookie is gone, and you can still send an
offline conversion. In the browser:

```ts
await fetch('/api/signup', { method: 'POST', body: JSON.stringify({ email, clickIds: analytics.getClickIds() }) });
// clickIds: { gclid: 'EAIaIQ...', captured_at: '2026-11-26T10:00:00.000Z' } or undefined
```

Or on your server, from the Cookie header (the helpers do not need a browser):

```ts
import { clickIdsCookieName, parseClickIds } from '@manalens/web';

const name = clickIdsCookieName('mana_pk_...');
const raw = cookieHeader.split('; ').find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
const clickIds = parseClickIds(raw); // undefined when there is none
```

`parseClickIds` keeps only known networks and safe values.

### Sessions

Each event with an identity has a `session_id`: a UUID that is never the
`anonymous_id`. A new session starts after 30 minutes without an event, and
when the session is 24 hours old (a page that stays active for more than a day
gets a new session each 24 hours). The collector refuses an event that has an
`anonymous_id` and no `session_id`, and a `session_id` that is equal to the
`anonymous_id`.

`getSessionId()` returns the session ID of the next event, or `undefined` when
the SDK sends no identity (before consent, after `optOut()`, on an excluded
page). A read does not count as activity. Send it to your backend with the
`anonymous_id`, and put both on the server events of that visitor (for example
a purchase), so that the server event is in the visitor's session:

```ts
await fetch('/api/checkout', {
  method: 'POST',
  body: JSON.stringify({ cart, anonymousId: analytics.getAnonymousId(), sessionId: analytics.getSessionId() }),
});
```

A session that a pre-release SDK build stored (it has no start time) is not
continued: the first event after the update starts a new session.

### Event envelope

Each event in `POST /v0/events` (`{ events: [...] }`) has `type` (`page`,
`track` or `identify`), `event` (track only), `message_id`,
`channel: 'web'`, `version`, `original_timestamp`, `context`, `properties`,
`anonymous_id`, `session_id`, `user_id` (after `identify()`), and `traits`
(identify only). In consent mode before consent, `anonymous_id`, `session_id`
and `user_id` are absent.

The API prefix is `/v0`. SDK builds before this change posted to `/v1/events`,
which the Manalens API no longer serves; use a build that posts to
`/v0/events` with an API that has the `/v0` routes.

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

## Players who come from your game

A game that uses the Manalens Godot SDK can open your website with `Manalens.link_url(url)`. The link has a `mana_hid` parameter: the game's anonymous ID and the time the game made the link.

When the page loads, the SDK:

1. Removes `mana_hid` from the address bar (`history.replaceState`). Other parameters and the hash stay.
2. Sends one `track` event `identity_handoff` with `source_anonymous_id` (the game's ID) and `handoff_at` (unix seconds).

Manalens then counts the browser and the game install as one player, without `identify()`. The collector accepts a handoff for 10 minutes only, so a link that a player shares does not join other people. In consent mode the event waits for `setConsent(true)`. `setConsent(false)`, `optOut()` and `reset()` drop it. No setup is needed on the website.

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
const analytics = createAnalytics({ publishableKey, endpoint, requireConsent: true });
consentManager.onChange(granted => analytics.setConsent(granted));
```

`setConsent()` also works without `requireConsent`: `setConsent(false)` then
turns identity off for that instance.

## Browser and Electron games

A game that runs in a browser or in Electron (three.js, Phaser, PixiJS,
Babylon) can set the `app` option. Every event then carries `context.app` next
to `context.page`, and the channel stays `web`. The App filters and breakdowns
(platform, storefront, version, build, engine) and "errors by build" read it.
Device, OS and browser still come from the browser user agent.

```ts
const analytics = createAnalytics({
  publishableKey: 'YOUR_PUBLISHABLE_KEY',
  endpoint: 'https://api.example.com',
  app: { platform: 'web', storefront: 'itch', app_version: '1.4.0', build: '571', engine: 'other' },
});
analytics.track('game_open', { is_first_open: true });
```

| Field | Values |
| --- | --- |
| `platform` | required: `windows`, `macos`, `linux`, `web`, `android`, `ios`, `other` |
| `storefront` | `steam`, `itch`, `epic`, `gog`, `app_store`, `play`, `other` |
| `app_version` | 1 to 32 characters: letters, digits, `.`, `_`, `+`, `-` and space |
| `build` | 1 to 64 characters, same characters as `app_version` |
| `engine` | `godot`, `unity`, `unreal`, `other` |

These are the collector's own rules. An invalid object would make the collector
refuse every event, so the SDK drops it, writes one `console.warn`, and sends
plain web events. The SDK sends a copy: later changes to the object do nothing.

Snippet: `data-app-platform` (required for the others to apply),
`data-app-storefront`, `data-app-version`, `data-app-build`, `data-app-engine`.

For the standard game events (`game_open`, `session_start`, `session_end`,
`error`, `app_unclean_exit`, `game_updated`), see the analytics docs
`docs/sdks/app-events.mdx`, section "Browser and Electron games".

### Game portals (itch.io, CrazyGames)

The collector accepts events from a page on your project domain, one of its
subdomains, or a host in **Project settings > Allowed origins**. itch.io serves
HTML5 builds from `html.itch.zone` and `html-classic.itch.zone`. A new project
lists `*.itch.zone`, so an itch.io build works with no change. If you removed
it, add `*.itch.zone` again (or click **Restore default**). For CrazyGames, add
`*.crazygames.com`. A page on any other host gets `403`. See
[Game portals](https://docs.manalens.dev/sdks/web#game-portals).

## Snippet attributes

`data-publishable-key` and `data-endpoint` are required. The snippet shares identity across subdomains by default. Add
`data-cross-subdomain="false"` to set `crossSubdomainCookies: false`. Add
`data-require-consent="true"` for consent mode and call
`window.manalens.setConsent(true)` from your banner. Add
`data-auto-pageviews="false"` to send no automatic page views (call
`window.manalens.page()` yourself). Add `data-debug="true"` for
console logs. Add the `data-app-*` attributes for a browser game (see above).

| Attribute | Option |
| --- | --- |
| `data-publishable-key` | `publishableKey` (required) |
| `data-endpoint` | `endpoint` (required) |
| `data-cross-subdomain="false"` | `crossSubdomainCookies: false` |
| `data-require-consent="true"` | `requireConsent: true` |
| `data-auto-pageviews="false"` | `autoPageviews: false` |
| `data-debug="true"` | `logger: { enabled: true }` |
| `data-app-platform`, `data-app-storefront`, `data-app-version`, `data-app-build`, `data-app-engine` | `app` |

Other options (`tracking`, `batchSize`, `ready`, `errorHandler` ...) need the
npm package.

## Pageviews

`page(properties?)` tracks the current page. Without properties, it sends
nothing when the path and query are the same as the last page view. With
properties, it always sends.

With `autoPageviews: true` (the default) the SDK sends:

- **First load**: one page view at once, with the current title.
- **`history.pushState` / `replaceState`**: the SDK wraps both (once, however
  many instances there are). It waits one tick so the router can set the new
  `document.title`, then sends a page view only when the **path** changed. A
  query-only `replaceState` (filters, tabs) and a same-URL `replaceState`
  send none.
- **Back and forward (`popstate`)**: the URL is new at once, but the framework
  (Astro View Transitions, Next.js) swaps the page later. The SDK waits until
  `document.title` changes, checked every 50 ms, for at most 1 second, then
  reads the page fields and sends. It sends nothing when the path and query
  are the same as the last page view (for example a hash-only change). While
  this page view waits, a `pushState` / `replaceState` adds no page view.
  When the page hides (`pagehide`, or `visibilitychange` to hidden), a
  waiting page view is sent at once with the flush, so it is never lost.
- **`manalens:navigate`**: dispatch `window.dispatchEvent(new Event('manalens:navigate'))`
  after your router has shown the new page. The SDK sends at once (same
  path-and-query rule as `page()`).

Next.js, React Router, Vue Router and SvelteKit work without code. For a
framework with its own page-load event (Astro `astro:page-load`), you can set
`autoPageviews: false` (snippet: `data-auto-pageviews="false"`) and call
`page()` on each event, including the first. `destroy()` clears pending
events and listeners.

The SDK sends only URL origin and path; query strings and fragments are
omitted, while selected campaign fields are sanitized.

This repository is derived from the MIT-licensed Formo Web SDK. It does not
include wallet or chain code. The anonymous ID, storage fallback and cookie
domain logic are adapted from Formo's `generateAnonymousId`, `CookieStorage`
and `cookiePolicy`.

## Releasing

Releases publish from `.github/workflows/release.yml`:

1. Bump `version` in `package.json` on `main`.
2. Push a matching tag, for example `git tag v0.1.0 && git push origin v0.1.0`.
3. The workflow checks that the tag is on `main` and matches `package.json`,
   runs typecheck, build and tests, packs the tarball, and publishes that exact
   tarball with npm provenance (after approval in the `npm-publish`
   environment).
4. It then checks that the npm registry serves the same tarball, hashes
   `dist/snippet.global.js` from it, waits until cdn.manalens.dev serves identical
   bytes, and adds the pinned snippet tag to the GitHub release notes.

Run the workflow manually (`workflow_dispatch`) for a dry run: it runs
`npm publish --dry-run` and shows the SRI of the packed tarball in the job
summary. Locally, `bash scripts/generate-sri.sh` packs this checkout and prints
the tag without publishing.

## Local example and smoke check

`pnpm example` builds the browser bundle and serves a self-contained example at
`http://localhost:4317`. Its local collector records page and button events at
`/captured`. `pnpm test:example` exercises the built ESM package and browser
snippet against a local collector, including URL sanitization, cookie and
localStorage identity, and cross-subdomain cookie checks. No Formono or cloud services are needed.

## Ad and campaign attribution

Automatically captures the five standard UTM fields plus `utm_id`,
`utm_source_platform`, `utm_creative_format`, `utm_marketing_tactic`; external
referrer origins and Android app referrers (`android-app://com.google.android.youtube`); `ref` / `referral` / `referral_code`; Google `gclid`, `gbraid`,
`wbraid`, `gad_source`; Meta `fbclid`; Microsoft `msclkid`; TikTok `ttclid`;
X `twclid`; LinkedIn `li_fat_id`; Reddit `rdt_cid`; Snapchat `ScCid`. All
network IDs are preserved. `gad_source` marks the source but is not a click ID.
Derived `paid_source` and a deterministic `click_id` remain compatible with
Formo-style event context. Paid UTMs classify as `paid_utm` without a network ID.
The collector classifies each event into an acquisition `channel_type` (for example
Organic Video or Paid Video for YouTube). Every event also carries
`context.library_name` and `context.library_version`.

Every event also carries `context.utc_offset`: the clock's offset from UTC in
minutes (480 for UTC+8). The collector uses it only to match a game install to
a website visit (install attribution) and does not store it on events. The
collector must be a version that accepts this field; an older collector
refuses the event.

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
