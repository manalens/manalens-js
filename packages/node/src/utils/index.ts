import { randomUUID } from 'node:crypto';

export { randomUUID };

/** ISO 8601 UTC timestamp from a Date, a date string or now. Returns null for an invalid date. */
export function isoTimestamp(value: Date | string | undefined, now: number): string | null {
  if (value === undefined) return new Date(now).toISOString();
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** Copy an object without its undefined values. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/**
 * API URL for `/v0/link`: the apiEndpoint option, or the endpoint with an
 * `events.` host changed to `api.` (other hosts serve both paths).
 */
export function linkUrl(endpoint: string, apiEndpoint?: string): string {
  const base = new URL(eventsUrl(apiEndpoint ?? endpoint).replace(/\/v0\/events$/, ''));
  if (!apiEndpoint && base.hostname.startsWith('events.')) base.hostname = `api.${base.hostname.slice('events.'.length)}`;
  return `${base.toString().replace(/\/+$/, '')}/v0/link`;
}

/**
 * Collector URL for `/v0/events`. Accepts the base URL with or without a
 * trailing slash or `/v0/events`.
 */
export function eventsUrl(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('endpoint must be a URL, for example https://collect.example.com'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('endpoint must use https or http');
  const base = url.toString().replace(/\/+$/, '').replace(/\/v0\/events$/, '');
  return `${base}/v0/events`;
}
