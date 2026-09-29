import type { acquisitionKeys } from './attribution-contract';
/** The browser portion of Formo's event envelope. Anonymous identity is server-derived. */
export interface AnalyticsEvent {
  type: 'page' | 'track' | 'web_vitals';
  event?: string;
  message_id: string;
  channel: 'web';
  version: string;
  original_timestamp: string;
  context: Partial<Record<(typeof acquisitionKeys)[number], string>> & {
    page: { path: string; title: string; url: string };
    referrer: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
    ref?: string;
    paid_source?: string;
    click_id?: string;
    locale?: string;
  };
  properties: Record<string, string | number | boolean | null>;
  user_id?: string;
  anonymous_id?: string;
  attribution_consent?: boolean;
}

export interface AnalyticsOptions {
  /** Public write key for one site. The server resolves this to project_id. */
  writeKey: string;
  endpoint: string;
  /** Opt-in persistent identity. Also requires project enablement and consent. */
  attribution?: { consent: () => boolean };
  autoPageviews?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Suppress events, including queued events, when true. */
  disabled?: boolean;
  /** Optional web-vitals v5+ module. No performance code is loaded when omitted. */
  webVitals?: WebVitalsModule;
}

export interface WebVitalMetric {
  name: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
  value: number;
  navigationType?: string;
}

export type WebVitalCallback = (metric: WebVitalMetric) => void;
export type WebVitalRegistrar = (callback: WebVitalCallback, options?: { reportAllChanges?: boolean }) => void;
export interface WebVitalsModule {
  onLCP?: WebVitalRegistrar;
  onINP?: WebVitalRegistrar;
  onCLS?: WebVitalRegistrar;
  onFCP?: WebVitalRegistrar;
  onTTFB?: WebVitalRegistrar;
}
