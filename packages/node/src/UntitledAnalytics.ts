import { EventQueue } from './queue/index.js';
import { ValidationError, checkApp, isUUID, validateAppEvent, validateServerEvent } from './validators/index.js';
import { compact, eventsUrl, isoTimestamp, randomUUID } from './utils/index.js';
import { apiKeyPrefix, isWellFormedKey, legacyApiKeyPrefix, publishableKeyPrefix, secretKeyPrefix } from './utils/keys.js';
import type { AnalyticsOptions, AppContext, AppInfo, IdentifyCall, Logger, Mode, ServerContext, TrackCall, WireEvent } from './types/index.js';

/** Keep equal to package.json `version` (a unit test checks it). */
export const SDK_VERSION = '0.1.0';
export const LIBRARY_NAME = '@untitled-analytics/node';
const SESSION_TIMEOUT_MS = 30 * 60_000;
/** Collector batch limits on `POST /v0/events`. */
const MAX_BATCH: Record<Mode, number> = { server: 100, app: 50 };

/**
 * Check the key against the mode (rules of packages/shared/src/keys.ts).
 * Throws on a wrong key: a secret key must never be used in app mode, and
 * server mode accepts only a well-formed secret key.
 */
export function checkKey(key: unknown, mode: Mode): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) throw new Error('key is required');
  if (key.startsWith(apiKeyPrefix) || key.startsWith(legacyApiKeyPrefix)) throw new Error('This is an API key: it reads and manages data and cannot send events. Use the secret key (ua_sk_) in server mode or the publishable key (ua_pk_) in app mode');
  if (mode === 'app') {
    if (key.startsWith(secretKeyPrefix)) throw new Error('A secret key (ua_sk_) is not allowed in app mode. Never ship the secret key in a game build, a page or an Electron app. Use the publishable key (ua_pk_)');
    if (key.startsWith(publishableKeyPrefix) && !isWellFormedKey(key)) throw new Error('The publishable key is malformed (wrong length or checksum)');
    if (!isWellFormedKey(key)) throw new Error('app mode needs the project publishable key (ua_pk_...)');
  } else {
    if (key.startsWith(secretKeyPrefix)) {
      if (!isWellFormedKey(key)) throw new Error('The secret key is malformed (wrong length or checksum)');
      return;
    }
    if (key.startsWith('ua_')) throw new Error('server mode needs the secret key (ua_sk_...). The publishable key only sends app and web events: use mode "app" in the Electron main process');
    throw new Error('server mode needs the secret key (ua_sk_...)');
  }
}

/**
 * Untitled Analytics for Node.js.
 *
 * - `server` mode (default): a backend or a dedicated game server sends
 *   `channel: 'server'` events with the secret key (`ua_sk_`).
 * - `app` mode: the Electron main process, or a process on the player's
 *   machine, sends `channel: 'app'` events with `context.app` and the
 *   publishable key (`ua_pk_`, or a legacy `ua_` key).
 *
 * Events are batched. `track()` and `identify()` never throw for a bad event:
 * the SDK drops it and writes a debug log. Call `shutdown()` before the
 * process exits.
 *
 * @example
 * ```ts
 * const analytics = new UntitledAnalytics(process.env.UA_SECRET_KEY!, { endpoint: 'https://collect.example.com' });
 * analytics.track({ event: 'match_won', userId: 'player_1', properties: { map: 'harbor' }, context: { ip: req.ip } });
 * await analytics.shutdown();
 * ```
 */
export class UntitledAnalytics {
  readonly mode: Mode;
  private readonly queue: EventQueue;
  private readonly log: (message: string) => void;
  private readonly app?: AppInfo;
  private readonly locale?: string;
  private anonymousId?: string;
  private sessionId?: string;
  private lastEventAt = 0;
  private fixedSession: boolean;
  private closed = false;

  constructor(key: string, options: AnalyticsOptions) {
    if (!options || typeof options !== 'object') throw new Error('options with endpoint are required');
    const mode: Mode = options.mode ?? 'server';
    if (mode !== 'server' && mode !== 'app') throw new Error('mode must be "server" or "app"');
    checkKey(key, mode);
    this.mode = mode;
    const logger: Logger = options.logger ?? (message => console.warn(message));
    this.log = options.debug ? message => logger(`[untitled-analytics] ${message}`) : () => {};

    if (options.app !== undefined) {
      try { checkApp(options.app, 'app'); } catch (error) { throw new Error((error as Error).message); }
      this.app = { ...options.app };
    }
    if (mode === 'app') {
      if (!this.app) throw new Error('app mode needs the app option, for example { platform: "windows" }');
      if (options.anonymousId !== undefined && !isUUID(options.anonymousId)) throw new Error('anonymousId must be a UUID');
      this.anonymousId = options.anonymousId ?? randomUUID();
      this.locale = options.locale;
    }
    this.sessionId = options.sessionId;
    this.fixedSession = options.sessionId !== undefined;

    this.queue = new EventQueue({
      url: eventsUrl(options.endpoint),
      headers: mode === 'server'
        ? { authorization: `Bearer ${key}`, 'user-agent': `untitled-analytics-node/${SDK_VERSION}` }
        : { 'x-publishable-key': key, 'user-agent': `untitled-analytics-node/${SDK_VERSION}` },
      maxBatch: MAX_BATCH[mode],
      flushAt: options.flushAt,
      flushInterval: options.flushInterval,
      maxQueueSize: options.maxQueueSize,
      maxQueueLength: options.maxQueueLength,
      retryCount: options.retryCount,
      retryDelay: options.retryDelay,
      timeout: options.timeout,
      fetch: options.fetch,
      log: this.log,
    });
  }

  /** Send a named event. Drops the event (debug log) when it is invalid. */
  track(call: TrackCall): void {
    this.enqueue('track', call);
  }

  /** Link a user ID to traits (and, with anonymousId, to that device). Drops the event when it is invalid. */
  identify(call: IdentifyCall): void {
    this.enqueue('identify', call);
  }

  /** App mode: the anonymous ID on events that do not set one. */
  getAnonymousId(): string | undefined {
    return this.anonymousId;
  }

  /** App mode: the current session ID. */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Send every queued event now. Never rejects. */
  flush(): Promise<void> {
    return this.queue.flush();
  }

  /**
   * Send every queued event, for at most `timeoutMs` (default 5000), then
   * stop the timers. Later track() and identify() calls are dropped.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); });
    await Promise.race([this.queue.flush(), timeout]);
    clearTimeout(timer);
    if (this.queue.length > 0) this.log(`shutdown: ${this.queue.length} events not sent`);
    this.queue.stop();
  }

  private enqueue(type: 'track' | 'identify', call: TrackCall | IdentifyCall): void {
    if (this.closed) { this.log(`dropped ${type}: the client is shut down`); return; }
    try {
      const event = this.build(type, call);
      if (this.mode === 'server') validateServerEvent(event);
      else validateAppEvent(event);
      this.queue.enqueue(event);
    } catch (error) {
      if (error instanceof ValidationError) { this.log(`dropped ${type}: ${error.message}`); return; }
      this.log(`dropped ${type}: ${(error as Error).message}`);
    }
  }

  private build(type: 'track' | 'identify', call: TrackCall | IdentifyCall): WireEvent {
    if (!call || typeof call !== 'object') throw new ValidationError(type, 'needs an object argument');
    const now = Date.now();
    const timestamp = isoTimestamp(call.timestamp, now);
    if (timestamp === null) throw new ValidationError('timestamp', 'must be a date');
    const base: WireEvent = {
      type,
      channel: this.mode,
      message_id: call.messageId ?? randomUUID(),
      original_timestamp: timestamp,
      ...(type === 'track' ? { event: (call as TrackCall).event } : {}),
      user_id: call.userId,
      ...(type === 'track'
        ? { properties: (call as TrackCall).properties }
        : { traits: (call as IdentifyCall).traits }),
    };
    if (this.mode === 'server') {
      const context = (call.context ?? {}) as ServerContext;
      const app = context.app ?? this.app;
      const wireContext = compact({
        ip: context.ip,
        user_agent: context.userAgent,
        country: context.country,
        locale: context.locale,
        device: context.device,
        os: context.os,
        browser: context.browser,
        page: context.page,
        app,
        library_name: LIBRARY_NAME,
        library_version: SDK_VERSION,
      });
      return compact({
        ...base,
        anonymous_id: call.anonymousId,
        session_id: call.sessionId,
        context: wireContext,
      });
    }
    const context = (call.context ?? {}) as AppContext;
    return compact({
      ...base,
      version: SDK_VERSION,
      anonymous_id: call.anonymousId ?? this.anonymousId,
      session_id: call.sessionId ?? this.session(now),
      context: compact({
        app: context.app ?? this.app,
        locale: context.locale ?? this.locale,
        library_name: LIBRARY_NAME,
        library_version: SDK_VERSION,
      }),
    });
  }

  /** App mode session: a new UUID after 30 minutes without events, unless the sessionId option fixed it. */
  private session(now: number): string {
    if (!this.fixedSession && (!this.sessionId || now - this.lastEventAt > SESSION_TIMEOUT_MS)) this.sessionId = randomUUID();
    this.lastEventAt = now;
    return this.sessionId!;
  }
}
