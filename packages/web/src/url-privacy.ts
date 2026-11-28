// The query string and the #fragment of a page URL, without the parameters
// that can hold a secret or a personal value. Keep in step with the collector
// (packages/shared/src/url-privacy.ts in the Manalens monorepo), which applies
// the same rules again, plus the project's "Remove these query parameters".
import { campaignKeys, clickNetworks } from './attribution-contract';

/** Names that are always removed (lower case). */
export const builtInExcludedQueryParams = [
  'token', 'access_token', 'refresh_token', 'id_token', 'auth_token', 'code', 'state', 'nonce', 'key', 'api_key', 'apikey',
  'secret', 'client_secret', 'password', 'pass', 'passwd', 'pwd', 'auth', 'authorization', 'credential', 'credentials',
  'session', 'session_id', 'sessionid', 'sid', 'jwt', 'signature', 'sig', 'hmac', 'otp', 'ticket', 'owns', 'email',
  'oauth_token', 'oauth_verifier', 'privy_oauth_code', 'privy_oauth_state', 'privy_oauth_provider', 'mana_hid',
] as const;
const builtIn = new Set<string>(builtInExcludedQueryParams);
const excludedNamePattern = /token|secret|passw|signature|api[_-]?key|^openid\./i;
/** Campaign parameters are sent as campaign fields, not in the URL. */
const campaignParams = new Set<string>([...campaignKeys, ...clickNetworks.map(([key]) => key), 'gad_source', 'ref', 'referral', 'referral_code'].map(name => name.toLowerCase()));

const secretPrefix = /^(cs_live_|cs_test_|sk_|rk_|whsec_|mana_sk_|mana_api_)/i;
const dotToken = /^[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{4,}){1,2}$/;
const email = /[^\s@/?#&=]+@[^\s@/?#&=]+\.[A-Za-z]{2,}/;
const steamId = /(?:^|\D)\d{17}(?:\D|$)/;
const tokenCharacters = /^[A-Za-z0-9_\-+/=.~%:]+$/;
const decode = (value: string): string => { try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; } };

/** True when a value looks like a secret or a personal value, whatever its name. */
export function looksLikeSecret(raw: string): boolean {
  const value = decode(raw).trim();
  if (!value) return false;
  if (secretPrefix.test(value)) return true;
  if (dotToken.test(value) && value.split('.').some(part => part.length >= 16)) return true;
  if (email.test(value) || steamId.test(value)) return true;
  return value.length > 64 && tokenCharacters.test(value);
}

function cleanPairs(text: string, extra: ReadonlySet<string>): string {
  const kept: string[] = [];
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const name = decode(at < 0 ? pair : pair.slice(0, at)).trim();
    const lower = name.toLowerCase();
    const value = at < 0 ? '' : pair.slice(at + 1);
    if (!name || builtIn.has(lower) || excludedNamePattern.test(lower) || extra.has(lower) || campaignParams.has(lower) || looksLikeSecret(value) || looksLikeSecret(name)) continue;
    kept.push(pair);
  }
  return kept.join('&');
}

/** The fragment to send (without `#`): kept pairs, or a plain fragment that passes the value check. */
export function cleanFragment(hash: string, extra: ReadonlySet<string>): string {
  const fragment = hash.replace(/^#/, '');
  if (!fragment) return '';
  if (!fragment.includes('=')) return looksLikeSecret(fragment) ? '' : fragment;
  const question = fragment.indexOf('?');
  const route = question >= 0 && question < fragment.indexOf('=') ? fragment.slice(0, question) : '';
  const pairs = cleanPairs(route ? fragment.slice(question + 1) : fragment, extra);
  const keptRoute = route && !looksLikeSecret(route) ? route : '';
  return keptRoute && pairs ? `${keptRoute}?${pairs}` : keptRoute || pairs;
}

/** The longest page URL the collector accepts. */
const maxUrlLength = 2048;

/**
 * The page URL and fragment to send: origin, path, and the query and the
 * fragment without the removed parameters. `excludedParams` is
 * tracking.excludeQueryParams. When the result is longer than the collector
 * accepts, the query and the fragment are left out.
 */
export function pageUrlParts(url: URL, path: string, excludedParams: readonly string[] = []): { url: string; hash?: string } {
  const extra = new Set(excludedParams.filter(name => typeof name === 'string').map(name => name.trim().toLowerCase()));
  const query = cleanPairs(url.search.replace(/^\?/, ''), extra);
  const fragment = cleanFragment(url.hash, extra);
  const hash = fragment ? `#${fragment}` : '';
  const full = `${url.origin}${path}${query ? `?${query}` : ''}${hash}`;
  if (full.length > maxUrlLength) return { url: `${url.origin}${path}` };
  return { url: full, ...(hash ? { hash } : {}) };
}
