import { pageContext } from './attribution';
import { acquisitionKeys } from './attribution-contract';
import type { AnalyticsEvent, AnalyticsOptions, WebVitalMetric } from './types';

export type { AnalyticsEvent, AnalyticsOptions, WebVitalsModule } from './types';

type ResolvedOptions = AnalyticsOptions & Required<Pick<AnalyticsOptions, 'autoPageviews' | 'batchSize' | 'flushIntervalMs' | 'disabled'>>;

export class Analytics {
  private readonly options: ResolvedOptions;
  private pending: AnalyticsEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private previousPath?: string;
  private stopped = false;
  private readonly vitals: Partial<Record<'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb', number>> = {};
  private readonly landingUrl = typeof location !== 'undefined' ? location.href : '';
  private vitalNavigationType?: string;
  private vitalsReported = false;
  private userId?: string;
  private anonymousId?: string;
  private identityExpires = 0;
  private attributionAllowed = false;
  private consentOverride?: boolean;
  readonly ready: Promise<void>;
  private get identityStorageKey(): string { return `untitled-analytics:${this.options.writeKey}:identity`; }
  private hasConsent(): boolean {
    try { return this.consentOverride ?? this.options.attribution?.consent() === true; } catch { return false; }
  }
  private forgetIdentity(): void {
    if (this.anonymousId && typeof window !== 'undefined') {
      try { window.localStorage.removeItem(this.identityStorageKey); } catch { /* Storage unavailable. */ }
    }
    this.anonymousId = undefined;
    this.identityExpires = 0;
  }
  /** Call on consent changes. Revocation clears queued identity-bearing events. */
  async setConsent(granted: boolean): Promise<void> {
    this.consentOverride = granted;
    if (!granted) { this.forgetIdentity(); this.userId = undefined; this.pending = []; return; }
    await this.configureIdentity();
  }
  private async configureIdentity(): Promise<void> {
    if (!this.options.attribution || !this.hasConsent() || this.options.disabled || this.stopped || typeof window === 'undefined') return;
    try {
      const response = await fetch(this.options.endpoint.replace(/\/$/, '') + '/v1/tracking/config', {
        headers: { 'x-write-key': this.options.writeKey }, credentials: 'omit',
      });
      const settings = response.ok ? await response.json() as { attribution_enabled?: boolean } : {};
      this.attributionAllowed = settings.attribution_enabled === true;
      if (!this.attributionAllowed || !this.hasConsent() || this.stopped) { this.forgetIdentity(); return; }
      // Never even read browser identity storage before both gates are satisfied.
      const stored = window.localStorage.getItem(this.identityStorageKey);
      let value: { id?: string; expires?: number } = {};
      try { value = stored ? JSON.parse(stored) : {}; } catch { /* Replace malformed identity. */ }
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
      if (!value.id || !uuid.test(value.id) || !Number.isFinite(value.expires) || value.expires! <= Date.now() || value.expires! > Date.now() + 90 * 86400000) {
        value = { id: crypto.randomUUID(), expires: Date.now() + 90 * 86400000 };
        window.localStorage.setItem(this.identityStorageKey, JSON.stringify(value));
      }
      this.anonymousId = value.id;
      this.identityExpires = value.expires!;
    } catch { this.anonymousId = undefined; /* Fall back to daily identity. */ }
  }
  private identity(): { anonymous_id?: string; attribution_consent?: boolean } {
    if (!this.hasConsent()) { this.forgetIdentity(); return {}; }
    if (this.anonymousId && this.identityExpires <= Date.now()) { this.forgetIdentity(); return {}; }
    return this.anonymousId && this.attributionAllowed ? { anonymous_id: this.anonymousId, attribution_consent: true } : {};
  }
  private acquisition?: AnalyticsEvent['context'];
  private acquisitionDay?: string;
  private initialContext?: AnalyticsEvent['context'];
  private readonly onPageHide = () => { this.reportWebVitals(); void this.flush(true); };
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') { this.reportWebVitals(); void this.flush(true); }
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
    };
    this.ready = this.configureIdentity();
    if (typeof window !== 'undefined' && !this.options.disabled) {
      this.initialContext = this.captureContext();
      this.timer = setInterval(() => { void this.flush(); }, this.options.flushIntervalMs);
      this.startWebVitals();
      window.addEventListener('pagehide', this.onPageHide);
      document.addEventListener?.('visibilitychange', this.onVisibilityChange);
      if (this.options.autoPageviews) {
        if (this.options.attribution) void this.ready.then(() => this.page()); else this.page();
        window.addEventListener('popstate', this.onNavigation);
        window.addEventListener('ua:navigate', this.onNavigation);
      }
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

  /** Explicit account identity. Re-identify after authenticated page loads; clear on logout. */
  async identify(userId: string, traits: Record<string, string | number | boolean | null> = {}): Promise<void> {
    if (!userId || userId.length > 255) throw new Error('User ID must be 1–255 characters');
    if (JSON.stringify(traits).length > 2048) throw new Error('User traits must be under 2KB');
    await this.ready;
    this.userId = userId;
    if (typeof window === 'undefined' || this.options.disabled) return;
    const response = await fetch(this.options.endpoint.replace(/\/$/, '') + '/v1/identify', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-write-key': this.options.writeKey },
      body: JSON.stringify({ user_id: userId, traits, ...this.identity(), page_url: `${location.origin}${location.pathname}`, context: this.captureContext() }), credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Analytics identification failed: ${response.status}`);
  }

  clearUserId(): void { this.userId = undefined; this.pending = []; this.forgetIdentity(); this.acquisition = undefined; this.previousPath = undefined; if (this.hasConsent()) void this.configureIdentity(); }
  getUserId(): string | undefined { return this.userId; }

  private startWebVitals(): void {
    const module = this.options.webVitals;
    if (!module) return;
    for (const name of ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const) {
      const register = module[`on${name}`];
      register?.(metric => {
        if (this.stopped || this.vitalsReported || metric.name !== name || !Number.isFinite(metric.value) || metric.value < 0) return;
        if (name !== 'CLS' && metric.value > 900_000) return;
        this.vitals[name.toLowerCase() as keyof typeof this.vitals] = name === 'CLS'
          ? Math.round(metric.value * 10_000) / 10_000
          : Math.round(metric.value);
        if (metric.navigationType) this.vitalNavigationType = metric.navigationType.slice(0, 100);
      }, { reportAllChanges: true });
    }
  }

  private reportWebVitals(): void {
    if (this.vitalsReported || this.stopped || !Object.keys(this.vitals).length) return;
    this.vitalsReported = true;
    const context = this.initialContext || pageContext(this.landingUrl);
    const navigationStart = typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
      ? new Date(performance.timeOrigin).toISOString() : new Date().toISOString();
    this.enqueue('web_vitals', undefined, {
      ...this.vitals,
      ...(this.vitalNavigationType ? { navigation_type: this.vitalNavigationType } : {}),
    }, context, navigationStart);
  }

  /** Carry one coherent acquisition touch in memory, never cookies/storage. */
  private captureContext(): AnalyticsEvent['context'] {
    const context = pageContext();
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.acquisitionDay) { this.acquisition = undefined; this.acquisitionDay = day; }
    if (acquisitionKeys.some(key => context[key])) this.acquisition = context;
    if (!this.acquisition) this.acquisition = context;
    const carried = Object.fromEntries(acquisitionKeys.filter(key => this.acquisition?.[key]).map(key => [key, this.acquisition![key]]));
    return { ...context, ...carried, referrer: this.acquisition.referrer };
  }

  private enqueue(type: AnalyticsEvent['type'], event?: string, properties: AnalyticsEvent['properties'] = {}, context?: AnalyticsEvent['context'], originalTimestamp = new Date().toISOString()): void {
    if (this.stopped || this.options.disabled || typeof window === 'undefined') return;
    const payload: AnalyticsEvent = {
      type,
      ...(event ? { event } : {}),
      message_id: crypto.randomUUID(),
      channel: 'web',
      version: '0.1.0',
      original_timestamp: originalTimestamp,
      context: context ?? this.captureContext(),
      properties,
      ...(this.userId ? { user_id: this.userId } : {}),
      ...this.identity(),
    };
    this.pending.push(payload);
    if (this.pending.length >= this.options.batchSize) void this.flush();
  }

  async flush(keepalive = false): Promise<void> {
    await this.ready;
    if (this.options.attribution && (!this.hasConsent() || (this.anonymousId && this.identityExpires <= Date.now()))) {
      this.forgetIdentity();
      this.pending = this.pending.map(({ anonymous_id: _id, attribution_consent: _consent, ...event }) => event);
    }
    if (this.stopped || this.options.disabled || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.options.batchSize);
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
      // Retry in memory only. Nothing is written to cookies or browser storage.
      this.pending.unshift(...batch);
      this.pending = this.pending.slice(0, 100);
    }
  }

  destroy(): void {
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

export function createAnalytics(options: AnalyticsOptions): Analytics {
  return new Analytics(options);
}
