# @manalens/node

## 0.4.0

### Minor Changes

- 1237179: `sdkCookieName(publishableKey, name)`: the name of a web SDK cookie (`mana_<FNV-1a hash>_anonymous-id`), so a server can read the browser's anonymous ID without copying the hash.

## 0.3.0

### Minor Changes

- 13b7e0a: `app.device`: app mode sends `steam_deck` when the environment variable `SteamDeck` is `1` (Steam sets it on a Steam Deck). Server mode accepts `context.device` `steam_deck`.

## 0.2.1

### Patch Changes

- e74e0b1: A 413 (batch too large) no longer drops the batch. The SDK keeps every event, halves the batch, and sends again at once, without a backoff wait and without counting a retry. A 413 for a single event drops that event. After an accepted batch, the full batch size applies again.

## 0.2.0

### Minor Changes

- 036a52f: New `traits()` call (P-2814): set traits on a player with or without a user ID. The web SDK and Node app mode drop the protected traits (`email`, `itch_user_id`, `stripe_customer_id`, `paddle_customer_id`) with one warning; Node server mode sends them. New `link({ provider: 'steam', ticket })` call (P-2815): verify the Steam account of a player with a ticket from `GetAuthTicketForWebApi("manalens")`. It posts once to `/v0/link` on the API host, and tries once more only after a 429 with `Retry-After`.

## 0.1.1

### Patch Changes

- 3660d1f: Console values (P-2776) in the app context: `platform` accepts `ps5`, `xbox_series`, `xbox_one`, `switch`, and `switch2`; `storefront` accepts `psn`, `xbox`, and `nintendo`.
