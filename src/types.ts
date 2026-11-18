import type { TrackingOptions } from './tracking';
import type { acquisitionKeys } from './attribution-contract';
import type { AppInfo } from './app';
import type { LoggerOptions } from './logger';
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
    /** The clock's offset from UTC in minutes. For install matching only; not stored on events. */
    utc_offset?: number;
    /** Formo-style SDK identification. */
    library_name?: string;
    library_version?: string;
    /** Set from the `app` option on every event (browser and Electron games). */
    app?: AppInfo;
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
  /**
   * The project publishable key (`ua_pk_...`, or `ua_...` on older projects).
   * It is public and safe in a page or a game build. The server resolves it to
   * the project. A secret key (`ua_sk_`) or an API key (`ua_api_`, `ua_mcp_`)
   * is refused: never put those in browser code. Required (or the deprecated
   * `writeKey`).
   */
  publishableKey?: string;
  /**
   * @deprecated The old name of `publishableKey`; still accepted. Giving both
   * with different values throws an error.
   */
  writeKey?: string;
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
  /**
   * Send page views automatically, default true: the first page on load, and
   * each client-side navigation (history.pushState / replaceState when the
   * path changes, back and forward, and the `ua:navigate` event). Set false
   * and call page() yourself, for example on a router's page-load event.
   */
  autoPageviews?: boolean;
  /** Events per request, default 10. A full queue sends at once. */
  batchSize?: number;
  /** Send the queue every this many milliseconds, default 5000. */
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
  /**
   * Hosts, paths and timezones where nothing is sent, and query parameters
   * never read. See TrackingOptions. A boolean is a simple switch, like
   * Formo: `false` is the same as `disabled: true`; `true` tracks everywhere
   * (the default; localhost is tracked too).
   */
  tracking?: boolean | TrackingOptions;
  /** Suppress events and all browser storage access when true. */
  disabled?: boolean;
  /** Console logs, off by default. `{ enabled: true }` prints all levels. */
  logger?: LoggerOptions;
  /**
   * Called once at the end of the constructor with the instance, also when
   * the SDK is disabled. An error thrown in it is caught and logged.
   */
  ready?: (analytics: import('./index').Analytics) => void;
  /**
   * Called when events are dropped after a send: the collector refused them
   * (a 4xx other than 408 and 429), or a server error (408, 429, 5xx) repeated
   * more than retryCount times. Network errors (offline) do not call it: those
   * events wait in memory. An error thrown in it is caught.
   */
  errorHandler?: (error: Error) => void;
  /**
   * App context for a browser or Electron game, sent as `context.app` on every
   * event next to `context.page` (the channel stays `web`). It feeds the App
   * filters and breakdowns (platform, storefront, version, build, engine). An
   * invalid object is dropped with a console warning.
   */
  app?: AppInfo;
}
