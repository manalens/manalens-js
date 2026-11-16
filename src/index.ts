import { pageContext } from './attribution';
import { acquisitionKeys } from './attribution-contract';
import { clearAnonymousId, clearSessionId, clearUserId, generateAnonymousId, readOptOut, readUserId, touchSessionId, writeOptOut, writeUserId } from './identity';
import { storageKey } from './storage';
import { hostExcluded, pathExcluded, timezoneExcluded, type TrackingOptions } from './tracking';
import { Logger } from './logger';
import type { AnalyticsEvent, AnalyticsOptions, Traits } from './types';
import { resolveAppInfo, type AppInfo } from './app';

/** Sent as context.library_name / library_version, like Formo's Web SDK. Keep in sync with package.json. */
export const LIBRARY_NAME = 'Untitled Analytics Web SDK';
export const LIBRARY_VERSION = '0.4.0';

export type { AnalyticsEvent, AnalyticsOptions, Traits } from './types';
export type { TrackingOptions } from './tracking';
export type { LoggerOptions, LogLevel } from './logger';
export { logLevels } from './logger';
export type { AppInfo } from './app';
export { appPlatforms, appStorefronts, appEngines } from './app';

/** Key prefixes that must never be used in browser code (secret key, API keys). */
const privateKeyPrefixes = ['ua_sk_', 'ua_api_', 'ua_mcp_'];

/**
 * The publishable key from `publishableKey`, or from `writeKey` (its old,
 * deprecated name). Both with different values is an error, so a page never
 * sends events to a project it did not mean.
 */
function resolvePublishableKey(options: Pick<AnalyticsOptions, 'publishableKey' | 'writeKey'>): string {
  const { publishableKey, writeKey } = options;
  if (publishableKey && writeKey && publishableKey !== writeKey) throw new Error('Give one key: publishableKey (writeKey is its old name). The two values differ');
  const key = publishableKey || writeKey;
  if (!key) throw new Error('publishableKey and endpoint are required');
  if (privateKeyPrefixes.some(prefix => key.startsWith(prefix))) throw new Error('publishableKey must be the publishable key (ua_pk_...). Never put a secret key or an API key in browser code');
  return key;
}

type ResolvedOptions = Omit<AnalyticsOptions, 'tracking'> & { publishableKey: string; tracking?: TrackingOptions } & Required<Pick<AnalyticsOptions, 'autoPageviews' | 'batchSize' | 'flushIntervalMs' | 'disabled' | 'crossSubdomainCookies' | 'retryCount' | 'maxQueueSize'>>;

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

/** A failed send whose events were dropped; given to the errorHandler option. */
export class SendError extends Error {
  constructor(message: string, readonly status: number, readonly dropped: number) {
    super(message);
    this.name = 'SendError';
  }
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
  /** A game handoff (`ua_hid`) read on load, sent once identity is allowed (P-2523). */
  private handoff?: Handoff;
  private readonly keys: { anonymousId: string; sessionId: string; userId: string; optOut: string };
  private acquisition?: AnalyticsEvent['context'];
  private acquisitionDay?: string;
  private readonly logger: Logger;
  /** A page view that waits for the framework to update the page; sent at once when the page hides. */
  private pendingPage?: { kind: 'popstate' | 'history'; timer: ReturnType<typeof setTimeout>; send: () => void };
  private readonly onPageHide = () => { this.sendPendingPage(); void this.flush(true); };
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') { this.sendPendingPage(); void this.flush(true); }
  };
  /** `ua:navigate`: the app says the new page is ready, so send at once. */
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
    this.options = {
      autoPageviews: true,
      batchSize: 10,
      flushIntervalMs: 5000,
      ...options,
      // tracking: false is the same as disabled: true (Formo's boolean form).
      disabled: options.disabled === true || options.tracking === false,
      tracking: typeof options.tracking === 'object' && options.tracking !== null ? options.tracking : undefined,
      publishableKey,
      crossSubdomainCookies: options.crossSubdomainCookies !== false,
      retryCount: clamp(options.retryCount, 0, 10, 3),
      maxQueueSize: clamp(options.maxQueueSize, MIN_QUEUE_BYTES, MAX_QUEUE_BYTES, MAX_QUEUE_BYTES),
    };
    const key = (name: string) => storageKey(this.options.publishableKey, name);
    this.keys = { anonymousId: key('anonymous-id'), sessionId: key('session-id'), userId: key('user-id'), optOut: key('opt-out') };
    this.start();
    if (options.ready) {
      try { options.ready(this); } catch (error) { console.error('[Untitled Analytics] Error in the ready callback:', error); }
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
    if (this.timezoneExcluded) { this.clearIdentityStorage(); this.handoff = undefined; this.logger.log('info', 'Excluded timezone: nothing is sent'); return; }
    // On an excluded host or path, no identity is written until an allowed page.
    if (this.identityAllowed() && !this.pageExcluded()) this.loadIdentity();
    // Record the landing page's acquisition touch before any navigation
    // (not from an excluded page, whose campaign would carry to later events).
    if (!this.pageExcluded()) this.captureContext();
    this.timer = setInterval(() => { void this.flushDue(); }, this.options.flushIntervalMs);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener?.('visibilitychange', this.onVisibilityChange);
    this.sendHandoff();
    if (this.options.autoPageviews) {
      this.page();
      this.historyPathname = location.pathname;
      installHistoryHooksOnce();
      window.addEventListener('popstate', this.onPopState);
      window.addEventListener('ua:navigate', this.onNavigation);
      window.addEventListener(HISTORY_EVENT, this.onHistoryChange);
    }
    this.logger.log('info', `Initialized (autoPageviews: ${this.options.autoPageviews}, consent required: ${this.options.requireConsent === true})`);
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
      this.sendHandoff();
      const traits = this.deferredIdentify;
      this.deferredIdentify = undefined;
      // On an excluded page, keep the identify until the visitor reaches an allowed page.
      if (traits && this.pageExcluded()) { this.deferredIdentify = traits; return; }
      if (traits && this.userId && this.active()) {
        writeUserId(this.keys.userId, this.userId, this.options.crossSubdomainCookies);
        this.enqueue('identify', undefined, {}, undefined, undefined, traits);
      }
      return;
    }
    this.clearIdentityStorage();
    this.userId = undefined;
    this.deferredIdentify = undefined;
    this.handoff = undefined;
    this.pending = stripIdentity(this.pending);
  }

  /** Forget the user ID, anonymous ID and session. The next event starts a fresh identity. */
  reset(): void {
    this.identityGeneration++;
    this.userId = undefined;
    this.deferredIdentify = undefined;
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
    if (typeof window === 'undefined' || this.options.disabled) return;
    writeOptOut(this.keys.optOut, false, this.options.crossSubdomainCookies);
    if (this.identityAllowed() && !this.timezoneExcluded && !this.pageExcluded()) generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies);
  }

  isOptedOut(): boolean { return this.optedOut; }
  getUserId(): string | undefined { return this.userId; }
  getAnonymousId(): string | undefined {
    return this.active() && this.identityAllowed() && !this.pageExcluded() ? generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies) : undefined;
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
    if (!this.active()) return;
    if (this.pageExcluded()) { this.logger.log('debug', `Not sent: ${type} on an excluded host or path`); return; }
    // An identify held back on an excluded page goes out first, on this allowed page.
    if (type !== 'identify' && this.deferredIdentify && this.userId && this.identityAllowed()) {
      const held = this.deferredIdentify;
      this.deferredIdentify = undefined;
      writeUserId(this.keys.userId, this.userId, this.options.crossSubdomainCookies);
      this.enqueue('identify', undefined, {}, undefined, undefined, held);
    }
    const cross = this.options.crossSubdomainCookies;
    const payload: AnalyticsEvent = {
      type,
      ...(event ? { event } : {}),
      message_id: crypto.randomUUID(),
      channel: 'web',
      version: LIBRARY_VERSION,
      original_timestamp: originalTimestamp,
      context: { ...(context ?? this.captureContext()), library_name: LIBRARY_NAME, library_version: LIBRARY_VERSION, ...(this.app ? { app: this.app } : {}) },
      properties,
      ...(this.identityAllowed() ? {
        anonymous_id: generateAnonymousId(this.keys.anonymousId, cross),
        session_id: touchSessionId(this.keys.sessionId, cross),
        ...(this.userId ? { user_id: this.userId } : {}),
      } : {}),
      ...(type === 'identify' ? { traits } : {}),
    };
    this.pending.push(payload);
    this.logger.log('debug', `Queued ${type}${event ? ` ${event}` : ''}`);
    this.limitQueue();
    if (this.pending.length >= this.options.batchSize) void this.flushDue();
  }

  private size(event: AnalyticsEvent): number {
    let size = this.sizes.get(event);
    if (size === undefined) {
      const json = JSON.stringify(event);
      // UTF-8 bytes; the UTF-16 length is a close fallback where TextEncoder is missing.
      size = typeof TextEncoder === 'undefined' ? json.length : new TextEncoder().encode(json).byteLength;
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
   * in memory (server errors at most retryCount times); other 4xx drop it.
   */
  async flush(keepalive = false): Promise<void> {
    if (!this.active() || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.options.batchSize);
    const generation = this.identityGeneration;
    const optOutGeneration = this.optOutGeneration;
    let retry: AnalyticsEvent[];
    try {
      const response = await fetch(this.options.endpoint.replace(/\/$/, '') + '/v0/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-publishable-key': this.options.publishableKey },
        body: JSON.stringify({ events: batch }),
        credentials: 'omit',
        keepalive,
      });
      if (response.ok || !retryableStatus(response.status)) {
        // Accepted, or refused for good (400, 401, 403, 413 ...): sending it again cannot help.
        for (const event of batch) this.attempts.delete(event.message_id);
        if (response.ok) {
          this.backoffStep = 0; this.retryAt = 0;
          this.logger.log('debug', `Sent ${batch.length} event(s)`);
        } else this.reportDropped(`The collector refused ${batch.length} event(s): HTTP ${response.status}`, response.status, batch.length);
        return;
      }
      retry = batch.filter(event => {
        const attempts = (this.attempts.get(event.message_id) ?? 0) + 1;
        if (attempts > this.options.retryCount) { this.attempts.delete(event.message_id); return false; }
        this.attempts.set(event.message_id, attempts);
        return true;
      });
      if (retry.length < batch.length) this.reportDropped(`Dropped ${batch.length - retry.length} event(s) after ${this.options.retryCount} retries: HTTP ${response.status}`, response.status, batch.length - retry.length);
      if (retry.length) this.logger.log('warn', `Send failed with HTTP ${response.status}: ${retry.length} event(s) will be sent again`);
      this.backOff(response.headers?.get?.('retry-after'));
    } catch {
      // Network error (offline, DNS, CORS): not counted, the events wait.
      retry = batch;
      this.logger.log('warn', `Network error: ${batch.length} event(s) wait in memory`);
      this.backOff();
    }
    // Retry in memory only; the queue is never written to browser storage.
    // State may have changed while the request was in flight: drop the batch
    // after optOut()/destroy(); strip identity after reset(), setConsent(false)
    // or any other identity change, even if consent was granted again since.
    if (!this.active() || optOutGeneration !== this.optOutGeneration) { for (const event of batch) this.attempts.delete(event.message_id); return; }
    const stale = generation !== this.identityGeneration || !this.identityAllowed();
    this.pending.unshift(...(stale ? stripIdentity(retry) : retry));
    this.limitQueue();
  }

  /** Log the drop and call the errorHandler option (an error thrown there is caught). */
  private reportDropped(message: string, status: number, dropped: number): void {
    this.logger.log('error', message);
    const handler = this.options.errorHandler;
    if (typeof handler !== 'function') return;
    try { handler(new SendError(message, status, dropped)); } catch (error) { console.error('[Untitled Analytics] Error in the errorHandler callback:', error); }
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
      window.removeEventListener('ua:navigate', this.onNavigation);
    }
    this.pending = [];
    this.attempts.clear();
    this.stopped = true;
  }
}

/** 408 Request Timeout, 429 Too Many Requests and 5xx are worth another try. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Game to website identity handoff (P-2523): `?ua_hid=<game anonymous ID>.<unix seconds>`. */
const HANDOFF_PARAM = 'ua_hid';
const HANDOFF_EVENT = 'identity_handoff';
const HANDOFF = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,12})$/i;
type Handoff = { source: string; at: number };

/** Read `ua_hid` and remove it from the address bar (other parameters and the hash stay). */
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
const HISTORY_EVENT = 'ua:historychange';

/**
 * Wrap history.pushState / replaceState once per history object, whatever the
 * number of SDK instances (React Strict Mode, hot reload), so one navigation
 * dispatches one event. Each instance adds and removes its own listener. The
 * Symbol.for marker survives module reloads. Adapted from getformo/sdk.
 */
function installHistoryHooksOnce(): void {
  if (typeof history === 'undefined' || typeof window === 'undefined') return;
  const marked = history as History & Record<symbol, boolean>;
  const marker = Symbol.for('untitled-analytics.historyWrapped');
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

/** Remove identity fields and drop identify events. */
function stripIdentity(events: AnalyticsEvent[]): AnalyticsEvent[] {
  return events
    .filter(event => event.type !== 'identify')
    .map(({ anonymous_id: _a, session_id: _s, user_id: _u, ...event }) => event);
}

export function createAnalytics(options: AnalyticsOptions): Analytics {
  return new Analytics(options);
}
