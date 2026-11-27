---
"@manalens/web": minor
---

Game mode: `app_crash` at the next load when a focused tab of the game closed without `pagehide` (for example out of memory), with `previous_session_id`, `previous_build` and `previous_app_version`. A normal close, reload or navigation is never a crash. Errors carry `breadcrumbs`: the names of the last 20 `track` events, cut to 1024 characters, as in the game SDKs. `reset()`, `setConsent(false)` and `optOut()` clear them.
