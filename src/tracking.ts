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

const normalizePath = (path: string) => (path !== '/' ? path.replace(/\/+$/, '') : '/') || '/';

export function hostExcluded(hostname: string, patterns: readonly string[] = []): boolean {
  const host = hostname.toLowerCase();
  return patterns.some(raw => {
    if (typeof raw !== 'string') return false;
    const pattern = raw.trim().toLowerCase();
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
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

export function timezoneExcluded(patterns: readonly string[] = [], timezone = currentTimezone()): boolean {
  if (!timezone || patterns.length === 0) return false;
  const zone = timezone.toLowerCase();
  return patterns.some(tz => typeof tz === 'string' && tz.toLowerCase() === zone);
}
