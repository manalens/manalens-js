# @manalens/web

## 0.8.0

### Minor Changes

- da7fc8a: Page URLs keep the query string and the fragment, without the parameters that can hold a secret: built-in names (token, code, state, key, secret, password, session_id, owns and more), `tracking.excludeQueryParams`, and values that look secret (Stripe secret prefixes, JWTs and signed tokens, emails, SteamIDs, long random strings). The kept fragment is also sent as `page.hash`. Campaign parameters stay campaign fields.

## 0.7.0

### Minor Changes

- dd3e5e4: Installed-app pages: Electron `app://` and `file://`, Tauri, Capacitor and other custom schemes. When the page is not `http` or `https` and the `app` option is valid, the SDK sends app events: `channel: 'app'`, `context.app`, no `context.page`, referrer or campaign fields, and `sent_at` in each request for clock correction. There are no page views there: `autoPageviews` does nothing and `page()` sends nothing (one `console.warn`). Game mode works the same. No cookies are used on such a page: the anonymous ID and the session are in `localStorage`, the user ID in `sessionStorage`. Without a valid `app` option on such a page, the SDK writes one `console.warn` and sends web events as before. `http` and `https` pages do not change.

## 0.6.0

### Minor Changes

- e14fe67: Game mode: `game_crash` at the next load when a focused tab of the game closed without `pagehide` (for example out of memory), with `previous_session_id`, `previous_build` and `previous_app_version`. A normal close, reload or navigation is never a crash. Errors carry `breadcrumbs`: the names of the last 20 `track` events, cut to 1024 characters, as in the game SDKs. `reset()`, `setConsent(false)` and `optOut()` clear them.
- e14fe67: Game mode: hang detection. A main thread blocked for at least `hangThresholdMs` (default 5000, `0` turns it off) sends an `error` with `error_type` `game_hang` and `hang_duration_s` (seconds, one decimal) when it runs again (long-animation-frame or longtask entries where the browser has them, else a timer). Never while the page is hidden or just visible again. A `game_crash` after a hang has the hang's `message_id` in `hang_message_id`.

## 0.5.1

### Patch Changes

- eeb0a4d: The SDK works on plain http:// pages. `crypto.randomUUID` exists only in secure contexts (HTTPS and localhost), so the anonymous ID, session ID, and event `message_id` now fall back to a v4 UUID from `crypto.getRandomValues` when it is missing. Before, `new Analytics()` threw on such pages and no event was sent.

## 0.5.0

### Minor Changes

- a361197: New `shutdown(timeoutMs = 2000)` for browser and Electron games. In game mode it ends the open session with `session_end` (`duration_s`), then sends the queue with normal requests for at most `timeoutMs`, and stops the instance, like the Node SDK's `shutdown()`. Events not sent in time stay in the stored queue with `persistQueue`. Call `await analytics.shutdown()` before an Electron game quits.
  
  The send on `pagehide` and on a hidden page no longer goes over the browser's 64 KiB keepalive limit. Its keepalive request bodies in flight together are at most 60000 bytes (UTF-8). The events that do not fit stay queued (and stored with `persistQueue`) for the next send. One event over the limit is sent alone without keepalive.

### Patch Changes

- e74e0b1: A 413 (batch too large) no longer drops the batch. The SDK keeps every event, halves the batch, and sends again at once, without a backoff wait and without counting a retry. A 413 for a single event drops that event. After an accepted batch, the full batch size applies again.

## 0.4.0

### Minor Changes

- 3954739: Breaking: captured window errors and unhandled rejections now send `source: "auto"` (was `"web_window"`); `trackError()` still sends `source: "manual"`.

## 0.3.0

### Minor Changes

- c30dcc4: Add optional game mode (`game: true`: `game_open`, `session_start` / `session_end`, and captured window errors), a `trackError()` method for handled errors, and an optional persistent queue (`persistQueue`, IndexedDB with a localStorage fallback) for browser and Electron games.

## 0.2.0

### Minor Changes

- 036a52f: New `traits()` call (P-2814): set traits on a player with or without a user ID. The web SDK and Node app mode drop the protected traits (`email`, `itch_user_id`, `stripe_customer_id`, `paddle_customer_id`) with one warning; Node server mode sends them. New `link({ provider: 'steam', ticket })` call (P-2815): verify the Steam account of a player with a ticket from `GetAuthTicketForWebApi("manalens")`. It posts once to `/v0/link` on the API host, and tries once more only after a 429 with `Retry-After`.

## 0.1.1

### Patch Changes

- 3660d1f: Console values (P-2776) in the app context: `platform` accepts `ps5`, `xbox_series`, `xbox_one`, `switch`, and `switch2`; `storefront` accepts `psn`, `xbox`, and `nintendo`.
