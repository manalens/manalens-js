// Adapted from getformo/sdk's EventFactory and traffic-source sanitizer.
import type { AnalyticsEvent } from './types';
import { attributionContext } from './attribution-contract';
import { pageUrlParts } from './url-privacy';

export function pageContext(pageUrl = location.href, excludedParams: readonly string[] = []): AnalyticsEvent['context'] {
  const url = new URL(pageUrl);
  const path = url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '/';
  // Campaign parameters are campaign fields. The page URL keeps the other
  // query parameters and the fragment, without the names and values that can
  // hold a secret (url-privacy.ts) and without tracking.excludeQueryParams.
  // The collector applies the same rules again, with the project's list.
  const campaign = attributionContext({}, url, excludedParams);
  let referrer = '';
  if (document.referrer) {
    try {
      const ref = new URL(document.referrer);
      // Android Chrome reports an app's package when a link opens from an app,
      // e.g. android-app://com.google.android.youtube/. The collector classifies it.
      if (ref.protocol === 'android-app:') referrer = `android-app://${ref.host.toLowerCase()}`;
      else if (ref.hostname !== url.hostname && /^https?:$/.test(ref.protocol)) referrer = ref.origin;
    } catch { /* Ignore malformed referrers. */ }
  }
  return {
    page: { path, title: document.title.slice(0, 300), ...pageUrlParts(url, path, excludedParams) },
    referrer,
    ...campaign,
    locale: navigator.language?.slice(0, 32),
    ...utcOffset(),
  };
}

/**
 * The clock's offset from UTC in minutes (480 for UTC+8). The collector uses
 * it only to match a game install to a website visit and does not store it on
 * events. It accepts -720 to 840; any other value is left out.
 */
export function utcOffset(now: Date = new Date()): { utc_offset?: number } {
  const minutes = 0 - now.getTimezoneOffset();
  return Number.isInteger(minutes) && minutes >= -720 && minutes <= 840 ? { utc_offset: minutes } : {};
}
