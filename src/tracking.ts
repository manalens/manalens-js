// Tracking rules: hosts, paths and timezones where the SDK sends nothing.
// Adapted from getformo/sdk's TrackingPolicy (without chain rules).

export interface TrackingOptions {
  /**
   * Hostnames where nothing is sent, matched case-insensitively. An entry is
   * an exact host (`staging.example.com`) or a `*.` wildcard for subdomains
   * (`*.vercel.app` matches `app-git-x.vercel.app`, not `vercel.app`).
   */
  excludeHosts?: string[];
  /**
   * Paths where nothing is sent. An entry is an exact path (`/admin`) or a
   * prefix ending in `/*` (`/admin/*` matches `/admin` and every path under it).
   * Checked for each event, so a SPA can leave an excluded path and send again.
   */
  excludePaths?: string[];
  /**
   * IANA timezones (e.g. `Europe/London`) whose visitors are not tracked at
   * all: no events and no identity storage, and an existing identity is
   * deleted. Case-insensitive. Best effort: a visitor can change the timezone.
   */
  excludeTimezones?: string[];
}

/** Collapse repeated slashes, decode percent-escapes and drop a trailing slash, so `/%61dmin//x/` equals `/admin/x`. */
function normalizePath(path: string): string {
  let value = path;
  try { value = decodeURIComponent(value); } catch { /* keep a malformed escape as is */ }
  value = value.replace(/\/{2,}/g, '/');
  if (!value.startsWith('/')) value = `/${value}`;
  return value !== '/' ? value.replace(/\/+$/, '') || '/' : '/';
}

/** Lowercase, without a trailing dot, and in punycode (as location.hostname is). */
function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase().replace(/\.$/, '');
  if (/^[\x00-\x7f]*$/.test(value)) return value;
  try { return new URL(`http://${value}`).hostname; } catch { return value; }
}

export function hostExcluded(hostname: string, patterns: readonly string[] = []): boolean {
  const host = normalizeHost(hostname);
  return patterns.some(raw => {
    if (typeof raw !== 'string') return false;
    const trimmed = raw.trim();
    if (trimmed.startsWith('*.')) {
      const suffix = `.${normalizeHost(trimmed.slice(2))}`;
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === normalizeHost(trimmed);
  });
}

export function pathExcluded(pathname: string, patterns: readonly string[] = []): boolean {
  const path = normalizePath(pathname);
  return patterns.some(raw => {
    if (typeof raw !== 'string' || !raw) return false;
    if (raw.endsWith('/*')) {
      const prefix = normalizePath(raw.slice(0, -2) || '/');
      return prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);
    }
    return path === normalizePath(raw);
  });
}

export function currentTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

/** Renamed IANA zones; engines disagree on which name is canonical. */
const TIMEZONE_ALIASES: readonly (readonly string[])[] = [
  ['Asia/Kolkata', 'Asia/Calcutta'], ['Europe/Kyiv', 'Europe/Kiev'], ['Asia/Ho_Chi_Minh', 'Asia/Saigon'],
  ['Asia/Yangon', 'Asia/Rangoon'], ['America/Nuuk', 'America/Godthab'], ['Pacific/Kanton', 'Pacific/Enderbury'],
  ['Asia/Kathmandu', 'Asia/Katmandu'], ['Atlantic/Faroe', 'Atlantic/Faeroe'], ['Pacific/Chuuk', 'Pacific/Truk'],
  ['Pacific/Pohnpei', 'Pacific/Ponape'], ['America/Argentina/Buenos_Aires', 'America/Buenos_Aires'],
  ['America/Indiana/Indianapolis', 'America/Indianapolis'], ['America/Kentucky/Louisville', 'America/Louisville'],
  ['Asia/Dhaka', 'Asia/Dacca'], ['Asia/Thimphu', 'Asia/Thimbu'], ['Asia/Ulaanbaatar', 'Asia/Ulan_Bator'],
  ['UTC', 'Etc/UTC', 'Etc/UCT', 'UCT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu', 'Etc/GMT', 'GMT'],
];

/** Every lowercase name of a zone: as given, the engine's canonical name, and known aliases. */
function timezoneNames(zone: string): Set<string> {
  const names = new Set<string>([zone]);
  try { names.add(new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone); } catch { /* unknown zone */ }
  for (const name of [...names]) for (const group of TIMEZONE_ALIASES) if (group.some(alias => alias.toLowerCase() === name.toLowerCase())) group.forEach(alias => names.add(alias));
  return new Set([...names].map(name => name.toLowerCase()));
}

export function timezoneExcluded(patterns: readonly string[] = [], timezone = currentTimezone()): boolean {
  if (!timezone || patterns.length === 0) return false;
  const visitor = timezoneNames(timezone);
  return patterns.some(tz => typeof tz === 'string' && [...timezoneNames(tz.trim())].some(name => visitor.has(name)));
}
