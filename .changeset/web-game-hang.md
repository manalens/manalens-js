---
"@manalens/web": minor
---

Game mode: hang detection. A main thread blocked for at least `hangThresholdMs` (default 5000, `0` turns it off) sends an `error` with `error_type` `game_hang` and `hang_duration_s` (seconds, one decimal) when it runs again (long-animation-frame or longtask entries where the browser has them, else a timer). Never while the page is hidden or just visible again. A `game_crash` after a hang has the hang's `message_id` in `hang_message_id`.
