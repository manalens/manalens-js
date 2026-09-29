import { Analytics } from './index';

declare global {
  interface Window { untitledAnalytics?: Analytics; untitledAnalyticsConsent?: () => boolean; }
}

if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null;
  const key = script?.dataset.writeKey;
  const endpoint = script?.dataset.endpoint;
  if (key && endpoint) window.untitledAnalytics = new Analytics({ writeKey: key, endpoint, ...(script?.dataset.attribution === 'true' ? { attribution: { consent: () => window.untitledAnalyticsConsent?.() === true } } : {}) });
}
