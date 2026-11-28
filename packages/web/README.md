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
- Run `bash packages/web/scripts/generate-sri.sh --version 0.1.0 --check-registry --check-cdn`
  from a clone of this repository.
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
| `first-open` | localStorage, else memory | Until `optOut()` or `setConsent(false)` | Game mode only: the time of the first `game_open` |
| `game-state` | localStorage | While a game session is open; removed on `pagehide`, `shutdown()`, `destroy()`, `reset()`, `optOut()` and `setConsent(false)` | Game mode only: one entry per open tab (session ID, last write time, focus, build, version), for `game_crash` |
| `queue` | IndexedDB, else localStorage | Until the collector accepts the events; at most 1000 events and 7 days | `persistQueue` only: unsent events |

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
| `apiEndpoint` | from `endpoint` | API base URL of `link()`. Default: the `endpoint` with an `events.` host changed to `api.` (`https://events.manalens.dev` gives `https://api.manalens.dev`). Other endpoints are used as they are. Snippet: `data-api-endpoint` |
| `crossSubdomainCookies` | `true` | Apex-domain identity cookies; `false` for host-only |
| `autoPageviews` | `true` | Initial pageview, SPA navigation (`history.pushState` / `replaceState`), back and forward (`popstate`) and `manalens:navigate`; see [Pageviews](#pageviews). Snippet: `data-auto-pageviews="false"` |
| `batchSize` | `30` | Events per request (the collector takes at most 50) |
| `flushIntervalMs` | `15000` | Flush timer; the page hiding or closing sends at once |
| `retryCount` | `3` | Retries after a server error (408, 429, 5xx), 0 to 10. Network errors (offline) and 413 responses are not counted. Other 4xx responses are not retried. |
| `maxQueueSize` | `512000` | Queue limit in bytes (200 to 500 KB). The oldest events are dropped first. |
| `requireConsent` | `false` | Consent mode; see below |
| `tracking` | `true` | `false` is the same as `disabled: true`. An object sets rules: `{ excludeHosts, excludePaths, excludeTimezones, excludeQueryParams }`; see [Tracking rules](#tracking-rules) |
| `disabled` | `false` | No events and no browser storage |
| `logger` | off | `{ enabled: true, levels?: ['trace', 'debug', 'info', 'warn', 'error'] }`; see [Logging](#logging). Snippet: `data-debug="true"` |
| `ready` | none | `(analytics) => void`, called once at the end of the constructor (also when disabled). Snippet: the `manalens:ready` event |
| `errorHandler` | none | `(error) => void`, called when events are dropped: refused by the collector, or a server error after `retryCount` retries. See [Delivery errors](#delivery-errors) |
| `app` | none | App context for a browser or Electron game; see [Browser and Electron games](#browser-and-electron-games) |
| `game` | `false` | Game mode: `game_open`, `session_start` / `session_end` and captured errors. Needs `app`. See [Game mode](#game-mode). Snippet: `data-game="true"` |
| `persistQueue` | `true` in game mode, else `false` | Keep unsent events in IndexedDB (else localStorage) for the next load. Needs `app`. See [Persistent queue](#persistent-queue). Snippet: `data-persist-queue` |
| `hangThresholdMs` | `5000` | Game mode: a main thread blocked this many milliseconds is a hang (`game_hang`). `0` turns hang detection off; other values are kept between 1000 and 60000. See [Hangs](#hangs). Snippet: `data-hang-threshold-ms` |

**Delivery.** Events wait in memory and are sent in batches. They go to
browser storage only with the `persistQueue` option (a game with `app`; see
[Persistent queue](#persistent-queue)). After a failed send, the timer and full batches wait: 1 s, 2 s, 4 s ...
up to 30 s, with jitter, or longer when a `429` has `Retry-After` (up to 60 s).
A call to `flush()` sends at once. `pagehide`, and `visibilitychange` to
hidden, send with `keepalive`.

**Keepalive size.** Browsers refuse a `keepalive` request when its body, plus
the bodies of the page's other `keepalive` requests still in flight, is over
64 KiB. The send on `pagehide` (and on a hidden page) therefore keeps its
`keepalive` request bodies to at most 60000 bytes (UTF-8 of the exact body)
in flight together, in requests of at most `batchSize` events each. The events
that do not fit stay queued (and stored with `persistQueue`) and go with the
next send, or on the next load. One event whose body alone is over 60000
bytes is sent alone with a normal request, without `keepalive`: it completes
when the page is only hidden, and often also when it closes.

**Batch too large (413).** The collector answers `413` when a batch is too
large. The SDK keeps every event (same order, same `message_id`), halves the
batch, and sends again at once. This is not a failure: there is no backoff
wait, and it does not count toward `retryCount`. Each new `413` halves the
batch again. A `413` for a single event drops that event (`errorHandler` gets
`status` 413 and `dropped` 1). After an accepted batch, the full `batchSize`
applies again. A `413` to the `keepalive` send on `pagehide` does not send
again on that page: the events stay queued (and stored with `persistQueue`),
and the next send uses the smaller batch.

### Delivery errors

`errorHandler` gets a `SendError` (`name`, `message`, `status`, `dropped`,
`reasons`) when events are dropped:

- The collector refused the batch (a 4xx other than 408, 413 and 429, for example
  `401` for a wrong key or `403` for a page off the project domain). A refused
  batch is dropped and is not sent again. `reasons` has the reason codes of
  the collector, and `message` (also in the error log) has its text, for
  example `HTTP 400 INVALID_EVENT, SESSION_ID_REQUIRED: ...`.
- The collector answered `413` (too large) for a batch of one event. A larger
  batch is halved and sent again, not dropped.
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
| `warn` | A failed send that will be retried (status or network error), a batch halved after a 413, a full queue that dropped an event |
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
`traits(traits)`, `link({ provider: 'steam', ticket })`,
`trackError(errorOrMessage, options?)`, `reset()`, `setConsent(granted)`,
`optOut()`, `optIn()`, `isOptedOut()`, `getUserId()`, `getAnonymousId()`,
`getSessionId()`, `flush(keepalive?)`, `shutdown(timeoutMs?)`, `destroy()`.

| Method | Notes |
| --- | --- |
| `flush(keepalive?)` | Send one batch now (with `keepalive`: the queue, in requests of at most 60000 bytes together). Ignores the backoff wait. |
| `shutdown(timeoutMs = 2000)` | End the game and stop. In game mode, ends the open session with `session_end` (`duration_s`). Then sends the queue with normal requests for at most `timeoutMs`, and stops like `destroy()`: later calls send nothing. Events not sent in time stay in the stored queue with `persistQueue`. Never rejects. See [Quit an Electron game](#quit-an-electron-game). |
| `destroy()` | Stop at once: remove timers and listeners, and discard the events in memory. Stored events (`persistQueue`) stay. |

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
`track`, `identify` or `traits`), `event` (track only), `message_id`,
`channel: 'web'`, `version`, `original_timestamp`, `context`, `properties`,
`anonymous_id`, `session_id`, `user_id` (after `identify()`), and `traits`
(identify and traits only). In consent mode before consent, `anonymous_id`, `session_id`
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

## Traits

`traits()` sets traits on the player of this browser. It needs no user ID:
before `identify()`, the traits belong to the anonymous ID of this browser;
after it, to the user. It queues a `traits` event. A `null` value clears a
trait.

```ts
analytics.traits({ level: 3, difficulty: 'hard', discord_id: '123456789012345678' });
```

- At most 50 keys and 2 KB as JSON. Values are strings, numbers, booleans or
  `null`. A bad call throws.
- The protected traits `email`, `itch_user_id`, `stripe_customer_id` and
  `paddle_customer_id` are not sent: the collector drops them from web
  events. The SDK prints one console warning. Set them from your server with
  `@manalens/node` and the secret key.
- Like `identify()`, it waits for consent and for an allowed page. Calls made
  before then are merged and sent together.

## Verify Steam ownership

A browser or Electron game on Steam can link the player's Steam account with a
Steam ticket. Manalens checks the ticket with Steam and reads which of your
apps the account owns. The player does not sign in.

Make the ticket with `GetAuthTicketForWebApi("manalens")` (the identity must be
`manalens`), wait for the ticket callback, and pass the ticket bytes as hex:

```ts
const result = await analytics.link({ provider: 'steam', ticket: ticketHex });
if (!result.linked) console.warn('Steam link failed', result.status, result.code);
```

- The SDK posts once to `<apiEndpoint>/v0/link` with the anonymous ID. A
  refused ticket is not sent again. After a `429` with `Retry-After` (up to
  60 s), it tries once more.
- It returns `{ linked, status, code? }` and never throws for an HTTP or
  network error. `code` is the API error code (for example
  `STEAM_TICKET_INVALID` or `STEAM_NOT_CONNECTED`) or `DISABLED`,
  `CONSENT_REQUIRED`, `EXCLUDED`, `NETWORK_ERROR` or `IDENTITY_CHANGED`.
- During the `Retry-After` wait, `reset()`, `setConsent(false)`, `optOut()`
  or a move to an excluded page stops the second try: the old ticket and
  anonymous ID are not sent again.
- A bad provider or ticket throws.

See [Steam ownership](https://docs.manalens.dev/features/steam-ownership) and
the [Link API](https://docs.manalens.dev/api/link).

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
- An `identify()` or `traits()` call made before consent is held in memory and
  sent when consent is granted. `link()` sends nothing before consent.
- `setConsent(true)` creates or restores the persistent ID. Call it on each
  page load once your consent manager reports consent; the SDK does not store
  the consent choice.
- `setConsent(false)` clears all identity storage, drops the user ID, removes
  identity fields from queued events and discards queued identify and traits
  events.

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
| `platform` | required: `windows`, `macos`, `linux`, `web`, `android`, `ios`, `ps5`, `xbox_series`, `xbox_one`, `switch`, `switch2`, `other` |
| `storefront` | `steam`, `itch`, `epic`, `gog`, `app_store`, `play`, `psn`, `xbox`, `nintendo`, `other` |
| `app_version` | 1 to 32 characters: letters, digits, `.`, `_`, `+`, `-` and space |
| `build` | 1 to 64 characters, same characters as `app_version` |
| `engine` | `godot`, `unity`, `unreal`, `other` |

These are the collector's own rules. An invalid object would make the collector
refuse every event, so the SDK drops it, writes one `console.warn`, and sends
plain web events. The SDK sends a copy: later changes to the object do nothing.

Snippet: `data-app-platform` (required for the others to apply),
`data-app-storefront`, `data-app-version`, `data-app-build`, `data-app-engine`.

With `game: true` the SDK sends `game_open`, `session_start`, `session_end`,
`error` and `game_crash` for you; see [Game mode](#game-mode). For the other
standard game events (`game_updated`), see the analytics docs
`docs/sdks/app-events.mdx`, section "Browser and Electron games".

### Game mode

```ts
const analytics = createAnalytics({
  publishableKey: 'YOUR_PUBLISHABLE_KEY',
  endpoint: 'https://api.example.com',
  app: { platform: 'web', storefront: 'itch', app_version: '1.4.0', build: '571', engine: 'other' },
  game: true,
});
```

`game: true` needs a valid `app` option. Without one, game mode stays off and
the SDK writes one `console.warn`. Websites leave it off. The events match the
Godot, Unity and Unreal SDKs, so the Game KPIs and Game health dashboards count
them:

| Event | Properties | When |
| --- | --- | --- |
| `session_start` | none | Before `game_open`, and before the first event of each new session |
| `game_open` | `is_first_open`, `first_open_at` (ISO 8601) | Each start (page load) |
| `session_end` | `duration_s`, and `errors_dropped` when errors were dropped | `pagehide`; `shutdown()`; `reset()`; or, after 30 minutes without events or at 24 hours, with the next event (it then has the time of the last activity) |
| `error` | `severity`, `message`, `error_type`, `handled`, `source`, `fingerprint`, and `file`, `line`, `function`, `stack`, `breadcrumbs` when known | A window `error` or `unhandledrejection` (`source: "auto"`, `handled: false`), or `trackError()` (`source: "manual"`) |
| `game_crash` | `previous_session_id`, and `previous_build`, `previous_app_version` when the `app` option has them, and `hang_message_id` when the session had a `game_hang` | At the next load, when a tab of the game closed without `pagehide` (for example a tab that ran out of memory) while it was visible and had focus. It is sent in the session that crashed, with the time of its last saved state |

- **Sessions** use the web session rules above (30 minutes idle, 24 hours at
  most), with no second clock. Each start is a new session. While the page is
  visible and focused, the flush timer keeps the open session alive, as the
  game SDKs do while the game has focus.
- **First open** is kept in the SDK storage (key `first-open`). A player who
  has the `first_open_at` key of the earlier hand-written setup snippet is not
  counted as new.
- **Consent mode:** `game_open` and the sessions wait for `setConsent(true)`;
  nothing is stored before. `setConsent(false)` and `optOut()` delete the
  first open. `reset()` sends `session_end` with the old identity; the next
  event starts a new session.
- **Crashes:** while a game session is open, each tab keeps an entry in
  localStorage (key `game-state`): its session ID, whether the page is visible
  and has focus, and the time. It writes the entry every 5 seconds and on
  `focus`, `blur` and visibility changes. `pagehide` (a close, a reload or a
  navigation), `shutdown()`, `destroy()` and `reset()` remove it, so a normal
  close is never a crash. An entry that is still there at the next load, of a
  tab that was visible and had focus, gives `game_crash`, as the game SDKs do
  ("only when the last saved session was open and focused"). A tab that the
  browser closed in the background is not a crash. Several tabs of the same
  game each have their own entry: an entry written in the last 20 seconds can
  be a tab that is still open, so the SDK looks at it again 20 seconds later
  and sends `game_crash` only when it was not written since. `game_crash` goes
  with the anonymous ID and user ID of the session that crashed, and only when
  that anonymous ID is still the current one: after `reset()` or a new
  identity, the old crash is dropped. In consent mode, nothing is saved before
  `setConsent(true)`.
- **Breadcrumbs:** each `error` has `breadcrumbs`, the names of the last 20
  `track` events (not `error` events and not page views; none from before
  consent or from an excluded page), oldest first,
  joined with commas, as in the game SDKs. The string is cut to its last 1024
  characters: the collector refuses an event with a longer property string.
  `reset()`, `setConsent(false)` and `optOut()` clear the breadcrumbs, so the
  event names of the old player never reach a later error.

### Quit an Electron game

A browser tab ends the session on `pagehide`. An Electron game that quits from
its own menu should call `shutdown()` before it closes the window, as the game
SDKs do on quit: `session_end`, then send for at most 2 seconds.

```ts
// Renderer: the quit button of the game.
quitButton.addEventListener('click', async () => {
  await analytics.shutdown(); // session_end, then send for at most 2 s
  window.close();
});
```

When the main process starts the quit (the window close button, `app.quit()`),
send an IPC message to the renderer and let it call `shutdown()` before the
window closes. `shutdown(timeoutMs = 2000)` never rejects. It sends with normal requests (not
`keepalive`), so the requests are not limited to 64 KiB. Events that are not
sent in time stay in the stored queue (`persistQueue`, on by default in game
mode) and go on the next start. After `shutdown()` the instance is stopped,
like the Node SDK after its `shutdown()`: later calls send nothing. Create a
new instance to track again. Without game mode, `shutdown()` only sends the
queue and stops. With the snippet, call `await window.manalens.shutdown()`.

### Errors

Captured errors (window `error` and `unhandledrejection`) lose personal data
before they are queued: URLs lose their user, query and fragment, emails
become `[email]`, home folders become `~`, and token values and long IDs become
`[redacted]`. `file` is the script path, without origin and query.

```ts
try { await saveGame(slot); } catch (error) {
  analytics.trackError(error, { severity: 'critical', properties: { slot } });
}
analytics.trackError('Save failed for slot 3', { errorType: 'SaveFailed', handled: false });
```

`trackError(errorOrMessage, options?)` works in every mode. An `Error` gives
the message, `error_type` (its `name`), the stack and the place in the code.
Options: `severity` (`debug`, `info`, `warning`, `error` (default),
`critical`), `errorType`, `handled` (default `true`), `fingerprint`, `stack`,
`file`, `line`, `function`, `properties`. The text you pass is sent as it is.

- **Grouping** is the rule of the game SDKs: `fingerprint` is a hash of
  `error_type`, `file` and `function` (not the line). Without a file or
  function, it is a hash of the message with numbers and quoted text removed,
  so `Save failed for slot 3` and `Save failed for slot 4` are one group. Pass
  `fingerprint` to group in your own way.
- **Limits:** the same fingerprint at most once a second, at most 20 errors in
  10 seconds, and at most 50 captured errors in one session (`trackError()`
  skips only this last limit). The next `session_end` has the number of
  dropped errors in `errors_dropped`. `message` and `stack` are at most 1024
  characters; the properties at most 50 keys and 8 KB of JSON.

### Hangs

In game mode the SDK watches the main thread. When it was blocked for at
least `hangThresholdMs` (default 5000 ms), the SDK sends an `error` when the
thread runs again: `error_type` `game_hang`, `severity` `error`, `handled`
`false`, `source` `auto`, the message `The main thread was blocked for 6.2 s`,
and `hang_duration_s` (seconds, one decimal, for example `6.2`). The error limits of other captured errors apply.

- Where the browser has `long-animation-frame` entries (Chromium), the script
  that ran longest gives `file` and `function`, and `stack` lists the scripts
  of the frame (without query and fragment). Where it has only `longtask`
  entries, or neither (Firefox, Safari: a timer every 500 ms that runs late),
  there is no place and no stack: the hangs then group by their message.
- Background tabs throttle and freeze timers, so no hang is reported while
  the page is hidden or frozen, or in the first second after it becomes
  visible. A gap of more than 10 minutes, or one where the wall clock and the
  monotonic clock do not agree, is a sleep of the computer, not a hang.
- A hang that never ends cannot be reported: a blocked page runs no code. If
  the tab then crashes, the next load sends `game_crash` without
  `hang_message_id`. If the game crashes after a hang that ended, the
  `game_crash` has the `message_id` of that `game_hang` error in
  `hang_message_id`.

### Persistent queue

By default, unsent events wait in memory: a crash, a lost GPU context or a tab
closed offline loses them. With `persistQueue` (on by default in game mode,
allowed only with `app`), the SDK also keeps each event in IndexedDB (else
localStorage), as the Godot and Unity SDKs keep a disk queue:

- At most 1000 events and 7 days; older events are dropped first.
- On the next load, the stored events are sent first, in order, before the new
  events. Each keeps its `message_id`, so an event sent twice counts once.
- A stored event is removed only when the collector accepts its batch (or
  refuses it for good).
- Consent mode: nothing is stored before consent. `setConsent(false)` and
  `optOut()` delete the stored events. `reset()` keeps them, as it keeps the
  events in memory.
- Two tabs of the same game can both send a stored event; the `message_id`
  makes it count once.

Set `persistQueue: false` to keep game mode without browser storage for events.

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
| `data-api-endpoint` | `apiEndpoint` |
| `data-cross-subdomain="false"` | `crossSubdomainCookies: false` |
| `data-require-consent="true"` | `requireConsent: true` |
| `data-auto-pageviews="false"` | `autoPageviews: false` |
| `data-debug="true"` | `logger: { enabled: true }` |
| `data-app-platform`, `data-app-storefront`, `data-app-version`, `data-app-build`, `data-app-engine` | `app` |
| `data-game="true"` | `game: true` (needs `data-app-platform`) |
| `data-persist-queue="true"` or `"false"` | `persistQueue` |

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

Releases use Changesets and `.github/workflows/release.yml`. See
[RELEASING.md](https://github.com/manalens/manalens-js/blob/main/RELEASING.md). The web release also checks that the npm
registry serves the published tarball, hashes `dist/snippet.global.js` from it,
waits until cdn.manalens.dev serves identical bytes, and adds the pinned snippet
tag to the GitHub release notes (tag `web-vX.Y.Z`).

Locally, `bash scripts/generate-sri.sh` (in `packages/web`) packs this package
and prints the tag without publishing.

## Local example and smoke check

In `packages/web`, `pnpm example` builds the browser bundle and serves a self-contained example at
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
