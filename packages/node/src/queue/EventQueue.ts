// Event queue: batches events, sends them on a size or time trigger, and retries
// failed requests with exponential backoff and jitter. A 413 (batch too large)
// halves the batch and sends again at once.

import type { WireEvent } from '../types/index.js';

export interface QueueOptions {
  /** Full URL, for example `https://collect.example.com/v0/events`. */
  url: string;
  /** Auth headers for the mode. */
  headers: Record<string, string>;
  /** Collector batch limit: 100 (server) or 50 (app). */
  maxBatch: number;
  flushAt?: number;
  flushInterval?: number;
  maxQueueSize?: number;
  maxQueueLength?: number;
  retryCount?: number;
  /** First retry delay in ms before jitter. Default 1000. */
  retryDelay?: number;
  timeout?: number;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  /** For tests. */
  random?: () => number;
}

const DEFAULT_FLUSH_AT = 20;
const DEFAULT_FLUSH_INTERVAL = 10_000;
const MIN_FLUSH_INTERVAL = 1_000;
const MAX_FLUSH_INTERVAL = 300_000;
const DEFAULT_MAX_QUEUE_SIZE = 500_000;
const DEFAULT_MAX_QUEUE_LENGTH = 10_000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_DELAY = 1_000;
const MAX_RETRY_DELAY = 60_000;
const DEFAULT_TIMEOUT = 10_000;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(value)));

/**
 * Network errors, 5xx, 408 and 429 are retried. A 413 is not retried as it is:
 * the queue halves the batch (see EventQueue). Other statuses are not retried.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * The refused events of an accepted batch (P-2787): the collector stores the
 * valid events and lists the others in `errors`. Returns the count and the
 * reason codes, or undefined when nothing was refused or the body is not the
 * expected JSON. A refused event is never sent again.
 */
export function refusedEvents(text: string): { rejected: number; codes: string[] } | undefined {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return undefined; }
  const rejected = (body as { rejected?: unknown } | null)?.rejected;
  if (typeof rejected !== 'number' || !(rejected > 0)) return undefined;
  const errors = (body as { errors?: unknown }).errors;
  const codes = Array.isArray(errors) ? [...new Set(errors.map(item => (item as { code?: unknown } | null)?.code).filter((code): code is string => typeof code === 'string'))] : [];
  return { rejected, codes };
}

/** `Retry-After` in ms (seconds or an HTTP date), or undefined. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * Delay before retry number `attempt` (0 for the first retry): the server's
 * Retry-After when it sent one, else `base * 2^attempt` with jitter (50% to
 * 100% of that value). At most 60 seconds.
 */
export function retryDelay(attempt: number, base: number, retryAfterMs?: number, random: () => number = Math.random): number {
  if (retryAfterMs !== undefined) return Math.min(MAX_RETRY_DELAY, retryAfterMs);
  const exp = Math.min(MAX_RETRY_DELAY, base * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** The outcome of send(): a 413 for more than one event, with the failures so far. */
type SendResult = { tooLarge: false } | { tooLarge: true; attempt: number };

export class EventQueue {
  private queue: { event: WireEvent; bytes: number }[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopper = new AbortController();
  /** Smaller batches after a 413: halved on each 413, back to maxBatch after a 2xx. */
  private batchLimit = Infinity;

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly maxBatch: number;
  private readonly flushAt: number;
  private readonly flushInterval: number;
  private readonly maxQueueSize: number;
  private readonly maxQueueLength: number;
  private readonly retryCount: number;
  private readonly retryBase: number;
  private readonly timeout: number;
  private readonly fetcher: typeof fetch;
  private readonly log: (message: string) => void;
  private readonly random: () => number;

  constructor(options: QueueOptions) {
    this.url = options.url;
    this.headers = { 'content-type': 'application/json', ...options.headers };
    this.maxBatch = options.maxBatch;
    this.flushAt = clamp(options.flushAt ?? DEFAULT_FLUSH_AT, 1, this.maxBatch);
    this.flushInterval = clamp(options.flushInterval ?? DEFAULT_FLUSH_INTERVAL, MIN_FLUSH_INTERVAL, MAX_FLUSH_INTERVAL);
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
    this.retryCount = Math.max(0, Math.floor(options.retryCount ?? DEFAULT_RETRY_COUNT));
    this.retryBase = Math.max(0, options.retryDelay ?? DEFAULT_RETRY_DELAY);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== 'function') throw new Error('fetch is not available: use Node.js 20 or newer, or pass the fetch option');
    this.fetcher = fetcher;
    this.log = options.log ?? (() => {});
    this.random = options.random ?? Math.random;
  }

  /** Add an event. Starts a send when the queue reaches flushAt or maxQueueSize. */
  enqueue(event: WireEvent): void {
    if (this.queue.length >= this.maxQueueLength) {
      this.log(`queue is full (${this.maxQueueLength} events): dropped ${event.type} ${event.message_id}`);
      return;
    }
    const bytes = JSON.stringify(event).length;
    this.queue.push({ event, bytes });
    this.bytes += bytes;
    if (this.queue.length >= this.flushAt || this.bytes >= this.maxQueueSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.flushInterval);
    }
  }

  /**
   * Send every queued event. Resolves when they are sent or dropped. Never
   * rejects: failures go to the debug log.
   */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  /** Stop the timer and cancel waits and requests in progress. Queued events stay in memory. */
  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopper.abort();
  }

  get length(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    // The failure count of a batch that was halved after a 413 goes on to the next send.
    let attempt = 0;
    while (this.queue.length > 0 && !this.stopper.signal.aborted) {
      const items = this.queue.splice(0, Math.min(this.maxBatch, this.batchLimit));
      for (const item of items) this.bytes -= item.bytes;
      let result: SendResult = { tooLarge: false };
      try {
        result = await this.send(items.map(item => item.event), attempt);
      } catch (error) {
        // send() handles every expected failure. This is a bug guard.
        this.log(`send failed: ${(error as Error).message}`);
      }
      attempt = 0;
      if (result.tooLarge) {
        // 413 for more than one event: keep every event (same order, same
        // message_id) and send again at once with half the batch. Not a
        // failure: no backoff wait, and the failure count does not change.
        this.queue.unshift(...items);
        for (const item of items) this.bytes += item.bytes;
        this.batchLimit = Math.max(1, Math.floor(items.length / 2));
        this.log(`413: batch of ${items.length} events too large, sending ${this.batchLimit}`);
        attempt = result.attempt;
      }
    }
  }

  /**
   * POST one batch. The body is made once, so every retry sends the same
   * message_id values and the collector counts each event once.
   */
  private async send(events: WireEvent[], firstAttempt = 0): Promise<SendResult> {
    const body = JSON.stringify({ events });
    for (let attempt = firstAttempt; ; attempt++) {
      let retryAfter: number | undefined;
      let reason: string;
      try {
        const signal = AbortSignal.any([this.stopper.signal, AbortSignal.timeout(this.timeout)]);
        const response = await this.fetcher(this.url, { method: 'POST', headers: this.headers, body, signal });
        if (response.ok) {
          this.batchLimit = Infinity;
          // A body read or parse error never fails the send: the batch was accepted.
          const refused = refusedEvents(await response.text().catch(() => ''));
          if (refused) this.log(`dropped ${refused.rejected} of ${events.length} events: refused by the collector${refused.codes.length ? ` (${refused.codes.join(', ')})` : ''}`);
          return { tooLarge: false };
        }
        const text = await response.text().catch(() => '');
        // Too large: the queue halves the batch. A 413 for one event drops it below.
        if (response.status === 413 && events.length > 1) return { tooLarge: true, attempt };
        reason = `HTTP ${response.status}${text ? ` ${text.slice(0, 300)}` : ''}`;
        if (!isRetryableStatus(response.status)) {
          this.log(`dropped ${events.length} events: ${reason}`);
          return { tooLarge: false };
        }
        retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      } catch (error) {
        if (this.stopper.signal.aborted) {
          this.log(`dropped ${events.length} events: shutdown timed out`);
          return { tooLarge: false };
        }
        reason = `network error: ${(error as Error).message}`;
      }
      if (attempt >= this.retryCount) {
        this.log(`dropped ${events.length} events after ${attempt + 1} attempts: ${reason}`);
        return { tooLarge: false };
      }
      const delay = retryDelay(attempt, this.retryBase, retryAfter, this.random);
      this.log(`${reason}; retry ${attempt + 1} of ${this.retryCount} in ${delay} ms`);
      await this.sleep(delay);
      if (this.stopper.signal.aborted) {
        this.log(`dropped ${events.length} events: shutdown timed out`);
        return { tooLarge: false };
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const signal = this.stopper.signal;
      if (signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
