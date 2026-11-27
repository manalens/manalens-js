// Type definitions for the Manalens Node SDK.

/** `server`: a backend with the secret key. `app`: the Electron main process or a process on the player's machine, with the publishable key. */
export type Mode = 'server' | 'app';

/** A property or trait value the collector accepts. Strings up to 1024 characters; numbers must be finite. An object has at most 50 keys of 1 to 100 characters and at most 8 KB of JSON. */
export type PropertyValue = string | number | boolean | null;
export type Properties = Record<string, PropertyValue>;

// Keep these lists equal to the collector's (the contract test checks it).
export const APP_PLATFORMS = ['windows', 'macos', 'linux', 'web', 'android', 'ios', 'ps5', 'xbox_series', 'xbox_one', 'switch', 'switch2', 'other'] as const;
export const APP_STOREFRONTS = ['steam', 'itch', 'epic', 'gog', 'app_store', 'play', 'psn', 'xbox', 'nintendo', 'other'] as const;
export const APP_ENGINES = ['godot', 'unity', 'unreal', 'other'] as const;
export const DEVICES = ['desktop', 'mobile', 'tablet'] as const;
export const OSES = ['windows', 'macos', 'ios', 'android', 'linux', 'other'] as const;
export const BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'opera', 'other'] as const;

/** `context.app`: the build that sent the event. */
export interface AppInfo {
  platform: (typeof APP_PLATFORMS)[number];
  storefront?: (typeof APP_STOREFRONTS)[number];
  /** Printable label, up to 32 characters, for example `1.4.0-beta.2`. */
  app_version?: string;
  /** Printable label, up to 64 characters, for example `571`. */
  build?: string;
  engine?: (typeof APP_ENGINES)[number];
}

/**
 * Per-call context for server mode. Send the player's IP and user agent from
 * the incoming request: the collector uses them for country and device and
 * never stores the IP.
 */
export interface ServerContext {
  ip?: string;
  userAgent?: string;
  /** ISO 3166-1 alpha-2 code, for example `SG`. */
  country?: string;
  locale?: string;
  device?: (typeof DEVICES)[number];
  os?: (typeof OSES)[number];
  browser?: (typeof BROWSERS)[number];
  page?: { path?: string; title?: string; url?: string };
  /** Overrides the `app` option for this event. */
  app?: AppInfo;
}

/** Per-call context for app mode. */
export interface AppContext {
  locale?: string;
  /** Overrides the `app` option for this event. */
  app?: AppInfo;
}

interface BaseCall {
  userId?: string;
  /** UUID. App mode uses the `anonymousId` option when this is not set. */
  anonymousId?: string;
  sessionId?: string;
  /** When the event happened. Default: now. */
  timestamp?: Date | string;
  /** UUID. The SDK makes one when this is not set. */
  messageId?: string;
  context?: ServerContext | AppContext;
}

export interface TrackCall extends BaseCall {
  /** Event name, 1 to 128 characters. */
  event: string;
  properties?: Properties;
}

export interface IdentifyCall extends BaseCall {
  /** Required: your user ID, 1 to 255 characters. */
  userId: string;
  traits?: Properties;
}

/**
 * A `traits` event (P-2814): traits of a player with or without a user ID.
 * Without `userId`, they belong to the anonymous ID (one game install or
 * browser). Server mode needs `userId` or `anonymousId`.
 */
export interface TraitsCall extends BaseCall {
  /** Required: 1 to 50 keys. A `null` value clears a trait. */
  traits: Properties;
}

/** link(): a Steam ticket from `GetAuthTicketForWebApi("manalens")` (P-2815). */
export interface LinkCall {
  provider: 'steam';
  /** The ticket bytes as hex (Buffer or Uint8Array also work): 32 to 4096 hex characters, an even number. */
  ticket: string | Uint8Array;
  /** The anonymous ID of the game install that made the ticket. Required in server mode; app mode uses its own by default. */
  anonymousId?: string;
  /** Server mode only: your user ID, 1 to 255 characters. App mode never sends it (the API ignores it with the publishable key). */
  userId?: string;
}

/**
 * The result of link(). `linked` is true when Steam accepted the ticket.
 * `status` is the HTTP status (0 when the request failed). `code` is the API
 * error code, such as `STEAM_TICKET_INVALID`, or `NETWORK_ERROR` or `SHUT_DOWN`.
 */
export interface LinkResult {
  linked: boolean;
  status: number;
  code?: string;
}

export type Logger = (message: string) => void;

export interface AnalyticsOptions {
  /** Collector URL without `/v0/events`, for example `https://collect.example.com`. */
  endpoint: string;
  /**
   * API URL for link(). Default: the endpoint with an `events.` host changed
   * to `api.` (`https://events.manalens.dev` gives `https://api.manalens.dev`).
   * Any other endpoint is used as it is.
   */
  apiEndpoint?: string;
  /** Default `server`. */
  mode?: Mode;
  /** App info for every event. Required in app mode, optional in server mode. */
  app?: AppInfo;
  /** App mode: the player's persistent anonymous ID (UUID). Default: a new UUID for this process. */
  anonymousId?: string;
  /** App mode: the session ID. Default: a new UUID, renewed after 30 minutes without events. */
  sessionId?: string;
  /** App mode: `context.locale` on every event. */
  locale?: string;
  /** Send when the queue has this many events. Default 20, at most 100 (server) or 50 (app). */
  flushAt?: number;
  /** Send at least this often, in ms. Default 10000, from 1000 to 300000. */
  flushInterval?: number;
  /** Send when the queued JSON is larger than this many bytes. Default 500000. */
  maxQueueSize?: number;
  /** Drop new events when this many are waiting. Default 10000. */
  maxQueueLength?: number;
  /** Retries after the first attempt (network errors, 408, 429, 5xx). Default 3. A 413 is not counted: the batch is halved and sent again. */
  retryCount?: number;
  /** First retry delay in ms, doubled on each retry, with jitter. Default 1000. */
  retryDelay?: number;
  /** Request timeout in ms. Default 10000. */
  timeout?: number;
  /** Log dropped events and failed requests. Default false. */
  debug?: boolean;
  /** Where debug messages go. Default console.warn. */
  logger?: Logger;
  /** For tests or a custom HTTP client. Default globalThis.fetch. */
  fetch?: typeof fetch;
}

/** The event envelope sent to `POST /v0/events`. */
export interface WireEvent {
  type: 'track' | 'identify' | 'traits';
  channel: 'server' | 'app';
  message_id: string;
  original_timestamp: string;
  event?: string;
  version?: string;
  properties?: Properties;
  traits?: Properties;
  user_id?: string;
  anonymous_id?: string;
  session_id?: string;
  context?: Record<string, unknown>;
}
