---
"@manalens/web": patch
---

The SDK works on plain http:// pages. `crypto.randomUUID` exists only in secure contexts (HTTPS and localhost), so the anonymous ID, session ID, and event `message_id` now fall back to a v4 UUID from `crypto.getRandomValues` when it is missing. Before, `new Analytics()` threw on such pages and no event was sent.
