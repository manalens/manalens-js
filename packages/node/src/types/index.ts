// Type definitions for the Untitled Analytics Node SDK.

/** `server`: a backend with the secret key. `app`: the Electron main process or a process on the player's machine, with the publishable key. */
export type Mode = 'server' | 'app';

/** A property or trait value the collector accepts. Strings up to 1024 characters; numbers must be finite. */
export type PropertyValue = string | number | boolean | null;
export type Properties = Record<string, PropertyValue>;

// Keep these lists equal to packages/shared/src/app-context.ts (a unit test checks it).
export const APP_PLATFORMS = ['windows', 'macos', 'linux', 'web', 'android', 'ios', 'other'] as const;
export const APP_STOREFRONTS = ['steam', 'itch', 'epic', 'gog', 'app_store', 'play', 'other'] as const;
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

export type Logger = (message: string) => void;

export interface AnalyticsOptions {
  /** Collector URL without `/v0/events`, for example `https://collect.example.com`. */
  endpoint: string;
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
  /** Retries after the first attempt. Default 3. */
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
  type: 'track' | 'identify';
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
