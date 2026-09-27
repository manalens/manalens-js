import { pageContext } from './attribution';
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
    if (typeof window !== 'undefined' && !this.options.disabled) {
      this.timer = setInterval(() => { void this.flush(); }, this.options.flushIntervalMs);
      this.startWebVitals();
      window.addEventListener('pagehide', this.onPageHide);
      document.addEventListener?.('visibilitychange', this.onVisibilityChange);
      if (this.options.autoPageviews) {
        this.page();
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

  /** Explicit, in-memory identity. Call again after each authenticated page load. */
  async identify(userId: string, traits: Record<string, string | number | boolean | null> = {}): Promise<void> {
    if (!userId || userId.length > 255) throw new Error('User ID must be 1–255 characters');
    if (JSON.stringify(traits).length > 2048) throw new Error('User traits must be under 2KB');
    this.userId = userId;
    if (typeof window === 'undefined' || this.options.disabled) return;
    const response = await fetch(this.options.endpoint.replace(/\/$/, '') + '/v1/identify', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-write-key': this.options.writeKey },
      body: JSON.stringify({ user_id: userId, traits, page_url: `${location.origin}${location.pathname}` }), credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Analytics identification failed: ${response.status}`);
  }

  clearUserId(): void { this.userId = undefined; }
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
    const context = pageContext(this.landingUrl);
    const navigationStart = typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
      ? new Date(performance.timeOrigin).toISOString() : new Date().toISOString();
    this.enqueue('web_vitals', undefined, {
      ...this.vitals,
      ...(this.vitalNavigationType ? { navigation_type: this.vitalNavigationType } : {}),
    }, context, navigationStart);
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
      context: context ?? pageContext(),
      properties,
      ...(this.userId ? { user_id: this.userId } : {}),
    };
    this.pending.push(payload);
    if (this.pending.length >= this.options.batchSize) void this.flush();
  }

  async flush(keepalive = false): Promise<void> {
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
