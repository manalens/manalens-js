---
"@manalens/web": patch
"@manalens/node": patch
---

A 413 (batch too large) no longer drops the batch. The SDK keeps every event, halves the batch, and sends again at once, without a backoff wait and without counting a retry. A 413 for a single event drops that event. After an accepted batch, the full batch size applies again.
