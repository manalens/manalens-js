// Persistent first-party identity, adapted from getformo/sdk's
// src/event/utils.ts (generateAnonymousId / clearAnonymousId).
import { getCookie, identityCookieDomain, readLocal, removeCookie, removeLocal, setCookie, writeLocal } from './storage';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
/** A session ends after 30 minutes without an event. */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * A session is never older than this, also with continuous activity. The
 * collector's session rule does not use a client session of more than 24 hours.
 */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Page-lifetime fallback when cookies and localStorage are both unavailable. */
const volatile = new Map<string, string>();

function validId(value: string | undefined): string | undefined {
  return value && UUID.test(value) ? value : undefined;
}

/**
 * Write `value` to a first-party cookie. With cross-subdomain sharing the
 * cookie is apex-scoped; a rejected apex write retries host-only. When the
 * cookie sticks, fallback copies are discarded. When it does not, the value
 * goes to localStorage and then memory.
 */
function persist(key: string, value: string, maxAge: number, crossSubdomain: boolean): void {
  const domain = identityCookieDomain(crossSubdomain);
  setCookie(key, value, { maxAge, ...(domain ? { domain } : {}) });
  if (domain && getCookie(key) !== value) setCookie(key, value, { maxAge });
  if (getCookie(key) === value) {
    volatile.delete(key);
    if (readLocal(key)) removeLocal(key);
    return;
  }
  writeLocal(key, value);
  volatile.set(key, value);
}

/** Read the anonymous ID (cookie, then localStorage, then memory) or create one, and re-persist it. */
export function generateAnonymousId(key: string, crossSubdomain: boolean): string {
  const id = validId(getCookie(key)) ?? validId(readLocal(key)) ?? validId(volatile.get(key)) ?? crypto.randomUUID();
  // Re-setting on every read refreshes the one-year expiry and migrates a
  // legacy host-only cookie to the apex domain when cross-subdomain is on.
  persist(key, id, ONE_YEAR_SECONDS, crossSubdomain);
  return id;
}

/** Clear the anonymous ID from every storage layer. */
export function clearAnonymousId(key: string): void {
  removeCookie(key);
  removeLocal(key);
  volatile.delete(key);
}

/**
 * The stored session when it is still current: at most 30 minutes since the
 * last activity and less than 24 hours since its start. A value in the format
 * of pre-release SDK builds (`<uuid>.<last activity ms>`, no start time) is not
 * current, so the first event after an SDK update starts a new session.
 */
function storedSession(key: string, now: number): { id: string; startedAt: number } | undefined {
  for (const raw of [getCookie(key), readLocal(key), volatile.get(key)]) {
    const [id, at, start] = raw?.split('.') ?? [];
    const last = Number(at);
    const startedAt = Number(start);
    const active = Number.isFinite(last) && last > now - SESSION_TIMEOUT_MS && last <= now + 60_000;
    const young = start !== undefined && start !== '' && Number.isFinite(startedAt) && startedAt > now - SESSION_MAX_AGE_MS && startedAt <= now + 60_000;
    if (id && validId(id) && active && young) return { id, startedAt };
  }
  return undefined;
}

/**
 * Read the current session ID or start a new one, then record activity. A new
 * session starts after 30 minutes without an event, and when the session is
 * 24 hours old. Stored as `<uuid>.<last activity ms>.<start ms>` with a
 * rolling 30-minute cookie and the same localStorage / memory fallbacks as
 * the anonymous ID.
 */
export function touchSessionId(key: string, crossSubdomain: boolean, now = Date.now()): string {
  return touchSession(key, crossSubdomain, now).id;
}

/** touchSessionId() with the session's start time (game mode measures `duration_s` from it). */
export function touchSession(key: string, crossSubdomain: boolean, now = Date.now()): { id: string; startedAt: number } {
  const session = storedSession(key, now) ?? { id: crypto.randomUUID(), startedAt: now };
  persist(key, `${session.id}.${now}.${session.startedAt}`, SESSION_TIMEOUT_MS / 1000, crossSubdomain);
  return session;
}

/** The stored session ID when it is still current, else undefined. Never starts one. */
export function readSessionId(key: string, now = Date.now()): string | undefined {
  return storedSession(key, now)?.id;
}

/**
 * The session ID that the next event will have. It does not count as
 * activity: a current session is returned as stored; only when there is none
 * does this start one.
 */
export function currentSessionId(key: string, crossSubdomain: boolean, now = Date.now()): string {
  return storedSession(key, now)?.id ?? touchSessionId(key, crossSubdomain, now);
}

export const clearSessionId = clearAnonymousId;

/** Like Formo's `user-id` key: a browser-session cookie, cleared by reset(). */
export function readUserId(key: string): string | undefined {
  const value = getCookie(key);
  return value && value.length <= 255 ? value : undefined;
}

export function writeUserId(key: string, userId: string, crossSubdomain: boolean): void {
  const domain = identityCookieDomain(crossSubdomain);
  setCookie(key, userId, domain ? { domain } : {});
}

export function clearUserId(key: string): void { removeCookie(key); }

/** Persistent opt-out flag: one-year cookie plus a localStorage copy. */
export function readOptOut(key: string): boolean {
  return getCookie(key) === 'true' || readLocal(key) === 'true';
}

export function writeOptOut(key: string, optedOut: boolean, crossSubdomain: boolean): void {
  if (!optedOut) { removeCookie(key); removeLocal(key); return; }
  const domain = identityCookieDomain(crossSubdomain);
  setCookie(key, 'true', { maxAge: ONE_YEAR_SECONDS, ...(domain ? { domain } : {}) });
  writeLocal(key, 'true');
}

/** Test hook: forget page-lifetime memory, as a new page load would. */
export function __resetIdentityMemory(): void { volatile.clear(); }
