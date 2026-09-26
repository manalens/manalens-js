import { pageContext } from './attribution';
import type { AnalyticsEvent, AnalyticsOptions } from './types';

export type { AnalyticsEvent, AnalyticsOptions } from './types';

export class Analytics {
  private readonly options: Required<AnalyticsOptions>;
  private pending: AnalyticsEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private previousPath?: string;
  private stopped = false;
  private readonly onPageHide = () => { void this.flush(true); };
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
      window.addEventListener('pagehide', this.onPageHide);
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

  private enqueue(type: AnalyticsEvent['type'], event?: string, properties: AnalyticsEvent['properties'] = {}): void {
    if (this.stopped || this.options.disabled || typeof window === 'undefined') return;
    const payload: AnalyticsEvent = {
      type,
      ...(event ? { event } : {}),
      message_id: crypto.randomUUID(),
      channel: 'web',
      version: '0.1.0',
      original_timestamp: new Date().toISOString(),
      context: pageContext(),
      properties,
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
