import type { TrackingOptions } from './tracking';
import type { acquisitionKeys } from './attribution-contract';
import type { AppInfo } from './app';
import type { LoggerOptions } from './logger';
export type Traits = Record<string, string | number | boolean | null>;

/** The browser portion of Formo's event envelope. */
export interface AnalyticsEvent {
  type: 'page' | 'track' | 'identify' | 'traits';
  event?: string;
  message_id: string;
  /**
   * `web` on an http(s) page. `app` on an installed-app page (`app://`,
   * `file://`, a Tauri or Capacitor scheme) with a valid `app` option: then
   * the context has no page, referrer or campaign fields.
   */
  channel: 'web' | 'app';
  version: string;
  original_timestamp: string;
  context: Partial<Record<(typeof acquisitionKeys)[number], string>> & {
    /** Web events only (channel `web`). */
    page?: { path: string; title: string; url: string };
    /** Web events only (channel `web`). */
    referrer?: string;
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
  /** identify and traits events only. */
  traits?: Traits;
}

export interface AnalyticsOptions {
  /**
   * The project publishable key (`mana_pk_...`). It is public and safe in a
   * page or a game build. The server resolves it to the project. Any other
   * value, such as a secret key (`mana_sk_`) or an API key (`mana_api_`), is
   * refused: never put those in browser code. Required.
   */
  publishableKey: string;
  endpoint: string;
  /**
   * The Manalens API base URL for link(). Default: the endpoint with an
   * `events.` host changed to `api.` (`https://events.manalens.dev` gives
   * `https://api.manalens.dev`); any other endpoint (a proxy or a local
   * collector) is used as it is.
   */
  apiEndpoint?: string;
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
   * path changes, back and forward, and the `manalens:navigate` event). Set false
   * and call page() yourself, for example on a router's page-load event.
   * App events (an installed-app page with the `app` option) have no page
   * views: this option and page() send nothing there.
   */
  autoPageviews?: boolean;
  /** Events per request, default 30, from 1 to 50 (the collector takes at most 50). A full batch sends at once, except during a backoff wait after a failed send. */
  batchSize?: number;
  /**
   * Send the queue every this many milliseconds, default 15000. The page
   * hiding or closing sends at once with keepalive requests, at most 60000
   * bytes (UTF-8) of request bodies in flight together, as browsers refuse
   * keepalive bodies over 64 KiB. Events that do not fit stay queued (and
   * stored with persistQueue) for the next send.
   */
  flushIntervalMs?: number;
  /**
   * How many times a batch is sent again after a server error (408, 429 or
   * 5xx), default 3, from 0 to 10. Network errors (offline) do not count: the
   * events wait in memory until the network is back. A 413 (batch too large)
   * is not counted: the SDK halves the batch and sends again. Other 4xx
   * responses are not retried.
   */
  retryCount?: number;
  /** Queue limit in bytes (serialized events), default and maximum 500 KiB (512000 bytes), minimum 200 bytes. The oldest events are dropped first. */
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
   * (a 4xx other than 408, 413 and 429, or a 413 for a single event), or a
   * server error (408, 429, 5xx) repeated
   * more than retryCount times. Network errors (offline) do not call it: those
   * events wait in memory. An error thrown in it is caught.
   */
  errorHandler?: (error: Error) => void;
  /**
   * App context for a browser or Electron game, sent as `context.app` on every
   * event. On an http(s) page it goes next to `context.page` and the channel
   * stays `web`. On an installed-app page (`app://`, `file://`, a Tauri or
   * Capacitor scheme) the events are app events: channel `app`, no
   * `context.page`, no page views, and `sent_at` in each request. It feeds
   * the App filters and breakdowns (platform, storefront, version, build,
   * engine). An invalid object is dropped with a console warning.
   */
  app?: AppInfo;
  /**
   * Game mode for a browser or Electron game, default false. Needs a valid
   * `app` option: without one, game mode is off and a console warning says
   * why. The SDK then sends `game_open` on each start, `session_start` and
   * `session_end` (with `duration_s`), and an `error` event for each uncaught
   * error and unhandled promise rejection. Websites leave it off. The session
   * ends on `pagehide`; an Electron game calls `await analytics.shutdown()`
   * before it quits.
   */
  game?: boolean;
  /**
   * Keep unsent events in browser storage (IndexedDB, else localStorage) and
   * send them on the next load: at most 1000 events, none older than 7 days.
   * Only with a valid `app` option. Default true in game mode, else false.
   * Nothing is written before consent in consent mode, and optOut() or
   * setConsent(false) deletes the stored events. Events that shutdown() could
   * not send in its time stay stored.
   */
  persistQueue?: boolean;
  /**
   * Game mode: a main thread blocked for this many milliseconds is a hang,
   * sent as an `error` with `error_type` `game_hang` and `hang_duration_s` (seconds),
   * when the thread runs again. Default 5000; 0 turns hang detection off;
   * other values are kept between 1000 and 60000. No hang is reported while
   * the page is hidden or just after it becomes visible.
   */
  hangThresholdMs?: number;
}

/** The request of link(): a Steam ticket from `GetAuthTicketForWebApi("manalens")`, as hex. */
export interface LinkRequest {
  provider: 'steam';
  /** The bytes of the ticket as a hex string: 32 to 4096 hex characters, an even number. */
  ticket: string;
}

/**
 * The result of link(). `linked` is true when Steam accepted the ticket.
 * `status` is the HTTP status (0 when nothing was sent or the network
 * failed). `code` is the error code of the API, such as
 * `STEAM_TICKET_INVALID` or `STEAM_NOT_CONNECTED`, or a code of the SDK:
 * `DISABLED`, `CONSENT_REQUIRED`, `EXCLUDED`, `NETWORK_ERROR`, or
 * `IDENTITY_CHANGED` (reset() or a consent change during a Retry-After wait).
 */
export interface LinkResult {
  linked: boolean;
  status: number;
  code?: string;
}
