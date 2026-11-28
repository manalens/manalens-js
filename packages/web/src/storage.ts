// First-party storage helpers, adapted from getformo/sdk's src/storage
// (CookieStorage, cookiePolicy) and src/utils/domain.ts.

export interface CookieOptions {
  /** Seconds. Omit both maxAge and expires for a browser-session cookie. */
  maxAge?: number;
  expires?: string;
  domain?: string;
}

const PREFIX = 'mana';
const PROBE = '__mana_domain_probe';
const EXPIRED = 'Thu, 01 Jan 1970 00:00:00 GMT';

/** Short, stable FNV-1a hash so cookie names never contain the raw publishable key. */
function hashKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Project-scoped storage key, e.g. `mana_1a2b3c4d_anonymous-id`. */
export function storageKey(publishableKey: string, name: string): string {
  return `${PREFIX}_${hashKey(publishableKey)}_${name}`;
}

/** The page is served over http or https (a website, or a web export on a host). */
export function isHttpPage(): boolean {
  return typeof location === 'undefined' || location.protocol === 'http:' || location.protocol === 'https:';
}

/**
 * Installed-app pages (`app://`, `file://`, `capacitor://` ...) with the app
 * option: cookies are not used at all. Browsers often refuse or drop cookies
 * on a custom scheme, so identity goes to localStorage (then memory) there.
 * An SDK instance with the app option turns it on; it never applies to an
 * http or https page.
 */
let appPageCookiesOff = false;

/** Use no cookies on this installed-app page. */
export function turnCookiesOffOnAppPage(): void { appPageCookiesOff = true; }

/** True when the SDK uses no cookies on this page. */
export function cookiesAreOff(): boolean { return appPageCookiesOff && !isHttpPage(); }

function readCookieJar(): string {
  if (cookiesAreOff()) return '';
  try { return typeof document !== 'undefined' && typeof document.cookie === 'string' ? document.cookie : ''; } catch { return ''; }
}

function writeCookieJar(value: string): void {
  if (cookiesAreOff()) return;
  try { if (typeof document !== 'undefined') document.cookie = value; } catch { /* Cookies blocked. */ }
}

let apexCache: { host: string; domain: string | null } | undefined;

/**
 * Registrable (apex) domain found by probing: the shortest candidate the
 * browser accepts a cookie on. Null on localhost, IPs, single-label hosts and
 * public-suffix hosts. Cached per hostname.
 */
export function getApexDomain(): string | null {
  if (cookiesAreOff() || typeof window === 'undefined' || typeof location === 'undefined') return null;
  const host = location.hostname;
  if (apexCache?.host === host) return apexCache.domain;
  let domain: string | null = null;
  const parts = host.split('.');
  if (host !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(':') && !host.startsWith('[') && parts.length >= 2) {
    for (let i = 2; i <= parts.length; i++) {
      const candidate = parts.slice(-i).join('.');
      writeCookieJar(`${PROBE}=probe; domain=.${candidate}; path=/; max-age=10`);
      const accepted = readCookieJar().indexOf(`${PROBE}=probe`) !== -1;
      writeCookieJar(`${PROBE}=; domain=.${candidate}; path=/; max-age=0`);
      if (accepted) { domain = candidate; break; }
    }
  }
  apexCache = { host, domain };
  return domain;
}

/** `.example.com` when cross-subdomain sharing is on and an apex exists, else host-only. */
export function identityCookieDomain(crossSubdomain: boolean): string {
  if (!crossSubdomain) return '';
  const domain = getApexDomain();
  return domain ? `.${domain}` : '';
}

export function getCookie(key: string): string | undefined {
  const match = readCookieJar().match(new RegExp(`(?:^|; )${encodeURIComponent(key)}=([^;]*)`));
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!) || undefined; } catch { return undefined; }
}

export function setCookie(key: string, value: string, options: CookieOptions = {}): void {
  const name = encodeURIComponent(key);
  // Expire the other scope so a stale host-only or apex cookie cannot shadow this one.
  if (options.domain) writeCookieJar(`${name}=; expires=${EXPIRED}; path=/`);
  else {
    const apex = getApexDomain();
    if (apex) writeCookieJar(`${name}=; expires=${EXPIRED}; path=/; domain=.${apex}`);
  }
  let cookie = `${name}=${encodeURIComponent(value)}; path=/`;
  if (options.maxAge) cookie += `; max-age=${options.maxAge}`;
  else if (options.expires) cookie += `; expires=${options.expires}`;
  if (options.domain) cookie += `; domain=${options.domain}`;
  // SameSite=Lax keeps identity on inbound top-level navigations. Secure only
  // on HTTPS, because browsers reject Secure cookies over plain HTTP.
  cookie += '; samesite=lax';
  if (typeof location !== 'undefined' && location.protocol === 'https:') cookie += '; secure';
  writeCookieJar(cookie);
}

export function removeCookie(key: string): void {
  const name = encodeURIComponent(key);
  writeCookieJar(`${name}=; path=/; expires=${EXPIRED}`);
  const apex = getApexDomain();
  if (apex) writeCookieJar(`${name}=; path=/; domain=.${apex}; expires=${EXPIRED}`);
}

function localStore(): Storage | undefined {
  try { return typeof window !== 'undefined' ? window.localStorage ?? undefined : undefined; } catch { return undefined; }
}

export function readLocal(key: string): string | undefined {
  try { const value = localStore()?.getItem(key); return typeof value === 'string' && value ? value : undefined; } catch { return undefined; }
}

export function writeLocal(key: string, value: string): void {
  try { localStore()?.setItem(key, value); } catch { /* Storage unavailable. */ }
}

export function removeLocal(key: string): void {
  try { localStore()?.removeItem(key); } catch { /* Storage unavailable. */ }
}

function sessionStore(): Storage | undefined {
  try { return typeof window !== 'undefined' ? window.sessionStorage ?? undefined : undefined; } catch { return undefined; }
}

/** sessionStorage: the user ID on installed-app pages, where the SDK uses no cookies. */
export function readSession(key: string): string | undefined {
  try { const value = sessionStore()?.getItem(key); return typeof value === 'string' && value ? value : undefined; } catch { return undefined; }
}

export function writeSession(key: string, value: string): void {
  try { sessionStore()?.setItem(key, value); } catch { /* Storage unavailable. */ }
}

export function removeSession(key: string): void {
  try { sessionStore()?.removeItem(key); } catch { /* Storage unavailable. */ }
}

/** Test hook: forget the cached apex domain. */
export function __resetApexDomainCache(): void { apexCache = undefined; }
