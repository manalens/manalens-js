---
"@manalens/web": minor
---

Installed-app pages: Electron `app://` and `file://`, Tauri, Capacitor and other custom schemes. When the page is not `http` or `https` and the `app` option is valid, the SDK sends app events: `channel: 'app'`, `context.app`, no `context.page`, referrer or campaign fields, and `sent_at` in each request for clock correction. There are no page views there: `autoPageviews` does nothing and `page()` sends nothing (one `console.warn`). Game mode works the same. No cookies are used on such a page: the anonymous ID and the session are in `localStorage`, the user ID in `sessionStorage`. Without a valid `app` option on such a page, the SDK writes one `console.warn` and sends web events as before. `http` and `https` pages do not change.
