// Adapted from getformo/sdk's EventFactory and traffic-source sanitizer.
import type { AnalyticsEvent } from './types';
import { attributionContext } from './attribution-contract';

export function pageContext(pageUrl = location.href): AnalyticsEvent['context'] {
  const url = new URL(pageUrl);
  const path = url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '/';
  // Only explicitly selected campaign parameters leave the browser. Full query
  // strings and fragments often contain emails, tokens, and other private data.
  const campaign = attributionContext({}, url);
  let referrer = '';
  if (document.referrer) {
    try {
      const ref = new URL(document.referrer);
      if (ref.hostname !== url.hostname && /^https?:$/.test(ref.protocol)) referrer = ref.origin;
    } catch { /* Ignore malformed referrers. */ }
  }
  return {
    page: { path, title: document.title.slice(0, 300), url: `${url.origin}${path}` },
    referrer,
    ...campaign,
    locale: navigator.language?.slice(0, 32),
  };
}
