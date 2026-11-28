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
const decodeOnce = (value: string): string => { try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; } };
/** The value, decoded once and twice (a value can hold an encoded URL or encoded pairs). */
const decodings = (value: string): string[] => { const once = decodeOnce(value); return [value, once, decodeOnce(once)]; };
const decode = decodeOnce;

/**
 * True when a value looks like a secret or a personal value, whatever its
 * parameter name: a Stripe or Manalens secret prefix (`cs_live_`, `cs_test_`,
 * `sk_`, `rk_`, `whsec_`, `mana_sk_`), a JWT or a signed `xxx.yyy(.zzz)`
 * token, an email address, a 17-digit SteamID, or a random-looking string
 * over 64 characters. The raw value and its decoded forms are checked.
 */
export function looksLikeSecret(raw: string): boolean {
  return decodings(raw).some(form => {
    const value = form.trim();
    if (!value) return false;
    if (secretPrefix.test(value)) return true;
    if (dotToken.test(value) && value.split('.').some(part => part.length >= 16)) return true;
    if (email.test(value) || steamId.test(value)) return true;
    return value.length > 64 && tokenCharacters.test(value);
  });
}

/**
 * True when a decoded value holds URL structure, which can carry a secret
 * under another name (`?next=https%3A%2F%2Fx%2F%3Ftoken%3Dabc`, `?r=a%3Db%26code%3D1`):
 * `://`, or `?`, `&` or `;` together with `=`. Such a value is removed whole.
 */
function holdsUrlStructure(raw: string): boolean {
  return decodings(raw).some(value => value.includes('://') || (/[?&;]/.test(value) && value.includes('=')));
}

/** The pairs of a query string or a fragment (separated by `&` or `;`), without the parameters the rules remove. Pure. */
function cleanPairs(text: string, extra: ReadonlySet<string>): string {
  const kept: string[] = [];
  for (const pair of text.split(/[&;]/)) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const rawName = at < 0 ? pair : pair.slice(0, at);
    const name = decode(rawName).trim();
    const value = at < 0 ? '' : pair.slice(at + 1);
    if (!name || builtIn.has(name.toLowerCase()) || excludedNamePattern.test(name.toLowerCase()) || extra.has(name.toLowerCase()) || campaignParams.has(name.toLowerCase()) || looksLikeSecret(value) || looksLikeSecret(rawName) || holdsUrlStructure(value)) continue;
    kept.push(pair);
  }
  return kept.join('&');
}

const uuid = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/**
 * True for a path segment that looks like an identifier or a secret: a UUID,
 * hex of 16 or more characters, a mixed letter and digit ID (mixedId),
 * 6 or more digits, or what looksLikeSecret finds (a token, JWT, email or SteamID).
 */
/** 20 or more base64url characters with a digit, or 10 or more with 3 digits and 3 letters (`abc123def456`). */
const mixedId = (value: string): boolean => /^[A-Za-z0-9_-]+$/.test(value) && /\d/.test(value)
  && (value.length >= 20 || (value.length >= 10 && (value.match(/\d/g) || []).length >= 3 && (value.match(/[A-Za-z]/g) || []).length >= 3));
function identifierSegment(raw: string): boolean {
  const value = decode(raw);
  // Token characters: `+`, `=`, `%`, `~` in a segment of 8 or more characters, or `.` too in one over 12 (base64 parts, signed values).
  return uuid.test(value) || /^[0-9a-f]{16,}$/i.test(value) || mixedId(value) || (value.length >= 8 && /[+=%~]/.test(raw)) || (value.length > 12 && /[+=%~.]/.test(raw)) || /^\d{6,}$/.test(value) || looksLikeSecret(raw);
}

/** A path-like part (`/letters/abc123def456`): each identifier segment becomes `:id`; route words stay. */
function cleanSegments(path: string): string {
  return path.split('/').map(segment => (segment && identifierSegment(segment) ? ':id' : segment)).join('/');
}

/** The query string (without `?`) to store: the URL's query without the removed parameters. */
/**
 * The fragment (without `#`) to store. A fragment of `key=value` pairs
 * (`#l=hello&x=1`, or a route then pairs: `#/play?l=hello`) keeps the pairs
 * that pass the rules. Any other fragment is kept with each identifier
 * segment replaced by `:id` (`#/letters/:id`); a one-segment fragment that
 * is an identifier or a secret, or a fragment with a URL in it, is removed.
 * Empty when nothing is kept.
 */
export function cleanFragment(hash: string, extra: ReadonlySet<string>): string {
  const fragment = hash.replace(/^#/, '');
  if (!fragment || decodings(fragment).some(value => value.includes('://'))) return '';
  // Pairs have a `=` before a value; a `=` only at the end is base64 padding, not a pair.
  if (!/=[^=]/.test(fragment)) {
    // The whole fragment first: a secret can hold `/` (base64) and pass segment by segment.
    if (looksLikeSecret(fragment)) return '';
    if (!fragment.includes('/')) return identifierSegment(fragment) ? '' : fragment;
    return cleanSegments(fragment);
  }
  const question = fragment.indexOf('?');
  const route = question >= 0 && question < fragment.search(/=(?![=?]|$)/) ? fragment.slice(0, question) : '';
  const pairs = cleanPairs(route ? fragment.slice(question + 1) : fragment, extra);
  const keptRoute = route && !looksLikeSecret(route) ? cleanSegments(route) : '';
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
