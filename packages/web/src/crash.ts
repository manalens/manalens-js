// Crash at the next load (P-2835), as in the game SDKs (sdks/SPEC.md "Crash":
// game_crash at the next launch, only when the last saved session was open and
// focused). A browser gives no event when a tab crashes (for example out of
// memory), but it gives `pagehide` on a normal close, reload or navigation.
// So each tab of the game keeps a "session open" entry in localStorage while
// its game session is open, and removes it on `pagehide`. An entry that is
// still there at the next load, of a tab that had focus, is a crash.
//
// Several tabs of the same game share the storage, so each tab has its own
// entry, and a tab writes its entry again every CRASH_HEARTBEAT_MS. An entry
// that is newer than CRASH_ALIVE_MS can be a tab that is still open: the new
// tab looks at it again after CRASH_ALIVE_MS.
import { readLocal, removeLocal, writeLocal } from './storage';

/** A tab writes its entry this often (and on focus, blur and visibility changes). */
export const CRASH_HEARTBEAT_MS = 5000;
/** An entry not written for this long is of a tab that is gone. */
export const CRASH_ALIVE_MS = 20_000;
/** Entries of unfocused tabs that are gone are removed after this time. */
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_TABS = 10;

export interface TabEntry {
  /** The game session of the tab. */
  session_id: string;
  /** The identity of the session: game_crash is sent only for this anonymous ID, with this user ID. */
  anonymous_id: string;
  user_id?: string;
  /** The last write (ms since the epoch). */
  at: number;
  /** The page was visible and had focus at the last write. */
  focused: boolean;
  build?: string;
  app_version?: string;
  /** The message_id of the last `game_hang` error of this session (P-2833). */
  hang_message_id?: string;
}

export type TabEntries = Record<string, TabEntry>;

const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 64;

/** The entries in storage; a broken value gives none. */
export function readTabs(key: string): TabEntries {
  const raw = readLocal(key);
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const tabs: TabEntries = {};
  for (const [tab, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = value as Partial<TabEntry> | null;
    if (!id(tab) || !entry || typeof entry !== 'object' || !id(entry.session_id) || !id(entry.anonymous_id) || typeof entry.at !== 'number' || !Number.isFinite(entry.at)) continue;
    tabs[tab] = {
      session_id: entry.session_id!,
      anonymous_id: entry.anonymous_id!,
      ...(typeof entry.user_id === 'string' && entry.user_id && entry.user_id.length <= 255 ? { user_id: entry.user_id } : {}),
      at: entry.at,
      focused: entry.focused === true,
      ...(typeof entry.build === 'string' && entry.build ? { build: entry.build.slice(0, 64) } : {}),
      ...(typeof entry.app_version === 'string' && entry.app_version ? { app_version: entry.app_version.slice(0, 32) } : {}),
      ...(id(entry.hang_message_id) ? { hang_message_id: entry.hang_message_id } : {}),
    };
  }
  return tabs;
}

/** Write the entries; the newest MAX_TABS stay. No entries removes the key. */
export function writeTabs(key: string, tabs: TabEntries): void {
  const kept = Object.entries(tabs).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_TABS);
  if (!kept.length) { removeLocal(key); return; }
  writeLocal(key, JSON.stringify(Object.fromEntries(kept)));
}

/** Write the entry of one tab, and keep the entries of the other tabs. */
export function writeTab(key: string, tab: string, entry: TabEntry): void {
  const tabs = readTabs(key);
  tabs[tab] = entry;
  writeTabs(key, tabs);
}

/** Remove the entry of one tab: its session ended cleanly. */
export function removeTab(key: string, tab: string): void {
  const tabs = readTabs(key);
  if (!(tab in tabs)) return;
  delete tabs[tab];
  writeTabs(key, tabs);
}

/**
 * The entries of other tabs that crashed (focused and not written for
 * CRASH_ALIVE_MS), which are removed from storage, and the focused entries
 * that can still be open tabs (`fresh`). Entries of unfocused tabs that are
 * gone are removed after 24 hours; they are never a crash.
 */
export function takeCrashed(key: string, self: string, now: number): { crashed: TabEntry[]; fresh: Record<string, number> } {
  const tabs = readTabs(key);
  const crashed: TabEntry[] = [];
  const fresh: Record<string, number> = {};
  let changed = false;
  for (const [tab, entry] of Object.entries(tabs)) {
    if (tab === self) continue;
    const age = now - entry.at;
    if (entry.focused && age >= CRASH_ALIVE_MS) { crashed.push(entry); delete tabs[tab]; changed = true; }
    else if (entry.focused) fresh[tab] = entry.at;
    else if (age >= STALE_MS) { delete tabs[tab]; changed = true; }
  }
  if (changed) writeTabs(key, tabs);
  return { crashed, fresh };
}

/** A second look at entries that were fresh: the ones not written since are crashes (removed from storage). */
export function takeStillSilent(key: string, fresh: Record<string, number>): TabEntry[] {
  const tabs = readTabs(key);
  const crashed: TabEntry[] = [];
  for (const [tab, at] of Object.entries(fresh)) {
    const entry = tabs[tab];
    if (!entry || !entry.focused || entry.at !== at) continue;
    crashed.push(entry);
    delete tabs[tab];
  }
  if (crashed.length) writeTabs(key, tabs);
  return crashed;
}
