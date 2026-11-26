import { Analytics } from './index';
import { appInfoFromDataset } from './app';
import type { AnalyticsOptions } from './types';

declare global {
  interface Window { manalens?: Analytics; }
}

if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null;
  const publishableKey = script?.dataset.publishableKey;
  const endpoint = script?.dataset.endpoint;
  if (publishableKey && endpoint) {
    window.manalens = new Analytics({
      publishableKey,
      endpoint,
      // data-api-endpoint: the API base URL of link(), when it is not the endpoint with events. changed to api.
      ...(script?.dataset.apiEndpoint ? { apiEndpoint: script.dataset.apiEndpoint } : {}),
      crossSubdomainCookies: script?.dataset.crossSubdomain !== 'false',
      requireConsent: script?.dataset.requireConsent === 'true',
      // data-auto-pageviews="false": no automatic page views; call page() yourself.
      autoPageviews: script?.dataset.autoPageviews !== 'false',
      // data-debug="true": console logs at every level.
      ...(script?.dataset.debug === 'true' ? { logger: { enabled: true } } : {}),
      // data-app-platform, data-app-storefront, data-app-version, data-app-build, data-app-engine
      app: appInfoFromDataset(script?.dataset ?? {}) as AnalyticsOptions['app'],
    });
    // The snippet form of the ready option: listen on window for this event.
    if (typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('manalens:ready', { detail: window.manalens }));
  }
}
