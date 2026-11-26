import { clickNetworks, safeCampaign } from './attribution-contract';
import { storageKey } from './storage';

/**
 * Ad click IDs (gclid, fbclid, li_fat_id, msclkid and the other networks in
 * clickNetworks) kept in a first-party cookie for 90 days, so a server can
 * save them on an account or an order when the visitor signs up or pays,
 * after the ad network's own cookie is gone.
 *
 * The cookie keeps the latest ID per network and the time of the latest
 * click. Its name is project-scoped: `clickIdsCookieName(publishableKey)`.
 * Its value is URL-encoded JSON, for example
 * `{"gclid":"EAIaIQ","captured_at":"2026-11-26T10:00:00.000Z"}`.
 */
export const CLICK_IDS_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export type ClickIdKey = (typeof clickNetworks)[number][0];
export type ClickIds = Partial<Record<ClickIdKey, string>> & {
  /** ISO time of the latest click. */
  captured_at: string;
};

const clickIdKeys = clickNetworks.map(([key]) => key);
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** The cookie name for a project, e.g. `mana_1a2b3c4d_click-ids`. Use it on your server to read the cookie. */
export function clickIdsCookieName(publishableKey: string): string {
  return storageKey(publishableKey, 'click-ids');
}

/** The click IDs in a URL. Unsafe or too long values, and excluded parameters, are left out. */
export function clickIdsFromUrl(url: URL, excludedParams: readonly string[] = []): Partial<Record<ClickIdKey, string>> {
  const excluded = new Set(excludedParams.filter(name => typeof name === 'string').map(name => name.trim().toLowerCase()));
  const ids: Partial<Record<ClickIdKey, string>> = {};
  for (const key of clickIdKeys) {
    if (excluded.has(key.toLowerCase())) continue;
    const value = safeCampaign(url.searchParams.get(key));
    if (value) ids[key] = value;
  }
  return ids;
}

/**
 * Reads the cookie value: the raw value from a Cookie header (URL-encoded) or
 * the decoded JSON. Unknown keys and unsafe values are left out. Undefined
 * when nothing is usable. Safe to call on a server.
 */
export function parseClickIds(value: string | null | undefined): ClickIds | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(value.trimStart().startsWith('{') ? value : decodeURIComponent(value)); } catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const ids: Partial<Record<ClickIdKey, string>> = {};
  for (const key of clickIdKeys) {
    const id = safeCampaign(input[key]);
    if (id) ids[key] = id;
  }
  const at = input.captured_at;
  if (typeof at !== 'string' || !isoTime.test(at) || Number.isNaN(Date.parse(at)) || !Object.keys(ids).length) return undefined;
  return { ...ids, captured_at: at };
}

/**
 * The cookie JSON after a page load, or undefined when the URL has no click
 * ID (the cookie stays as it is). A new ID replaces the one of its network;
 * IDs of other networks are kept.
 */
export function nextClickIds(url: URL, stored: string | undefined, excludedParams: readonly string[] = [], now: Date = new Date()): string | undefined {
  const fresh = clickIdsFromUrl(url, excludedParams);
  if (!Object.keys(fresh).length) return undefined;
  const { captured_at: _old, ...kept } = parseClickIds(stored) ?? { captured_at: '' };
  return JSON.stringify({ ...kept, ...fresh, captured_at: now.toISOString() });
}
