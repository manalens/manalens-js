import type { TrackingOptions } from './tracking';
import type { acquisitionKeys } from './attribution-contract';
export type Traits = Record<string, string | number | boolean | null>;

/** The browser portion of Formo's event envelope. */
export interface AnalyticsEvent {
  type: 'page' | 'track' | 'identify';
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
    /** Formo-style SDK identification. */
    library_name?: string;
    library_version?: string;
  };
  properties: Record<string, string | number | boolean | null>;
  /** Persistent first-party browser ID (UUID). Absent only in consent mode before consent. */
  anonymous_id?: string;
  /** Client session ID (UUID); rotates after 30 minutes without events. Absent like anonymous_id. */
  session_id?: string;
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
   * such as app.example.com and example.com share one anonymous ID. Default true,
   * like Formo. Set false for host-only cookies.
   */
  crossSubdomainCookies?: boolean;
  /**
   * Consent mode, default false. When true, no cookie or localStorage is read
   * or written, and events carry no anonymous_id / session_id / user_id, until
   * setConsent(true). For sites behind a consent banner (e.g. EU visitors).
   */
  requireConsent?: boolean;
  autoPageviews?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  /**
   * How many times a batch is sent again after a server error (408, 429 or
   * 5xx), default 3, from 0 to 10. Network errors (offline) do not count: the
   * events wait in memory until the network is back. Other 4xx responses are
   * not retried.
   */
  retryCount?: number;
  /** Queue limit in bytes (serialized events), default and maximum 500 KB, minimum 200. The oldest events are dropped first. */
  maxQueueSize?: number;
  /** Hosts, paths and timezones where nothing is sent. See TrackingOptions. */
  tracking?: TrackingOptions;
  /** Suppress events and all browser storage access when true. */
  disabled?: boolean;
}
