---
"@manalens/web": minor
---

New `shutdown(timeoutMs = 2000)` for browser and Electron games. In game mode it ends the open session with `session_end` (`duration_s`), then sends the queue with normal requests for at most `timeoutMs`, and stops the instance, like the Node SDK's `shutdown()`. Events not sent in time stay in the stored queue with `persistQueue`. Call `await analytics.shutdown()` before an Electron game quits.

The send on `pagehide` and on a hidden page no longer goes over the browser's 64 KiB keepalive limit. Its keepalive request bodies in flight together are at most 60000 bytes (UTF-8). The events that do not fit stay queued (and stored with `persistQueue`) for the next send. One event over the limit is sent alone without keepalive.
