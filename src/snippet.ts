import { Analytics } from './index';
import { appInfoFromDataset } from './app';
import type { AnalyticsOptions } from './types';

declare global {
  interface Window { untitledAnalytics?: Analytics; }
}

if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null;
  const key = script?.dataset.writeKey;
  const endpoint = script?.dataset.endpoint;
  if (key && endpoint) {
    window.untitledAnalytics = new Analytics({
      writeKey: key,
      endpoint,
      crossSubdomainCookies: script?.dataset.crossSubdomain !== 'false',
      requireConsent: script?.dataset.requireConsent === 'true',
      // data-app-platform, data-app-storefront, data-app-version, data-app-build, data-app-engine
      app: appInfoFromDataset(script?.dataset ?? {}) as AnalyticsOptions['app'],
    });
  }
}
