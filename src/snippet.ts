import { Analytics } from './index';
import { appInfoFromDataset } from './app';
import type { AnalyticsOptions } from './types';

declare global {
  interface Window { untitledAnalytics?: Analytics; }
}

if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null;
  // data-publishable-key; data-write-key is its old name and still works.
  const publishableKey = script?.dataset.publishableKey;
  const writeKey = script?.dataset.writeKey;
  const endpoint = script?.dataset.endpoint;
  if ((publishableKey || writeKey) && endpoint) {
    window.untitledAnalytics = new Analytics({
      publishableKey,
      writeKey,
      endpoint,
      crossSubdomainCookies: script?.dataset.crossSubdomain !== 'false',
      requireConsent: script?.dataset.requireConsent === 'true',
      // data-app-platform, data-app-storefront, data-app-version, data-app-build, data-app-engine
      app: appInfoFromDataset(script?.dataset ?? {}) as AnalyticsOptions['app'],
    });
  }
}
