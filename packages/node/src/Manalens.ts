import { EventQueue } from './queue/index.js';
import { ValidationError, checkApp, isUUID, validateAppEvent, validateServerEvent } from './validators/index.js';
import { compact, eventsUrl, isoTimestamp, linkUrl, randomUUID } from './utils/index.js';
import { apiKeyPrefix, isWellFormedKey, publishableKeyPrefix, secretKeyPrefix } from './utils/keys.js';
import type { AnalyticsOptions, AppContext, AppInfo, IdentifyCall, LinkCall, LinkResult, Logger, Mode, ServerContext, TraitsCall, TrackCall, WireEvent } from './types/index.js';

/** Keep equal to package.json `version` (a unit test checks it). */
export const SDK_VERSION = '0.2.0';
export const LIBRARY_NAME = '@manalens/node';
const SESSION_TIMEOUT_MS = 30 * 60_000;
/** A session is never older than this: the collector's session rule does not use a client session of more than 24 hours. */
const SESSION_MAX_AGE_MS = 24 * 60 * 60_000;
/** Collector batch limits on `POST /v0/events`. */
const MAX_BATCH: Record<Mode, number> = { server: 100, app: 50 };
/**
 * Protected traits (P-2814): only the secret key may set them. The collector
 * drops them from app events, so app mode does not send them.
 */
export const PROTECTED_TRAITS: readonly string[] = ['email', 'itch_user_id', 'stripe_customer_id', 'paddle_customer_id'];
/** A Steam ticket for link(): hex, 32 to 4096 characters, an even number. */
const STEAM_TICKET = /^(?:[0-9a-fA-F]{2}){16,2048}$/;
/** link() waits for a 429 Retry-After of at most this many seconds, once. */
const LINK_MAX_RETRY_AFTER_S = 60;

/**
 * Check the key against the mode (the collector's key rules, see utils/keys.ts).
 * Throws on a wrong key: a secret key must never be used in app mode, and
 * server mode accepts only a well-formed secret key.
 */
export function checkKey(key: unknown, mode: Mode): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) throw new Error('key is required');
  if (key.startsWith(apiKeyPrefix)) throw new Error('This is an API key: it reads and manages data and cannot send events. Use the secret key (mana_sk_) in server mode or the publishable key (mana_pk_) in app mode');
  if (mode === 'app') {
    if (key.startsWith(secretKeyPrefix)) throw new Error('A secret key (mana_sk_) is not allowed in app mode. Never ship the secret key in a game build, a page or an Electron app. Use the publishable key (mana_pk_)');
    if (key.startsWith(publishableKeyPrefix) && !isWellFormedKey(key)) throw new Error('The publishable key is malformed (wrong length or checksum)');
    if (!key.startsWith(publishableKeyPrefix)) throw new Error('app mode needs the project publishable key (mana_pk_...)');
  } else {
    if (key.startsWith(secretKeyPrefix)) {
      if (!isWellFormedKey(key)) throw new Error('The secret key is malformed (wrong length or checksum)');
      return;
    }
    if (key.startsWith(publishableKeyPrefix)) throw new Error('server mode needs the secret key (mana_sk_...). The publishable key only sends app and web events: use mode "app" in the Electron main process');
    throw new Error('server mode needs the secret key (mana_sk_...)');
  }
}

/**
 * Manalens for Node.js.
 *
 * - `server` mode (default): a backend or a dedicated game server sends
 *   `channel: 'server'` events with the secret key (`mana_sk_`).
 * - `app` mode: the Electron main process, or a process on the player's
 *   machine, sends `channel: 'app'` events with `context.app` and the
 *   publishable key (`mana_pk_`).
 *
 * Events are batched. `track()` and `identify()` never throw for a bad event:
 * the SDK drops it and writes a debug log. Call `shutdown()` before the
 * process exits.
 *
 * @example
 * ```ts
 * const analytics = new Manalens(process.env.MANALENS_SECRET_KEY!, { endpoint: 'https://collect.example.com' });
 * analytics.track({ event: 'match_won', userId: 'player_1', properties: { map: 'harbor' }, context: { ip: req.ip } });
 * await analytics.shutdown();
 * ```
 */
export class Manalens {
  readonly mode: Mode;
  private readonly queue: EventQueue;
  private readonly log: (message: string) => void;
  private readonly app?: AppInfo;
  private readonly locale?: string;
  private anonymousId?: string;
  private sessionId?: string;
  private lastEventAt = 0;
  private sessionStartedAt = 0;
  private fixedSession: boolean;
  private closed = false;
  private readonly key: string;
  private readonly linkUrl: string;
  private readonly fetcher?: typeof fetch;
  private readonly timeout: number;
  private readonly warn: Logger;
  private warnedProtectedTraits = false;

  constructor(key: string, options: AnalyticsOptions) {
    if (!options || typeof options !== 'object') throw new Error('options with endpoint are required');
    const mode: Mode = options.mode ?? 'server';
    if (mode !== 'server' && mode !== 'app') throw new Error('mode must be "server" or "app"');
    checkKey(key, mode);
    this.mode = mode;
    this.key = key;
    this.linkUrl = linkUrl(options.endpoint, options.apiEndpoint);
    this.fetcher = options.fetch;
    this.timeout = options.timeout ?? 10_000;
    const logger: Logger = options.logger ?? (message => console.warn(message));
    this.warn = message => logger(`[manalens] ${message}`);
    this.log = options.debug ? message => logger(`[manalens] ${message}`) : () => {};

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
        ? { authorization: `Bearer ${key}`, 'user-agent': `manalens-node/${SDK_VERSION}` }
        : { 'x-publishable-key': key, 'user-agent': `manalens-node/${SDK_VERSION}` },
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

  /**
   * Set traits on a player, with or without a user ID (P-2814). Without
   * `userId`, the traits belong to the anonymous ID. Server mode can set the
   * protected traits (`email`, `itch_user_id`, `stripe_customer_id`,
   * `paddle_customer_id`); app mode drops them with one warning, because the
   * collector drops them from app events. Drops the event when it is invalid.
   */
  traits(call: TraitsCall): void {
    if (this.mode === 'app' && call && typeof call === 'object' && call.traits && typeof call.traits === 'object') {
      const dropped = Object.keys(call.traits).filter(key => PROTECTED_TRAITS.includes(key));
      if (dropped.length) {
        if (!this.warnedProtectedTraits) { this.warnedProtectedTraits = true; this.warn(`traits: ${dropped.join(', ')} not sent. In app mode the collector drops protected traits: set them in server mode with the secret key`); }
        const traits = Object.fromEntries(Object.entries(call.traits).filter(([key]) => !PROTECTED_TRAITS.includes(key)));
        if (!Object.keys(traits).length) { this.log('dropped traits: only protected traits'); return; }
        call = { ...call, traits };
      }
    }
    this.enqueue('traits', call);
  }

  /**
   * Link the Steam account of a player with a Steam ticket (P-2815). The game
   * makes the ticket with `GetAuthTicketForWebApi("manalens")`. Posts once to
   * `<apiEndpoint>/v0/link`: a refusal (4xx, 5xx) is not sent again; a 429
   * with Retry-After (at most 60 s) is tried once more. Server mode sends the
   * secret key and may send `userId`; app mode sends the publishable key and
   * its anonymous ID. Throws for a bad call; never throws for an HTTP or
   * network error: read the result.
   */
  async link(call: LinkCall): Promise<LinkResult> {
    if (!call || typeof call !== 'object' || call.provider !== 'steam') throw new Error("link: provider must be 'steam'");
    const ticket = typeof call.ticket === 'string' ? call.ticket : call.ticket instanceof Uint8Array ? Buffer.from(call.ticket).toString('hex') : '';
    if (!STEAM_TICKET.test(ticket)) throw new Error('link: ticket must be hex, 32 to 4096 characters, an even number');
    const anonymousId = call.anonymousId ?? this.anonymousId;
    if (anonymousId === undefined) throw new Error('link: anonymousId is required in server mode');
    if (!isUUID(anonymousId)) throw new Error('link: anonymousId must be a UUID');
    if (call.userId !== undefined && (typeof call.userId !== 'string' || call.userId.length < 1 || call.userId.length > 255)) throw new Error('link: userId must be 1 to 255 characters');
    if (this.closed) return { linked: false, status: 0, code: 'SHUT_DOWN' };
    const fetcher = this.fetcher ?? globalThis.fetch;
    const body = JSON.stringify(compact({ provider: 'steam', ticket, anonymous_id: anonymousId, user_id: this.mode === 'server' ? call.userId : undefined }));
    const headers: Record<string, string> = this.mode === 'server'
      ? { 'content-type': 'application/json', authorization: `Bearer ${this.key}`, 'user-agent': `manalens-node/${SDK_VERSION}` }
      : { 'content-type': 'application/json', 'x-publishable-key': this.key, 'user-agent': `manalens-node/${SDK_VERSION}` };
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetcher(this.linkUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeout) });
      } catch (error) {
        this.log(`link: request failed: ${(error as Error).message}`);
        return { linked: false, status: 0, code: 'NETWORK_ERROR' };
      }
      if (response.ok) return { linked: true, status: response.status };
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      if (response.status === 429 && attempt === 0 && Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= LINK_MAX_RETRY_AFTER_S) {
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        if (this.closed) return { linked: false, status: 0, code: 'SHUT_DOWN' };
        continue;
      }
      let code: string | undefined;
      try {
        const parsed = JSON.parse(await response.text()) as { error?: { code?: unknown } };
        if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
      } catch { /* no JSON body */ }
      this.log(`link: HTTP ${response.status}${code ? ` ${code}` : ''}`);
      return { linked: false, status: response.status, ...(code ? { code } : {}) };
    }
  }

  /** App mode: the anonymous ID on events that do not set one. */
  getAnonymousId(): string | undefined {
    return this.anonymousId;
  }

  /**
   * App mode: the current session ID. Before the first event, after 30
   * minutes without events, or when the session is 24 hours old, this starts
   * a new session, so the value always matches the session_id of the next
   * event. Send it with the server events of the same player (`sessionId` on
   * a server mode call). Server mode: undefined.
   */
  getSessionId(): string | undefined {
    if (this.mode !== 'app') return this.sessionId;
    const now = Date.now();
    if (this.sessionEnded(now)) { this.startSession(now); this.lastEventAt = now; }
    return this.sessionId;
  }

  /** Send every queued event now. Never rejects. */
  flush(): Promise<void> {
    return this.queue.flush();
  }

  /**
   * Send every queued event, for at most `timeoutMs` (default 5000), then
   * stop the timers. Later track(), identify() and traits() calls are dropped.
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

  private enqueue(type: 'track' | 'identify' | 'traits', call: TrackCall | IdentifyCall | TraitsCall): void {
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

  private build(type: 'track' | 'identify' | 'traits', call: TrackCall | IdentifyCall | TraitsCall): WireEvent {
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
        : { traits: (call as IdentifyCall | TraitsCall).traits }),
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

  /**
   * App mode session: a new UUID after 30 minutes without events or 24 hours
   * after the session started, unless the sessionId option fixed it.
   */
  private session(now: number): string {
    if (this.sessionEnded(now)) this.startSession(now);
    this.lastEventAt = now;
    return this.sessionId!;
  }

  private sessionEnded(now: number): boolean {
    if (this.fixedSession) return false;
    return !this.sessionId || now - this.lastEventAt > SESSION_TIMEOUT_MS || now - this.sessionStartedAt >= SESSION_MAX_AGE_MS;
  }

  private startSession(now: number): void {
    if (this.sessionId) this.log('session rotated (30 minutes without events, or 24 hours old)');
    this.sessionId = randomUUID();
    this.sessionStartedAt = now;
  }
}
