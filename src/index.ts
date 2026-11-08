import { pageContext } from './attribution';
import { acquisitionKeys } from './attribution-contract';
import { clearAnonymousId, clearSessionId, clearUserId, generateAnonymousId, readOptOut, readUserId, touchSessionId, writeOptOut, writeUserId } from './identity';
import { storageKey } from './storage';
import type { AnalyticsEvent, AnalyticsOptions, Traits } from './types';

/** Sent as context.library_name / library_version, like Formo's Web SDK. Keep in sync with package.json. */
export const LIBRARY_NAME = 'Untitled Analytics Web SDK';
export const LIBRARY_VERSION = '0.4.0';

export type { AnalyticsEvent, AnalyticsOptions, Traits } from './types';

type ResolvedOptions = AnalyticsOptions & Required<Pick<AnalyticsOptions, 'autoPageviews' | 'batchSize' | 'flushIntervalMs' | 'disabled' | 'crossSubdomainCookies'>>;

export class Analytics {
  private readonly options: ResolvedOptions;
  private pending: AnalyticsEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private previousPath?: string;
  private stopped = false;
  /** Bumped whenever identity is cleared or rotated; stale in-flight batches lose their identity. */
  private identityGeneration = 0;
  /** Bumped by optOut(); batches in flight across an opt-out are never re-sent. */
  private optOutGeneration = 0;
  private optedOut = false;
  private userId?: string;
  /** Explicit setConsent() value; undefined means "use requireConsent". */
  private consent?: boolean;
  /** identify() made before consent, sent when consent is granted. */
  private deferredIdentify?: Traits;
  private readonly keys: { anonymousId: string; sessionId: string; userId: string; optOut: string };
  private acquisition?: AnalyticsEvent['context'];
  private acquisitionDay?: string;
  private readonly onPageHide = () => { void this.flush(true); };
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') void this.flush(true);
  };
  private readonly onNavigation = () => { this.page(); };

  constructor(options: AnalyticsOptions) {
    if (!options.writeKey || !options.endpoint) throw new Error('writeKey and endpoint are required');
    this.options = {
      autoPageviews: true,
      batchSize: 10,
      flushIntervalMs: 5000,
      disabled: false,
      ...options,
      crossSubdomainCookies: options.crossSubdomainCookies !== false,
    };
    const key = (name: string) => storageKey(this.options.writeKey, name);
    this.keys = { anonymousId: key('anonymous-id'), sessionId: key('session-id'), userId: key('user-id'), optOut: key('opt-out') };
    if (typeof window === 'undefined' || this.options.disabled) return;
    // In consent mode, no cookie or localStorage is touched until setConsent(true).
    // The opt-out flag is a strictly necessary preference: honour it in every mode.
    this.optedOut = readOptOut(this.keys.optOut);
    if (this.identityAllowed()) this.loadIdentity();
    // Record the landing page's acquisition touch before any navigation.
    this.captureContext();
    this.timer = setInterval(() => { void this.flush(); }, this.options.flushIntervalMs);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener?.('visibilitychange', this.onVisibilityChange);
    if (this.options.autoPageviews) {
      this.page();
      window.addEventListener('popstate', this.onNavigation);
      window.addEventListener('ua:navigate', this.onNavigation);
    }
  }

  page(properties: AnalyticsEvent['properties'] = {}): void {
    if (typeof window === 'undefined') return;
    const path = `${location.pathname}${location.search}`;
    if (path === this.previousPath && Object.keys(properties).length === 0) return;
    this.previousPath = path;
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
    this.userId = userId;
    if (!this.active()) return;
    if (!this.identityAllowed()) { this.deferredIdentify = traits; return; }
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
      const traits = this.deferredIdentify;
      this.deferredIdentify = undefined;
      if (traits && this.userId && this.active()) {
        writeUserId(this.keys.userId, this.userId, this.options.crossSubdomainCookies);
        this.enqueue('identify', undefined, {}, undefined, undefined, traits);
      }
      return;
    }
    this.clearIdentityStorage();
    this.userId = undefined;
    this.deferredIdentify = undefined;
    this.pending = stripIdentity(this.pending);
  }

  /** Forget the user ID, anonymous ID and session. The next event starts a fresh identity. */
  reset(): void {
    this.identityGeneration++;
    this.userId = undefined;
    this.deferredIdentify = undefined;
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
    this.reset();
    this.optedOut = true;
    // Persisted in every mode: the opt-out is a strictly necessary preference.
    if (typeof window !== 'undefined' && !this.options.disabled) writeOptOut(this.keys.optOut, true, this.options.crossSubdomainCookies);
  }

  /** Resume tracking after optOut(). A new anonymous ID is created. */
  optIn(): void {
    this.identityGeneration++;
    this.optedOut = false;
    if (typeof window === 'undefined' || this.options.disabled) return;
    writeOptOut(this.keys.optOut, false, this.options.crossSubdomainCookies);
    if (this.identityAllowed()) generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies);
  }

  isOptedOut(): boolean { return this.optedOut; }
  getUserId(): string | undefined { return this.userId; }
  getAnonymousId(): string | undefined {
    return this.active() && this.identityAllowed() ? generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies) : undefined;
  }

  private identityAllowed(): boolean {
    return this.consent ?? !this.options.requireConsent;
  }

  private loadIdentity(): void {
    if (this.optedOut) return;
    // Create the persistent ID on first load, before any event is queued.
    generateAnonymousId(this.keys.anonymousId, this.options.crossSubdomainCookies);
    this.userId ||= readUserId(this.keys.userId);
  }

  private active(): boolean {
    return !this.stopped && !this.options.disabled && !this.optedOut && typeof window !== 'undefined';
  }

  /** Carry one coherent acquisition touch in memory for this page lifetime. */
  private captureContext(): AnalyticsEvent['context'] {
    const context = pageContext();
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.acquisitionDay) { this.acquisition = undefined; this.acquisitionDay = day; }
    if (acquisitionKeys.some(key => context[key])) this.acquisition = context;
    if (!this.acquisition) this.acquisition = context;
    const carried = Object.fromEntries(acquisitionKeys.filter(key => this.acquisition?.[key]).map(key => [key, this.acquisition![key]]));
    return { ...context, ...carried, referrer: this.acquisition.referrer };
  }

  private enqueue(type: AnalyticsEvent['type'], event?: string, properties: AnalyticsEvent['properties'] = {}, context?: AnalyticsEvent['context'], originalTimestamp = new Date().toISOString(), traits?: Traits): void {
    if (!this.active()) return;
    const cross = this.options.crossSubdomainCookies;
    const payload: AnalyticsEvent = {
      type,
      ...(event ? { event } : {}),
      message_id: crypto.randomUUID(),
      channel: 'web',
      version: LIBRARY_VERSION,
      original_timestamp: originalTimestamp,
      context: { ...(context ?? this.captureContext()), library_name: LIBRARY_NAME, library_version: LIBRARY_VERSION },
      properties,
      ...(this.identityAllowed() ? {
        anonymous_id: generateAnonymousId(this.keys.anonymousId, cross),
        session_id: touchSessionId(this.keys.sessionId, cross),
        ...(this.userId ? { user_id: this.userId } : {}),
      } : {}),
      ...(type === 'identify' ? { traits } : {}),
    };
    this.pending.push(payload);
    if (this.pending.length >= this.options.batchSize) void this.flush();
  }

  async flush(keepalive = false): Promise<void> {
    if (!this.active() || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.options.batchSize);
    const generation = this.identityGeneration;
    const optOutGeneration = this.optOutGeneration;
    try {
      const response = await fetch(this.options.endpoint.replace(/\/$/, '') + '/v1/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-write-key': this.options.writeKey },
        body: JSON.stringify({ events: batch }),
        credentials: 'omit',
        keepalive,
      });
      if (!response.ok) throw new Error(`Analytics ingestion failed: ${response.status}`);
    } catch {
      // Retry in memory only; the queue is never written to browser storage.
      // State may have changed while the request was in flight: drop the batch
      // after optOut()/destroy(); strip identity after reset(), setConsent(false)
      // or any other identity change, even if consent was granted again since.
      if (!this.active() || optOutGeneration !== this.optOutGeneration) return;
      const stale = generation !== this.identityGeneration || !this.identityAllowed();
      this.pending.unshift(...(stale ? stripIdentity(batch) : batch));
      this.pending = this.pending.slice(0, 100);
    }
  }

  destroy(): void {
    this.identityGeneration++;
    if (this.timer) clearInterval(this.timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onPageHide);
      document.removeEventListener?.('visibilitychange', this.onVisibilityChange);
      window.removeEventListener('popstate', this.onNavigation);
      window.removeEventListener('ua:navigate', this.onNavigation);
    }
    this.pending = [];
    this.stopped = true;
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
