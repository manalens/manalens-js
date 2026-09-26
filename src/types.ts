/** The browser portion of Formo's event envelope. Identity is server-derived. */
export interface AnalyticsEvent {
  type: 'page' | 'track';
  event?: string;
  message_id: string;
  channel: 'web';
  version: string;
  original_timestamp: string;
  context: {
    page: { path: string; title: string; url: string };
    referrer: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
    locale?: string;
  };
  properties: Record<string, string | number | boolean | null>;
}

export interface AnalyticsOptions {
  /** Public write key for one site. The server resolves this to project_id. */
  writeKey: string;
  endpoint: string;
  autoPageviews?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Suppress events, including queued events, when true. */
  disabled?: boolean;
}
