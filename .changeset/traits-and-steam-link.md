---
"@manalens/web": minor
"@manalens/node": minor
---

New `traits()` call (P-2814): set traits on a player with or without a user ID. The web SDK and Node app mode drop the protected traits (`email`, `itch_user_id`, `stripe_customer_id`, `paddle_customer_id`) with one warning; Node server mode sends them. New `link({ provider: 'steam', ticket })` call (P-2815): verify the Steam account of a player with a ticket from `GetAuthTicketForWebApi("manalens")`. It posts once to `/v0/link` on the API host, and tries once more only after a 429 with `Retry-After`.
