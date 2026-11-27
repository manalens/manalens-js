---
"@manalens/web": minor
---

Breaking: captured window errors and unhandled rejections now send `source: "auto"` (was `"web_window"`); `trackError()` still sends `source: "manual"`.
