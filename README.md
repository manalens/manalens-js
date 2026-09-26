# Untitled Analytics Web SDK

The browser SDK preserves the generic Formo event envelope while sending no
cookies, localStorage IDs, sessionStorage IDs, or cross-day anonymous IDs. The
ingestion server assigns a site-scoped daily rotating `session_id`.

```ts
import { createAnalytics } from '@untitled-analytics/web';

const analytics = createAnalytics({
  writeKey: 'site_public_key',
  endpoint: 'https://api.example.com',
});
analytics.track('signup_completed', { plan: 'starter' });
```

`page()` tracks the current page. By default the SDK also sends an initial
pageview and listens for `popstate`. For routers that do not emit
`popstate`, call `analytics.page()` after each route change. `destroy()` clears
pending events and listeners. The SDK sends only URL origin and path; query
strings and fragments are omitted, while selected UTM fields are sanitized.

This repository is derived from the MIT-licensed Formo Web SDK. It does not
include wallet, chain, or persistent anonymous identity code.
