---
"@manalens/web": minor
---

Page URLs keep the query string and the fragment, without the parameters that can hold a secret: built-in names (token, code, state, key, secret, password, session_id, owns and more), `tracking.excludeQueryParams`, and values that look secret (Stripe secret prefixes, JWTs and signed tokens, emails, SteamIDs, long random strings). The kept fragment is also sent as `page.hash`. Campaign parameters stay campaign fields.
