import type { acquisitionKeys } from './attribution-contract';
export type Traits = Record<string, string | number | boolean | null>;

/** The browser portion of Formo's event envelope. */
export interface AnalyticsEvent {
  type: 'page' | 'track' | 'identify' | 'web_vitals';
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
  /** Persistent first-party browser ID (UUID). */
  anonymous_id: string;
  /** Client session ID (UUID); rotates after 30 minutes without events. */
  session_id: string;
  /** Set by identify() and attached to every later event until reset(). */
  user_id?: string;
  /** identify events only. */
  traits?: Traits;
}

export interface AnalyticsOptions {
  /** Public write key for one site. The server resolves this to project_id. */
  writeKey: string;
  endpoint: string;
  /**
   * Scope identity cookies to the apex domain (`.example.com`) so subdomains
   * such as app.example.com and example.com share one anonymous ID. Default false
   * (host-only cookies).
   */
  crossSubdomainCookies?: boolean;
  autoPageviews?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Suppress events and all browser storage access when true. */
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
