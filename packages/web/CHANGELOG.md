# @manalens/web

## 0.2.0

### Minor Changes

- 036a52f: New `traits()` call (P-2814): set traits on a player with or without a user ID. The web SDK and Node app mode drop the protected traits (`email`, `itch_user_id`, `stripe_customer_id`, `paddle_customer_id`) with one warning; Node server mode sends them. New `link({ provider: 'steam', ticket })` call (P-2815): verify the Steam account of a player with a ticket from `GetAuthTicketForWebApi("manalens")`. It posts once to `/v0/link` on the API host, and tries once more only after a 429 with `Retry-After`.

## 0.1.1

### Patch Changes

- 3660d1f: Console values (P-2776) in the app context: `platform` accepts `ps5`, `xbox_series`, `xbox_one`, `switch`, and `switch2`; `storefront` accepts `psn`, `xbox`, and `nintendo`.
