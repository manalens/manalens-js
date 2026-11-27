import { pageContext } from './attribution';
import { acquisitionKeys } from './attribution-contract';
import { clearAnonymousId, clearSessionId, clearUserId, currentSessionId, generateAnonymousId, randomId, readOptOut, readSessionId, readUserId, touchSession, writeOptOut, writeUserId } from './identity';
import { readLocal, removeLocal, storageKey, writeLocal } from './storage';
import { cleanFile, cleanMessage, ErrorLimiter, errorProperties, firstFrame, type ErrorInput, type TrackErrorOptions } from './errors';
import { PersistentQueue } from './queue';
import { hostExcluded, pathExcluded, timezoneExcluded, type TrackingOptions } from './tracking';
import { Logger } from './logger';
import type { AnalyticsEvent, AnalyticsOptions, LinkRequest, LinkResult, Traits } from './types';
import { resolveAppInfo, type AppInfo } from './app';

/** Sent as context.library_name / library_version, like Formo's Web SDK. Keep in sync with package.json. */
export const LIBRARY_NAME = 'Manalens Web SDK';
export const LIBRARY_VERSION = '0.5.1';

export type { AnalyticsEvent, AnalyticsOptions, LinkRequest, LinkResult, Traits } from './types';
export type { TrackingOptions } from './tracking';
export type { LoggerOptions, LogLevel } from './logger';
export { logLevels } from './logger';
export type { AppInfo } from './app';
export { appPlatforms, appStorefronts, appEngines } from './app';
export type { TrackErrorOptions, ErrorSeverity } from './errors';
export { errorSeverities, errorFingerprint } from './errors';

/** The publishable key prefix; secret keys (`mana_sk_`) and API keys (`mana_api_`) never go in browser code. */
const PUBLISHABLE_KEY_PREFIX = 'mana_pk_';

/**
 * Protected traits (P-2814): only a server with the secret key may set them.
 * The collector drops them from web events, so traits() does not send them.
 */
export const PROTECTED_TRAITS: readonly string[] = ['email', 'itch_user_id', 'stripe_customer_id', 'paddle_customer_id'];
/** A Steam ticket for link(): hex, 32 to 4096 characters, an even number. */
const STEAM_TICKET = /^(?:[0-9a-fA-F]{2}){16,2048}$/;

/**
 * The API base URL of link(): the apiEndpoint option, or the endpoint with an
 * `events.` host changed to `api.`. Other endpoints (a proxy, a local
 * collector) serve both paths, so they are used as they are.
 */
function resolveApiEndpoint(options: Pick<AnalyticsOptions, 'endpoint' | 'apiEndpoint'>): string {
  if (options.apiEndpoint) return options.apiEndpoint.replace(/\/$/, '');
  try {
    const url = new URL(options.endpoint);
    if (url.hostname.startsWith('events.')) url.hostname = `api.${url.hostname.slice('events.'.length)}`;
    return url.toString().replace(/\/$/, '');
  } catch { return options.endpoint.replace(/\/$/, ''); }
}

/** The publishable key. Any value without the `mana_pk_` prefix is an error. */
function resolvePublishableKey(options: Pick<AnalyticsOptions, 'publishableKey'>): string {
  const key = options.publishableKey;
  if (!key) throw new Error('publishableKey and endpoint are required');
  if (!key.startsWith(PUBLISHABLE_KEY_PREFIX)) throw new Error('publishableKey must be the publishable key (mana_pk_...). Never put a secret key or an API key in browser code');
  return key;
}

type ResolvedOptions = Omit<AnalyticsOptions, 'tracking' | 'game' | 'persistQueue'> & { publishableKey: string; tracking?: TrackingOptions } & Required<Pick<AnalyticsOptions, 'autoPageviews' | 'batchSize' | 'flushIntervalMs' | 'disabled' | 'crossSubdomainCookies' | 'retryCount' | 'maxQueueSize'>>;

/** Queue limits, as in getformo/sdk's EventQueue. */
const MAX_QUEUE_BYTES = 500 * 1024;
const MIN_QUEUE_BYTES = 200;
/** Backoff after a failed send: 1 s, 2 s, 4 s ... up to 30 s, plus up to 25% jitter. Retry-After is honoured up to 60 s. */
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;
/**
 * After back or forward (popstate), the framework swaps the page later: Astro
 * View Transitions and Next.js first load or render the page you go to. The
 * SDK waits until document.title changes, checked every POPSTATE_POLL_MS, for
 * at most POPSTATE_MAX_WAIT_MS, then reads the page fields and sends.
 */
const POPSTATE_POLL_MS = 50;
const POPSTATE_MAX_WAIT_MS = 1000;
/**
 * Browsers refuse a keepalive request when its body, plus the bodies of the
 * other keepalive requests of the page still in flight, is over 64 KiB. The
 * send on pagehide and on a hidden page keeps all its keepalive bodies in
 * flight at once to at most this many bytes (UTF-8), which leaves room for
 * the headers and for keepalive requests of other scripts.
 */
const KEEPALIVE_MAX_BYTES = 60_000;
/** `{"events":[` and `]}`: the bytes of a request body around the events. */
const BODY_WRAPPER_BYTES = 13;
/** The default timeout of shutdown(), as the game SDKs on quit: session_end, then send for at most 2 s. */
const SHUTDOWN_TIMEOUT_MS = 2000;

/**
 * A failed send whose events were dropped; given to the errorHandler option.
 * `reasons` has the reason codes of the collector when it refused the batch,
 * for example `['INVALID_EVENT', 'SESSION_ID_REQUIRED']`.
 */
export class SendError extends Error {
  constructor(message: string, readonly status: number, readonly dropped: number, readonly reasons: string[] = []) {
    super(message);
    this.name = 'SendError';
  }
}

/**
 * Why the collector refused a batch, from its JSON response:
 * `{ error: { code, message, refused?: [{ index, message_id, code, message }] } }`.
 * Never throws: a response without a JSON body gives no reason.
 */
async function refusalReason(response: { text?: () => Promise<string> }): Promise<{ text: string; codes: string[] }> {
  try {
    const error = (JSON.parse((await response.text?.()) ?? '') as { error?: { code?: unknown; message?: unknown; refused?: unknown } })?.error;
    if (!error || typeof error !== 'object') return { text: '', codes: [] };
    const refused = Array.isArray(error.refused) ? error.refused as { code?: unknown }[] : [];
    const codes = [...new Set([error.code, ...refused.map(item => item?.code)].filter((code): code is string => typeof code === 'string' && code.length > 0))];
    const message = typeof error.message === 'string' ? error.message.slice(0, 300) : '';
    return { text: [codes.join(', '), message].filter(Boolean).join(': '), codes };
  } catch { return { text: '', codes: [] }; }
}

/**
 * The refused events of an accepted batch (P-2787): the collector stores the
 * valid events and answers `{ accepted, rejected, errors: [{ index, message_id, code, message }] }`.
 * Never throws: a body without a `rejected` count (an older collector) gives 0.
 */
async function refusedInAccepted(response: { text?: () => Promise<string> }): Promise<{ rejected: number; codes: string[] }> {
  try {
    const body = JSON.parse((await response.text?.()) ?? '') as { rejected?: unknown; errors?: unknown };
    const rejected = typeof body?.rejected === 'number' && body.rejected > 0 ? Math.floor(body.rejected) : 0;
    if (!rejected) return { rejected: 0, codes: [] };
    const errors = Array.isArray(body.errors) ? body.errors as { code?: unknown }[] : [];
    return { rejected, codes: [...new Set(errors.map(item => item?.code).filter((code): code is string => typeof code === 'string' && code.length > 0))] };
  } catch { return { rejected: 0, codes: [] }; }
}

const clamp = (value: number | undefined, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;

export class Analytics {
  private readonly options: ResolvedOptions;
  /** The validated `app` option, sent as context.app on every event. */
  private readonly app?: AppInfo;
  private pending: AnalyticsEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private previousPath?: string;
  private stopped = false;
  /** Bumped whenever identity is cleared or rotated; stale in-flight batches lose their identity. */
  private identityGeneration = 0;
  /** Bumped by optOut(); batches in flight across an opt-out are never re-sent. */
  private optOutGeneration = 0;
  private optedOut = false;
  private timezoneExcluded = false;
  private userId?: string;
  /** Explicit setConsent() value; undefined means "use requireConsent". */
  private consent?: boolean;
  /** identify() made before consent, sent when consent is granted. */
  private deferredIdentify?: Traits;
  /** traits() made before consent or on an excluded page, merged, sent when identity is allowed. */
  private deferredTraits?: Traits;
  /** The protected-traits warning is printed once per instance. */
  private warnedProtectedTraits = false;
  /** A game handoff (`mana_hid`) read on load, sent once identity is allowed (P-2523). */
  private handoff?: Handoff;
  private readonly keys: { anonymousId: string; sessionId: string; userId: string; optOut: string; firstOpen: string };
  /** Game mode (P-2800): game_open, sessions and errors. Only with a valid app option. */
  private readonly game: boolean;
  /** The persistent queue (G-2526), or undefined when it is off. */
  private readonly persist?: PersistentQueue;
  private persistLoaded = false;
  /** The stored events being read on load; flush() waits for them. */
  private restoring?: Promise<void>;
  /** game_open was sent for this page load (and this identity). */
  private gameOpened = false;
  /** The game session of the last event: its ID, start and last activity (ms). */
  private gameSession?: { id: string; startedAt: number; lastAt: number };
  /** First open when localStorage is not available: page memory only. */
  private firstOpenMemory?: string;
  private readonly errorLimits = new ErrorLimiter();
  private readonly onWindowError = (event: Event) => { try { this.captureWindowError(event as ErrorEvent); } catch { /* Never throw from the error handler. */ } };
  private readonly onRejection = (event: Event) => { try { this.captureRejection(event as PromiseRejectionEvent); } catch { /* Never throw from the error handler. */ } };
  private acquisition?: AnalyticsEvent['context'];
  private acquisitionDay?: string;
  private readonly logger: Logger;
  /** A page view that waits for the framework to update the page; sent at once when the page hides. */
  private pendingPage?: { kind: 'popstate' | 'history'; timer: ReturnType<typeof setTimeout>; send: () => void };
  private readonly onPageHide = () => { this.sendPendingPage(); this.endGameOnPageHide(); void this.flush(true); };
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') { this.sendPendingPage(); void this.flush(true); }
  };
  /** `manalens:navigate`: the app says the new page is ready, so send at once. */
  private readonly onNavigation = () => { this.page(); };
  /**
   * Back or forward. The URL is already new, but the framework has not yet
   * swapped the page (title and content). Wait for the title to change (at
   * most POPSTATE_MAX_WAIT_MS), then send. page() skips the path and query it
   * sent last, so a hash-only change sends nothing.
   */
  private readonly onPopState = () => {
    // A pushState page view that still waits is for an earlier page: send it first.
    if (this.pendingPage?.kind === 'history') this.sendPendingPage();
    this.deferPage('popstate', () => this.page(), true);
  };
  /** Server-error attempts per message_id (network errors are not counted). */
  private readonly attempts = new Map<string, number>();
  /** Serialized size per queued event, computed once. */
  private readonly sizes = new WeakMap<AnalyticsEvent, number>();
  /** Scheduled flushes wait until this time after a failure (backoff). */
  private retryAt = 0;
  private backoffStep = 0;
  /** Smaller batches after a 413 (batch too large): halved on each 413, back to batchSize after a 2xx. */
  private batchLimit = Infinity;
  /** Body bytes of this SDK's keepalive requests still in flight (at most KEEPALIVE_MAX_BYTES). */
  private keepaliveInFlight = 0;
  /** shutdown() was called: new events are dropped while the queue is sent. */
  private closing = false;
  /** The pathname of the last pageview sent for a pushState / replaceState navigation. */
  private historyPathname?: string;
  /**
   * pushState / replaceState (SPA routers). Wait one tick so the router can set
   * the new document.title, then send a pageview only when the path changed:
   * a query-only replaceState (filters, tabs) and a same-URL replaceState on
   * hydration send none. While a back / forward page view waits, it covers the
   * current URL, so a history change (for example a router that saves the
   * scroll position with replaceState) adds nothing.
   */
  private readonly onHistoryChange = () => {
    if (this.pendingPage?.kind === 'popstate') return;
    this.deferPage('history', () => {
      if (location.pathname === this.historyPathname) return;
      this.historyPathname = location.pathname;
      this.page();
    }, false);
  };

  constructor(options: AnalyticsOptions) {
    if (!options.endpoint) throw new Error('publishableKey and endpoint are required');
    const publishableKey = resolvePublishableKey(options);
    this.app = resolveAppInfo(options.app);
    this.logger = new Logger(options.logger);
    // Game mode and the persistent queue need the app context: game events
    // without context.app do not reach the game dashboards.
    if (options.game === true && !this.app) console.warn('Manalens: the game option needs a valid app option. Game mode is off.');
    this.game = options.game === true && !!this.app;
    const persistQueue = options.persistQueue ?? this.game;
    if (options.persistQueue === true && !this.app) console.warn('Manalens: the persistQueue option needs a valid app option. Events wait in memory only.');
    this.options = {
      autoPageviews: true,
      // Fewer, larger requests (2026-11-22): each request costs a queue write, read and ack on the
      // collector. 30 events stays under the collector's 50. pagehide and visibilitychange still send
      // at once, in keepalive requests of at most 60000 bytes together (flushKeepalive).
      flushIntervalMs: 15000,
      ...withoutGameOptions(options),
      // tracking: false is the same as disabled: true (Formo's boolean form).
      disabled: options.disabled === true || options.tracking === false,
      tracking: typeof options.tracking === 'object' && options.tracking !== null ? options.tracking : undefined,
      publishableKey,
      crossSubdomainCookies: options.crossSubdomainCookies !== false,
      // Default 30; the collector refuses a batch of more than 50 events.
      batchSize: clamp(options.batchSize, 1, 50, 30),
      retryCount: clamp(options.retryCount, 0, 10, 3),
      maxQueueSize: clamp(options.maxQueueSize, MIN_QUEUE_BYTES, MAX_QUEUE_BYTES, MAX_QUEUE_BYTES),
    };
    const key = (name: string) => storageKey(this.options.publishableKey, name);
    this.keys = { anonymousId: key('anonymous-id'), sessionId: key('session-id'), userId: key('user-id'), optOut: key('opt-out'), firstOpen: key('first-open') };
    if (persistQueue === true && this.app) this.persist = new PersistentQueue(key('queue'));
    this.start();
    if (options.ready) {
      try { options.ready(this); } catch (error) { console.error('[Manalens] Error in the ready callback:', error); }
    }
  }

  private start(): void {
    if (typeof window === 'undefined') return;
    if (this.options.disabled) { this.logger.log('info', 'Disabled: no events and no browser storage'); return; }
    // A game's handoff parameter leaves the address bar at once, so it is not
    // bookmarked, shared or sent as part of any URL.
    this.handoff = takeHandoff();
    // In consent mode, no cookie or localStorage is touched until setConsent(true).
    // The opt-out flag is a strictly necessary preference: honour it in every mode.
    this.optedOut = readOptOut(this.keys.optOut);
    // An excluded timezone is visitor-level: nothing is sent, nothing stored,
    // and an existing identity is deleted (deletion needs no consent).
    this.timezoneExcluded = timezoneExcluded(this.options.tracking?.excludeTimezones);
    if (this.timezoneExcluded) { this.clearIdentityStorage(); void this.persist?.clear(); removeLocal(this.keys.firstOpen); this.handoff = undefined; this.logger.log('info', 'Excluded timezone: nothing is sent'); return; }
    // On an excluded host or path, no identity is written until an allowed page.
    if (this.identityAllowed() && !this.pageExcluded()) this.loadIdentity();
    // Record the landing page's acquisition touch before any navigation
    // (not from an excluded page, whose campaign would carry to later events).
    if (!this.pageExcluded()) this.captureContext();
    this.timer = setInterval(() => { this.keepGameSessionAlive(); void this.flushDue(); }, this.options.flushIntervalMs);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener?.('visibilitychange', this.onVisibilityChange);
    // Stored events of an earlier load go first, then this load's events.
    this.restorePersisted();
    if (this.game) {
      window.addEventListener('error', this.onWindowError);
      window.addEventListener('unhandledrejection', this.onRejection);
      this.startGame();
    }
    this.sendHandoff();
    if (this.options.autoPageviews) {
      this.page();
      this.historyPathname = location.pathname;
      installHistoryHooksOnce();
      window.addEventListener('popstate', this.onPopState);
      window.addEventListener('manalens:navigate', this.onNavigation);
      window.addEventListener(HISTORY_EVENT, this.onHistoryChange);
    }
    this.logger.log('info', `Initialized (autoPageviews: ${this.options.autoPageviews}, consent required: ${this.options.requireConsent === true}, game: ${this.game}, persistQueue: ${!!this.persist})`);
  }

  /**
   * Send a page view later. With waitForTitle, wait until document.title
   * changes (at most POPSTATE_MAX_WAIT_MS); otherwise wait one tick. A new
   * call replaces the waiting one. pagehide and visibilitychange send it at once.
   */
  private deferPage(kind: 'popstate' | 'history', send: () => void, waitForTitle: boolean): void {
    this.cancelPendingPage();
    const titleBefore = document.title;
    let waited = 0;
    const check = () => {
      if (waitForTitle && document.title === titleBefore && waited < POPSTATE_MAX_WAIT_MS) {
        waited += POPSTATE_POLL_MS;
        pending.timer = setTimeout(check, POPSTATE_POLL_MS);
        return;
      }
      this.sendPendingPage();
    };
    const pending = { kind, send, timer: setTimeout(check, 0) };
    this.pendingPage = pending;
  }

  /** Send the waiting page view now (with the page fields as they are now). */
  private sendPendingPage(): void {
    const pending = this.pendingPage;
    if (!pending) return;
    this.cancelPendingPage();
    if (!this.stopped) pending.send();
  }

  private cancelPendingPage(): void {
    if (this.pendingPage) clearTimeout(this.pendingPage.timer);
    this.pendingPage = undefined;
  }

  page(properties: AnalyticsEvent['properties'] = {}): void {
    if (typeof window === 'undefined') return;
    const path = `${location.pathname}${location.search}`;
    if (path === this.previousPath && Object.keys(properties).length === 0) return;
    // A page view sent now replaces one that waits (for example page() on a router's page-load event).
    this.cancelPendingPage();
    this.previousPath = path;
    this.historyPathname = location.pathname;
    this.enqueue('page', undefined, properties);
  }

  track(event: string, properties: AnalyticsEvent['properties'] = {}): void {
    if (!event || event.length > 128) throw new Error('Event name must be 1–128 characters');
    this.enqueue('track', event, properties);
  }

  /**
   * Attach a known user to this browser. Works without a wallet. Sends an
   * `identify` event with `user_id` and `traits`, persists the user ID in a
   * first-party browser-session cookie, and adds `user_id` to later events.
   */
  async identify(userId: string, traits: Traits = {}): Promise<void> {
    if (typeof userId !== 'string' || !userId || userId.length > 255) throw new Error('User ID must be 1–255 characters');
    if (JSON.stringify(traits).length > 2048) throw new Error('User traits must be under 2KB');
    // Opted out (or disabled): a complete no-op, so no user ID survives to a later optIn().
    if (!this.active()) return;
    this.userId = userId;
    if (!this.identityAllowed()) { this.deferredIdentify = traits; return; }
    // On an excluded page: nothing written or sent; sent with the first event on an allowed page.
    if (this.pageExcluded()) { this.deferredIdentify = traits; return; }
    writeUserId(this.keys.userId, userId, this.options.crossSubdomainCookies);
    this.enqueue('identify', undefined, {}, undefined, undefined, traits);
    await this.flush();
  }

  /**
   * Set traits on the player of this browser, with or without a user ID
   * (P-2814). Sends a `traits` event: before identify() the traits belong to
   * this browser's anonymous ID; after it, to the user. Protected traits
   * (`email`, `itch_user_id`, `stripe_customer_id`, `paddle_customer_id`)
   * are dropped with a console warning: only a server may set them. Like
   * identify(), it waits for consent and for an allowed page. A `null` value
   * clears a trait.
   */
  traits(traits: Traits): void {
    if (!traits || typeof traits !== 'object' || Array.isArray(traits)) throw new Error('Traits must be an object');
    const keys = Object.keys(traits);
    if (!keys.length) throw new Error('Traits must have at least one key');
    if (keys.length > 50) throw new Error('Traits must have at most 50 keys');
    if (JSON.stringify(traits).length > 2048) throw new Error('User traits must be under 2KB');
    if (!this.active()) return;
    const kept: Traits = {};
    const dropped: string[] = [];
    for (const key of keys) {
      if (PROTECTED_TRAITS.includes(key)) dropped.push(key);
      else kept[key] = traits[key];
    }
    if (dropped.length && !this.warnedProtectedTraits && typeof console !== 'undefined') {
      this.warnedProtectedTraits = true;
      console.warn(`[Manalens] traits(): ${dropped.join(', ')} not sent. Only a server with the secret key can set protected traits.`);
    }
    if (!Object.keys(kept).length) return;
    if (!this.identityAllowed() || this.pageExcluded()) { this.deferredTraits = { ...this.deferredTraits, ...kept }; return; }
    this.enqueue('traits', undefined, {}, undefined, undefined, kept);
  }

  /**
   * Link the Steam account of this player with a Steam ticket (P-2815).
   * Make the ticket with `GetAuthTicketForWebApi("manalens")` and pass its
   * bytes as hex. The SDK posts it once to `<apiEndpoint>/v0/link` with the
   * anonymous ID. It never retries a refusal; after a 429 with Retry-After
   * (at most 60 s) it tries once more. It sends nothing before consent, on an
   * excluded page or after optOut(). Never throws for an HTTP or network error:
   * read the result.
   */
  async link(request: LinkRequest): Promise<LinkResult> {
    if (!request || request.provider !== 'steam') throw new Error("link: provider must be 'steam'");
    if (typeof request.ticket !== 'string' || !STEAM_TICKET.test(request.ticket)) throw new Error('link: ticket must be hex, 32 to 4096 characters, an even number');
    if (!this.active()) return { linked: false, status: 0, code: 'DISABLED' };
    if (!this.identityAllowed()) return { linked: false, status: 0, code: 'CONSENT_REQUIRED' };
    if (this.pageExcluded()) return { linked: false, status: 0, code: 'EXCLUDED' };
    const body = JSON.stringify({ provider: 'steam', ticket: request.ticket, anonymous_id: generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies) });
    const url = `${resolveApiEndpoint(this.options)}/v0/link`;
    // Identity at the first send: a retry goes out only when nothing changed during the wait.
    const generation = this.identityGeneration;
    const optOutGeneration = this.optOutGeneration;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-publishable-key': this.options.publishableKey }, body, credentials: 'omit' });
      } catch {
        this.logger.log('warn', 'link: network error');
        return { linked: false, status: 0, code: 'NETWORK_ERROR' };
      }
      if (response.ok) { this.logger.log('info', 'link: Steam account linked'); return { linked: true, status: response.status }; }
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      if (response.status === 429 && attempt === 0 && Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= MAX_RETRY_AFTER_MS / 1000) {
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        // The same gates as the first send. After reset(), setConsent(false), optOut() or a
        // move to an excluded page, the old ticket and anonymous ID are not sent again.
        if (!this.active() || optOutGeneration !== this.optOutGeneration) return { linked: false, status: 0, code: 'DISABLED' };
        if (!this.identityAllowed()) return { linked: false, status: 0, code: 'CONSENT_REQUIRED' };
        if (generation !== this.identityGeneration) return { linked: false, status: 0, code: 'IDENTITY_CHANGED' };
        if (this.pageExcluded()) return { linked: false, status: 0, code: 'EXCLUDED' };
        continue;
      }
      const reason = await refusalReason(response);
      this.logger.log('warn', `link: HTTP ${response.status}${reason.text ? ` ${reason.text}` : ''}`);
      return { linked: false, status: response.status, ...(reason.codes[0] ? { code: reason.codes[0] } : {}) };
    }
  }

  /**
   * Consent mode (`requireConsent: true`): `setConsent(true)` starts the
   * persistent identity; `setConsent(false)` clears all identity storage and
   * strips identity from queued events. Events without consent carry no
   * anonymous_id, session_id or user_id. Also works without requireConsent.
   */
  setConsent(granted: boolean): void {
    if (!granted) this.identityGeneration++;
    this.consent = granted;
    if (typeof window === 'undefined' || this.options.disabled) return;
    if (granted) {
      this.loadIdentity();
      this.restorePersisted();
      this.startGame();
      this.sendHandoff();
      // On an excluded page, keep the identify and the traits until the visitor reaches an allowed page.
      if (this.pageExcluded()) return;
      const traits = this.deferredIdentify;
      this.deferredIdentify = undefined;
      if (traits && this.userId && this.active()) {
        writeUserId(this.keys.userId, this.userId, this.options.crossSubdomainCookies);
        this.enqueue('identify', undefined, {}, undefined, undefined, traits);
      }
      this.sendHeldTraits();
      return;
    }
    this.clearIdentityStorage();
    this.userId = undefined;
    this.deferredIdentify = undefined;
    this.deferredTraits = undefined;
    this.handoff = undefined;
    this.pending = stripIdentity(this.pending);
    // No consent: no stored events, no first open, no game session or error history.
    this.forgetGameState();
  }

  /** Forget the user ID, anonymous ID and session. The next event starts a fresh identity. */
  reset(): void {
    // Game mode: the old session ends first, with its identity and errors_dropped.
    if (this.gameSession && this.active() && this.identityAllowed()) this.endGameSession(Date.now());
    this.gameSession = undefined;
    this.errorLimits.clear();
    this.identityGeneration++;
    this.userId = undefined;
    this.deferredIdentify = undefined;
    this.deferredTraits = undefined;
    this.handoff = undefined;
    // Deletion needs no consent, so storage is cleared in every mode.
    if (typeof window === 'undefined' || this.options.disabled) return;
    this.clearIdentityStorage();
  }

  private clearIdentityStorage(): void {
    clearUserId(this.keys.userId);
    clearAnonymousId(this.keys.anonymousId);
    clearSessionId(this.keys.sessionId);
  }

  /** Stop tracking this browser, drop queued events and forget its identity. Persists across page loads. */
  optOut(): void {
    this.identityGeneration++;
    this.optOutGeneration++;
    this.pending = [];
    this.cancelPendingPage();
    this.forgetGameState();
    this.reset();
    this.optedOut = true;
    this.logger.log('info', 'Opted out');
    // Persisted in every mode: the opt-out is a strictly necessary preference.
    if (typeof window !== 'undefined' && !this.options.disabled) writeOptOut(this.keys.optOut, true, this.options.crossSubdomainCookies);
  }

  /** Resume tracking after optOut(). A new anonymous ID is created. */
  optIn(): void {
    this.identityGeneration++;
    this.optedOut = false;
    // Start clean: nothing from before or during the opt-out is attached to new events.
    this.userId = undefined;
    this.deferredIdentify = undefined;
    this.deferredTraits = undefined;
    if (typeof window === 'undefined' || this.options.disabled) return;
    writeOptOut(this.keys.optOut, false, this.options.crossSubdomainCookies);
    if (this.identityAllowed() && !this.timezoneExcluded && !this.pageExcluded()) generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies);
    this.restorePersisted();
    this.startGame();
  }

  isOptedOut(): boolean { return this.optedOut; }
  getUserId(): string | undefined { return this.userId; }
  getAnonymousId(): string | undefined {
    return this.active() && this.identityAllowed() && !this.pageExcluded() ? generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies) : undefined;
  }
  /**
   * The session ID of the next event, or undefined when the SDK sends no
   * identity (before consent, after optOut(), on an excluded page). Send it
   * with the server events of the same visitor, so that they are in this
   * session. Reading it does not count as activity.
   */
  getSessionId(): string | undefined {
    return this.active() && this.identityAllowed() && !this.pageExcluded() ? currentSessionId(this.keys.sessionId, this.options.crossSubdomainCookies) : undefined;
  }

  /**
   * Send the game handoff once: a `track` event `identity_handoff` with the
   * game's anonymous ID and the time the game made the link. It waits for
   * consent and for an allowed page; it is dropped after opt-out, reset() or
   * setConsent(false), and when the game ID is this browser's own ID.
   */
  private sendHandoff(): void {
    const handoff = this.handoff;
    if (!handoff || !this.active() || !this.identityAllowed() || this.pageExcluded()) return;
    this.handoff = undefined;
    if (handoff.source === this.getAnonymousId()) return;
    this.enqueue('track', HANDOFF_EVENT, { source_anonymous_id: handoff.source, handoff_at: handoff.at });
  }

  /** Send the traits held before consent or on an excluded page. */
  private sendHeldTraits(): void {
    const held = this.deferredTraits;
    if (!held || !this.active() || !this.identityAllowed() || this.pageExcluded()) return;
    this.deferredTraits = undefined;
    this.enqueue('traits', undefined, {}, undefined, undefined, held);
  }

  private identityAllowed(): boolean {
    return this.consent ?? !this.options.requireConsent;
  }

  private loadIdentity(): void {
    if (this.optedOut || this.timezoneExcluded || this.pageExcluded()) return;
    // Create the persistent ID on first load, before any event is queued.
    generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies);
    this.userId ||= readUserId(this.keys.userId);
  }

  private active(): boolean {
    return !this.stopped && !this.options.disabled && !this.optedOut && !this.timezoneExcluded && typeof window !== 'undefined';
  }

  /** The current host or path is in tracking.excludeHosts / excludePaths. Checked per event. */
  private pageExcluded(): boolean {
    const tracking = this.options.tracking;
    if (!tracking || typeof location === 'undefined') return false;
    return hostExcluded(location.hostname, tracking.excludeHosts) || pathExcluded(location.pathname, tracking.excludePaths);
  }

  /** Carry one coherent acquisition touch in memory for this page lifetime. */
  private captureContext(): AnalyticsEvent['context'] {
    const context = pageContext(location.href, this.options.tracking?.excludeQueryParams);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.acquisitionDay) { this.acquisition = undefined; this.acquisitionDay = day; }
    if (acquisitionKeys.some(key => context[key])) this.acquisition = context;
    if (!this.acquisition) this.acquisition = context;
    const carried = Object.fromEntries(acquisitionKeys.filter(key => this.acquisition?.[key]).map(key => [key, this.acquisition![key]]));
    return { ...context, ...carried, referrer: this.acquisition.referrer };
  }

  private enqueue(type: AnalyticsEvent['type'], event?: string, properties: AnalyticsEvent['properties'] = {}, context?: AnalyticsEvent['context'], originalTimestamp = new Date().toISOString(), traits?: Traits): void {
    if (!this.active() || this.closing) return;
    if (this.pageExcluded()) { this.logger.log('debug', `Not sent: ${type} on an excluded host or path`); return; }
    // An identify held back on an excluded page goes out first, on this allowed page.
    if (type !== 'identify' && this.deferredIdentify && this.userId && this.identityAllowed()) {
      const held = this.deferredIdentify;
      this.deferredIdentify = undefined;
      writeUserId(this.keys.userId, this.userId, this.options.crossSubdomainCookies);
      this.enqueue('identify', undefined, {}, undefined, undefined, held);
    }
    // Traits held the same way go out next.
    if (type !== 'identify' && type !== 'traits') this.sendHeldTraits();
    const at = Date.parse(originalTimestamp);
    const identity = this.identityAllowed() ? this.identity(Number.isFinite(at) ? at : Date.now()) : undefined;
    this.push(this.build(type, event, properties, originalTimestamp, identity, context, traits));
  }

  /** The identity of a new event. In game mode, a new session ID first ends the old game session and starts a new one. */
  private identity(now: number): Pick<AnalyticsEvent, 'anonymous_id' | 'session_id' | 'user_id'> {
    const cross = this.options.crossSubdomainCookies;
    const anonymousId = generateAnonymousId(this.keys.anonymousId, cross);
    const session = touchSession(this.keys.sessionId, cross, now);
    const ids = { anonymous_id: anonymousId, session_id: session.id, ...(this.userId ? { user_id: this.userId } : {}) };
    if (this.game && this.gameOpened) {
      if (this.gameSession?.id !== session.id) {
        // The old session ended at its last activity (30 minutes idle, or 24 hours old).
        if (this.gameSession) this.endGameSession(this.gameSession.lastAt, anonymousId);
        this.gameSession = { id: session.id, startedAt: session.startedAt, lastAt: now };
        this.errorLimits.newSession();
        this.push(this.build('track', 'session_start', {}, new Date(now).toISOString(), ids));
      } else this.gameSession.lastAt = now;
    }
    return ids;
  }

  private build(type: AnalyticsEvent['type'], event: string | undefined, properties: AnalyticsEvent['properties'], originalTimestamp: string, identity?: Pick<AnalyticsEvent, 'anonymous_id' | 'session_id' | 'user_id'>, context?: AnalyticsEvent['context'], traits?: Traits): AnalyticsEvent {
    return {
      type,
      ...(event ? { event } : {}),
      message_id: randomId(),
      channel: 'web',
      version: LIBRARY_VERSION,
      original_timestamp: originalTimestamp,
      context: { ...(context ?? this.captureContext()), library_name: LIBRARY_NAME, library_version: LIBRARY_VERSION, ...(this.app ? { app: this.app } : {}) },
      properties,
      ...(identity ?? {}),
      ...(type === 'identify' || type === 'traits' ? { traits } : {}),
    };
  }

  private push(payload: AnalyticsEvent): void {
    this.pending.push(payload);
    if (this.persistAllowed()) { this.restorePersisted(); this.persist!.put([payload]); }
    this.logger.log('debug', `Queued ${payload.type}${payload.event ? ` ${payload.event}` : ''}`);
    this.limitQueue();
    if (this.pending.length >= this.options.batchSize) void this.flushDue();
  }

  /** Ends the open game session with `session_end` (`duration_s`, and `errors_dropped` when errors were dropped). */
  private endGameSession(at: number, anonymousId = generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies)): void {
    const session = this.gameSession;
    if (!session) return;
    this.gameSession = undefined;
    const properties: AnalyticsEvent['properties'] = { duration_s: Math.max(0, Math.round((at - session.startedAt) / 1000)) };
    const dropped = this.errorLimits.takeDropped();
    if (dropped > 0) properties.errors_dropped = dropped;
    this.push(this.build('track', 'session_end', properties, new Date(at).toISOString(), { anonymous_id: anonymousId, session_id: session.id, ...(this.userId ? { user_id: this.userId } : {}) }));
  }

  /** pagehide: the game session ends now; the next event (also after a back-forward cache restore) starts a new one. */
  private endGameOnPageHide(): void {
    if (!this.game || !this.gameSession || !this.active() || !this.identityAllowed()) return;
    this.endGameSession(Date.now());
    clearSessionId(this.keys.sessionId);
  }

  /**
   * While the game is visible and focused, the flush timer keeps the open
   * session alive (as the game SDKs do while the game has focus). It never
   * starts a new session: the next event does.
   */
  private keepGameSessionAlive(): void {
    const session = this.gameSession;
    if (!this.game || !session || !this.active() || !this.identityAllowed() || this.pageExcluded()) return;
    if (typeof document === 'undefined' || document.visibilityState === 'hidden') return;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
    const now = Date.now();
    if (readSessionId(this.keys.sessionId, now) !== session.id) return;
    touchSession(this.keys.sessionId, this.options.crossSubdomainCookies, now);
    session.lastAt = now;
  }

  /**
   * Game mode: once per load, when identity is allowed (after consent in
   * consent mode), start a new session and send `game_open`. The first open
   * is kept in this SDK's storage (key `first-open`).
   */
  private startGame(): void {
    if (!this.game || this.gameOpened || !this.active() || !this.identityAllowed() || this.pageExcluded()) return;
    this.gameOpened = true;
    // Each start is a new session, as in the game SDKs.
    clearSessionId(this.keys.sessionId);
    this.gameSession = undefined;
    const stored = this.readFirstOpen();
    const firstOpenAt = stored ?? new Date().toISOString();
    if (!stored) this.writeFirstOpen(firstOpenAt);
    this.enqueue('track', 'game_open', { is_first_open: !stored, first_open_at: firstOpenAt });
  }

  private readFirstOpen(): string | undefined {
    const valid = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? value : undefined;
    // `first_open_at` is the key of the hand-written setup snippet before game mode: a player who has it is not new.
    return valid(readLocal(this.keys.firstOpen)) ?? valid(readLocal('first_open_at')) ?? this.firstOpenMemory;
  }

  private writeFirstOpen(value: string): void {
    writeLocal(this.keys.firstOpen, value);
    if (readLocal(this.keys.firstOpen) !== value) this.firstOpenMemory = value;
  }

  /** optOut() and setConsent(false): delete the stored events and the first open, and forget the game session and the error history. */
  private forgetGameState(): void {
    this.gameOpened = false;
    this.gameSession = undefined;
    this.firstOpenMemory = undefined;
    this.errorLimits.clear();
    this.persistLoaded = false;
    this.restoring = undefined;
    if (typeof window === 'undefined' || this.options.disabled) return;
    removeLocal(this.keys.firstOpen);
    void this.persist?.clear();
  }

  private persistAllowed(): boolean {
    return !!this.persist && this.active() && this.identityAllowed();
  }

  /** Read the stored events once, when storage is allowed, and put them before the events of this load. */
  private restorePersisted(): void {
    if (!this.persist || this.persistLoaded || !this.persistAllowed()) return;
    this.persistLoaded = true;
    const optOutGeneration = this.optOutGeneration;
    const restoring: Promise<void> = this.persist.load().then(events => {
      if (this.restoring === restoring) this.restoring = undefined;
      if (!this.active() || optOutGeneration !== this.optOutGeneration || !this.identityAllowed() || !this.persistLoaded) return;
      const queued = new Set(this.pending.map(event => event.message_id));
      const restored = events.filter(event => !queued.has(event.message_id));
      if (!restored.length) return;
      this.pending.unshift(...restored);
      this.logger.log('info', `Restored ${restored.length} stored event(s)`);
      this.limitQueue();
      void this.flushDue();
    });
    this.restoring = restoring;
  }

  /**
   * Send a handled error as an `error` event (source `manual`). An Error
   * object gives the message, the error type (its name), the stack and the
   * place in the code. Works in every mode; the error limits apply.
   */
  trackError(error: unknown, options: TrackErrorOptions = {}): void {
    if (!this.active()) return;
    const isError = errorLike(error);
    const stack = options.stack ?? (isError && typeof error.stack === 'string' ? cleanMessage(error.stack) : '');
    const frame = options.file || options.function ? undefined : firstFrame(isError && typeof error.stack === 'string' ? error.stack : undefined);
    this.recordError({
      message: isError ? error.message : typeof error === 'string' ? error : safeString(error),
      severity: options.severity ?? 'error',
      errorType: options.errorType ?? (isError && typeof error.name === 'string' ? error.name : ''),
      handled: options.handled ?? true,
      source: 'manual',
      ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      file: options.file ?? (frame ? cleanFile(frame.file) : ''),
      line: options.line ?? frame?.line,
      fn: options.function ?? frame?.fn ?? '',
      stack,
      properties: options.properties,
    });
  }

  private recordError(input: ErrorInput): void {
    const properties = errorProperties(input);
    if (!this.errorLimits.allow(String(properties.fingerprint), input.source)) { this.logger.log('debug', 'Error dropped by the error limits'); return; }
    this.enqueue('track', 'error', properties);
  }

  /** window `error`: an uncaught error. The message, stack and file lose personal data before they are queued. */
  private captureWindowError(event: ErrorEvent): void {
    if (!this.active()) return;
    const error = event?.error as unknown;
    const isError = errorLike(error);
    const stack = isError && typeof error.stack === 'string' ? error.stack : '';
    const frame = firstFrame(stack);
    this.recordError({
      message: cleanMessage(isError ? error.message : (typeof event?.message === 'string' && event.message) || 'Script error.'),
      severity: 'error',
      errorType: isError && typeof error.name === 'string' && error.name ? error.name : 'uncaught',
      handled: false,
      source: 'auto',
      file: cleanFile((typeof event?.filename === 'string' && event.filename) || frame?.file || ''),
      line: (typeof event?.lineno === 'number' && event.lineno) || frame?.line,
      fn: frame?.fn ?? '',
      stack: cleanMessage(stack),
    });
  }

  /** window `unhandledrejection`: a promise rejected with no handler. */
  private captureRejection(event: PromiseRejectionEvent): void {
    if (!this.active()) return;
    const reason = event?.reason as unknown;
    const isError = errorLike(reason);
    const stack = isError && typeof reason.stack === 'string' ? reason.stack : '';
    const frame = firstFrame(stack);
    this.recordError({
      message: cleanMessage(isError ? reason.message : typeof reason === 'string' ? reason : safeString(reason)),
      severity: 'error',
      errorType: isError && typeof reason.name === 'string' && reason.name ? reason.name : 'unhandledrejection',
      handled: false,
      source: 'auto',
      file: cleanFile(frame?.file ?? ''),
      line: frame?.line,
      fn: frame?.fn ?? '',
      stack: cleanMessage(stack),
    });
  }

  private size(event: AnalyticsEvent): number {
    let size = this.sizes.get(event);
    if (size === undefined) {
      size = utf8Bytes(JSON.stringify(event));
      this.sizes.set(event, size);
    }
    return size;
  }

  /** Keep the queue under maxQueueSize bytes; drop the oldest events first (never the newest one). */
  private limitQueue(): void {
    let total = this.pending.reduce((sum, event) => sum + this.size(event), 0);
    while (total > this.options.maxQueueSize && this.pending.length > 1) {
      const dropped = this.pending.shift()!;
      this.logger.log('warn', `Queue over maxQueueSize: dropped the oldest event (${dropped.type})`);
      total -= this.size(dropped);
      this.attempts.delete(dropped.message_id);
      this.persist?.remove([dropped.message_id]);
    }
  }

  /** The timer and a full batch flush only when no backoff is pending. */
  private flushDue(): Promise<void> {
    return Date.now() < this.retryAt ? Promise.resolve() : this.flush();
  }

  /** Wait before the next scheduled flush: exponential backoff with jitter, or Retry-After when longer. */
  private backOff(retryAfterHeader?: string | null): void {
    const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.backoffStep);
    this.backoffStep++;
    let delay = exponential + Math.random() * exponential * 0.25;
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    if (Number.isFinite(retryAfter) && retryAfter > 0) delay = Math.max(delay, Math.min(MAX_RETRY_AFTER_MS, retryAfter * 1000));
    this.retryAt = Date.now() + delay;
  }

  /**
   * Send one batch now. A call to flush() ignores the backoff; the timer and a
   * full batch wait for it. Network errors and 408 / 429 / 5xx keep the batch
   * in memory (server errors at most retryCount times). A 413 (batch too large)
   * keeps the events, halves the batch and sends again at once, without a
   * backoff and without counting a retry; a 413 for one event drops it. Other
   * 4xx drop the batch. With `keepalive` (the SDK's send on pagehide and on a
   * hidden page), the queue goes in keepalive requests of at most 60000 bytes
   * together; see flushKeepalive().
   */
  async flush(keepalive = false): Promise<void> {
    // Stored events of an earlier load go first: wait until they are read.
    if (this.restoring) await this.restoring;
    if (!this.active() || this.pending.length === 0) return;
    if (keepalive) return this.flushKeepalive();
    const batch = this.pending.splice(0, Math.min(this.options.batchSize, this.batchLimit));
    const body = JSON.stringify({ events: batch });
    const result = await this.send(batch, body, false);
    if (!result) return;
    this.requeue(result.again);
    // After a 413, send the smaller batch at once.
    if (result.split) await this.flush();
  }

  /**
   * The send on pagehide and on a hidden page (P-2853). Browsers refuse a
   * keepalive request when the bodies of the page's keepalive requests in
   * flight are over 64 KiB, and then the events would be lost. So the queue
   * goes in requests whose bodies, together with this SDK's keepalive
   * requests still in flight, are at most KEEPALIVE_MAX_BYTES (UTF-8 bytes
   * of the exact body). Each request has at most batchSize events. The events
   * that do not fit stay queued (and stored with persistQueue) for the next
   * send. One event whose body alone is over the limit can never go with
   * keepalive: it is sent alone with a normal request, which completes when
   * the page is only hidden and often also when it closes.
   */
  private async flushKeepalive(): Promise<void> {
    const sends: Promise<{ again: AnalyticsEvent[] } | undefined>[] = [];
    const limit = Math.min(this.options.batchSize, this.batchLimit);
    while (this.pending.length) {
      const budget = KEEPALIVE_MAX_BYTES - this.keepaliveInFlight;
      const batch: AnalyticsEvent[] = [];
      let bytes = BODY_WRAPPER_BYTES;
      for (const event of this.pending) {
        if (batch.length >= limit) break;
        const next = bytes + this.size(event) + (batch.length ? 1 : 0);
        if (next > budget) break;
        batch.push(event); bytes = next;
      }
      if (!batch.length) {
        const head = this.pending[0];
        if (BODY_WRAPPER_BYTES + this.size(head) <= KEEPALIVE_MAX_BYTES) break; // fits later, when the budget is free again
        this.pending.shift();
        this.logger.log('warn', 'An event over the keepalive limit is sent alone without keepalive');
        sends.push(this.send([head], JSON.stringify({ events: [head] }), false));
        continue;
      }
      // The exact body: its UTF-8 length decides (size() can count UTF-16 units where TextEncoder is missing).
      let body = JSON.stringify({ events: batch });
      let reserved = utf8Bytes(body);
      while (batch.length > 1 && reserved > budget) { batch.pop(); body = JSON.stringify({ events: batch }); reserved = utf8Bytes(body); }
      if (reserved > budget) break;
      this.pending.splice(0, batch.length);
      this.keepaliveInFlight += reserved;
      sends.push(this.send(batch, body, true).finally(() => { this.keepaliveInFlight -= reserved; }));
    }
    if (this.pending.length) this.logger.log('debug', `${this.pending.length} event(s) wait: over the keepalive limit for this send`);
    // The events of failed sends go back to the front of the queue in their first order.
    const results = await Promise.all(sends);
    const again = results.flatMap(result => result?.again ?? []);
    if (again.length) this.requeue(again);
  }

  /** Put events back at the front of the queue, in order, and keep the queue under maxQueueSize. */
  private requeue(events: AnalyticsEvent[]): void {
    if (!events.length) return;
    this.pending.unshift(...events);
    this.limitQueue();
  }

  /**
   * Send one batch. Returns the events to queue again (`again`, already
   * without identity when the identity changed in flight), and `split` after
   * a 413 for a batch of several events; undefined when nothing goes back to
   * the queue (accepted, refused for good, or opted out / destroyed in flight).
   */
  private async send(batch: AnalyticsEvent[], body: string, keepalive: boolean): Promise<{ again: AnalyticsEvent[]; split: boolean } | undefined> {
    const generation = this.identityGeneration;
    const optOutGeneration = this.optOutGeneration;
    let retry: AnalyticsEvent[];
    let split = false;
    try {
      const response = await fetch(this.options.endpoint.replace(/\/$/, '') + '/v0/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-publishable-key': this.options.publishableKey },
        body,
        credentials: 'omit',
        keepalive,
      });
      if (response.status === 413 && batch.length > 1) {
        // Too large: keep every event (same order, same message_id), halve the
        // batch and send again. Not a failure: no backoff, no retry counted.
        this.batchLimit = Math.max(1, Math.floor(batch.length / 2));
        this.logger.log('warn', `413: batch of ${batch.length} events too large, sending ${this.batchLimit}`);
        retry = batch;
        split = true;
      } else if (response.ok || !retryableStatus(response.status)) {
        // Accepted, or refused for good (400, 401, 403, a 413 for one event ...): sending it again cannot help.
        for (const event of batch) this.attempts.delete(event.message_id);
        // Only now does the stored copy go.
        this.persist?.remove(batch.map(event => event.message_id));
        if (response.ok) {
          this.backoffStep = 0; this.retryAt = 0; this.batchLimit = Infinity;
          // An accepted batch can still list refused events: they are dropped, not sent again.
          const refused = await refusedInAccepted(response);
          const dropped = Math.min(batch.length, refused.rejected);
          this.logger.log('debug', `Sent ${batch.length - dropped} event(s)`);
          if (dropped) this.reportDropped(`The collector refused ${dropped} of ${batch.length} event(s): HTTP ${response.status}${refused.codes.length ? ` ${refused.codes.join(', ')}` : ''}. The events are dropped`, response.status, dropped, refused.codes);
        } else {
          // Dropped, not sent again. The reason of the collector goes to the log and to the errorHandler.
          const reason = await refusalReason(response);
          this.reportDropped(`The collector refused ${batch.length} event(s): HTTP ${response.status}${reason.text ? ` ${reason.text}` : ''}. The events are dropped`, response.status, batch.length, reason.codes);
        }
        return undefined;
      } else {
        retry = batch.filter(event => {
          const attempts = (this.attempts.get(event.message_id) ?? 0) + 1;
          if (attempts > this.options.retryCount) { this.attempts.delete(event.message_id); this.persist?.remove([event.message_id]); return false; }
          this.attempts.set(event.message_id, attempts);
          return true;
        });
        if (retry.length < batch.length) this.reportDropped(`Dropped ${batch.length - retry.length} event(s) after ${this.options.retryCount} retries: HTTP ${response.status}`, response.status, batch.length - retry.length);
        if (retry.length) this.logger.log('warn', `Send failed with HTTP ${response.status}: ${retry.length} event(s) will be sent again`);
        this.backOff(response.headers?.get?.('retry-after'));
      }
    } catch {
      // Network error (offline, DNS, CORS): not counted, the events wait.
      retry = batch;
      this.logger.log('warn', `Network error: ${batch.length} event(s) wait in memory`);
      this.backOff();
    }
    // Retry from memory. With persistQueue, the stored copy stays until the
    // collector accepts the batch, so a closed tab sends it on the next load.
    // State may have changed while the request was in flight: drop the batch
    // after optOut()/destroy(); strip identity after reset(), setConsent(false)
    // or any other identity change, even if consent was granted again since.
    if (!this.active() || optOutGeneration !== this.optOutGeneration) { for (const event of batch) this.attempts.delete(event.message_id); return undefined; }
    const stale = generation !== this.identityGeneration || !this.identityAllowed();
    const again = stale ? stripIdentity(retry) : retry;
    if (stale && this.persist) {
      // The stored copies follow: without identity, and without identify events.
      const kept = new Set(again.map(event => event.message_id));
      this.persist.remove(retry.filter(event => !kept.has(event.message_id)).map(event => event.message_id));
      if (this.persistAllowed()) this.persist.put(again);
    }
    // After a 413, flush() sends the smaller batch at once. Not after a
    // keepalive send on pagehide: the page is going away. The events stay
    // queued (and stored with persistQueue), and the next send uses the
    // smaller batch.
    return { again, split: split && !keepalive };
  }

  /**
   * End the game and send the queue, for example before an Electron game
   * quits. In game mode, the open game session ends with `session_end`
   * (`duration_s`). Then the SDK sends the queue with normal requests (not
   * keepalive), for at most `timeoutMs` (default 2000), and stops, like the
   * Node SDK's shutdown(): timers and listeners are removed, and later calls
   * send nothing. Create a new instance to track again. Events not sent in
   * time stay in the stored queue with persistQueue (the default in game
   * mode) and go on the next start; without it they are lost. Never rejects.
   */
  async shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.stopped || this.closing) return;
    // A page view that waits goes first; then the session ends. Later events are dropped.
    this.sendPendingPage();
    if (this.game && this.gameSession && this.active() && this.identityAllowed()) {
      this.endGameSession(Date.now());
      clearSessionId(this.keys.sessionId);
    }
    this.closing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : SHUTDOWN_TIMEOUT_MS)); });
    const drain = (async () => {
      // One batch per flush(): stop when a send makes no progress (offline, a server error).
      while (this.active() && this.pending.length) {
        const before = this.pending.length;
        await this.flush();
        if (this.pending.length >= before) break;
      }
      // The stored copy of what is still queued is written before the app quits.
      await this.persist?.settled();
    })().catch(() => undefined);
    await Promise.race([drain, timeout]);
    clearTimeout(timer);
    if (this.pending.length) this.logger.log('warn', `shutdown: ${this.pending.length} event(s) not sent${this.persist ? ' (kept in the stored queue)' : ''}`);
    this.destroy();
  }

  /** Log the drop and call the errorHandler option (an error thrown there is caught). */
  private reportDropped(message: string, status: number, dropped: number, reasons: string[] = []): void {
    this.logger.log('error', message);
    const handler = this.options.errorHandler;
    if (typeof handler !== 'function') return;
    try { handler(new SendError(message, status, dropped, reasons)); } catch (error) { console.error('[Manalens] Error in the errorHandler callback:', error); }
  }

  destroy(): void {
    this.identityGeneration++;
    if (this.timer) clearInterval(this.timer);
    this.cancelPendingPage();
    if (typeof window !== 'undefined') {
      window.removeEventListener(HISTORY_EVENT, this.onHistoryChange);
      window.removeEventListener('pagehide', this.onPageHide);
      document.removeEventListener?.('visibilitychange', this.onVisibilityChange);
      window.removeEventListener('popstate', this.onPopState);
      window.removeEventListener('manalens:navigate', this.onNavigation);
      window.removeEventListener('error', this.onWindowError);
      window.removeEventListener('unhandledrejection', this.onRejection);
    }
    this.pending = [];
    this.attempts.clear();
    this.stopped = true;
  }
}

/** UTF-8 bytes of a string; the UTF-16 length where TextEncoder is missing. */
function utf8Bytes(text: string): number {
  return typeof TextEncoder === 'undefined' ? text.length : new TextEncoder().encode(text).byteLength;
}

/** 408 Request Timeout, 429 Too Many Requests and 5xx are worth another try. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Game to website identity handoff (P-2523): `?mana_hid=<game anonymous ID>.<unix seconds>`. */
const HANDOFF_PARAM = 'mana_hid';
const HANDOFF_EVENT = 'identity_handoff';
const HANDOFF = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,12})$/i;
type Handoff = { source: string; at: number };

/** Read `mana_hid` and remove it from the address bar (other parameters and the hash stay). */
function takeHandoff(): Handoff | undefined {
  if (typeof location === 'undefined') return undefined;
  let url: URL;
  try { url = new URL(location.href); } catch { return undefined; }
  const raw = url.searchParams.get(HANDOFF_PARAM);
  if (raw === null) return undefined;
  url.searchParams.delete(HANDOFF_PARAM);
  try { history.replaceState(history.state, '', url.toString()); } catch { /* no history API */ }
  const match = HANDOFF.exec(raw);
  return match ? { source: match[1].toLowerCase(), at: Number(match[2]) } : undefined;
}

/** Dispatched on window after history.pushState / replaceState. */
const HISTORY_EVENT = 'manalens:historychange';

/**
 * Wrap history.pushState / replaceState once per history object, whatever the
 * number of SDK instances (React Strict Mode, hot reload), so one navigation
 * dispatches one event. Each instance adds and removes its own listener. The
 * Symbol.for marker survives module reloads. Adapted from getformo/sdk.
 */
function installHistoryHooksOnce(): void {
  if (typeof history === 'undefined' || typeof window === 'undefined') return;
  const marked = history as History & Record<symbol, boolean>;
  const marker = Symbol.for('manalens.historyWrapped');
  if (marked[marker]) return;
  marked[marker] = true;
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event(HISTORY_EVENT));
      return result;
    };
  }
}

/** The options without game and persistQueue, which the constructor resolves itself. */
function withoutGameOptions(options: AnalyticsOptions): Omit<AnalyticsOptions, 'game' | 'persistQueue'> {
  const { game: _game, persistQueue: _persistQueue, ...rest } = options;
  return rest;
}

/** An Error, or an object with a string message (errors from another realm). */
function errorLike(value: unknown): value is { message: string; name?: unknown; stack?: unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string';
}

/** A rejection reason that is not an Error, as text. */
function safeString(value: unknown): string {
  if (value === undefined) return 'undefined';
  try { return typeof value === 'object' ? JSON.stringify(value) ?? String(value) : String(value); } catch { return Object.prototype.toString.call(value); }
}

/** Remove identity fields and drop identify and traits events (a traits event needs an identity). */
function stripIdentity(events: AnalyticsEvent[]): AnalyticsEvent[] {
  return events
    .filter(event => event.type !== 'identify' && event.type !== 'traits')
    .map(({ anonymous_id: _a, session_id: _s, user_id: _u, ...event }) => event);
}

export function createAnalytics(options: AnalyticsOptions): Analytics {
  return new Analytics(options);
}
