// Optional persistent queue (G-2526): unsent events survive a crash, a lost
// GPU context or a tab closed offline, as in the Godot and Unity SDKs. Events
// go to IndexedDB, else to localStorage. Same caps as the game SDKs: 1000
// events, and no event older than max_event_age_s (sdks/SPEC.md).
import { readLocal, removeLocal, writeLocal } from './storage';
import type { AnalyticsEvent } from './types';

export const PERSIST_MAX_EVENTS = 1000;
/** sdks/SPEC.md max_event_age_s: a little under the collector's 7 days. */
export const PERSIST_MAX_AGE_MS = 601_200 * 1000;

const STORE = 'events';

interface Entry { id: string; seq: number; event: AnalyticsEvent }

type Backend = 'idb' | 'local';

function idbFactory(): IDBFactory | undefined {
  try { return typeof indexedDB !== 'undefined' ? indexedDB : undefined; } catch { return undefined; }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
}

/**
 * A copy of the unsent events on disk. The SDK keeps sending from memory; this
 * copy is read once on the next load. All operations run one after another,
 * in call order, and never throw.
 */
export class PersistentQueue {
  private readonly entries = new Map<string, Entry>();
  private ops: Promise<unknown> = Promise.resolve();
  private backend: Backend = 'local';
  private db?: Promise<IDBDatabase | undefined>;
  private seq = 0;
  /** A change not yet written to localStorage. */
  private localDirty = false;

  constructor(private readonly name: string) {}

  /** Read the stored events: in order, at most 1000, none too old. */
  load(now = Date.now()): Promise<AnalyticsEvent[]> {
    return this.run(async () => {
      let stored: Entry[] = [];
      const db = await this.open();
      if (db) {
        try { stored = await request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll()) as Entry[]; } catch { this.backend = 'local'; }
      }
      // Events stored while IndexedDB was not available are read too.
      stored = stored.concat(readLocalEntries(this.name));
      // Events put since load() was called are newer: they stay after the stored ones.
      const fresh = [...this.entries.values()];
      this.entries.clear();
      for (const entry of stored.sort((a, b) => a.seq - b.seq)) {
        if (!entry?.id || !entry.event || this.entries.has(entry.id)) continue;
        const at = Date.parse(entry.event.original_timestamp);
        if (!Number.isFinite(at) || at < now - PERSIST_MAX_AGE_MS) continue;
        this.entries.set(entry.id, entry);
        this.seq = Math.max(this.seq, entry.seq);
      }
      const restored = [...this.entries.keys()].length;
      for (const entry of fresh) { this.entries.delete(entry.id); this.entries.set(entry.id, entry); }
      this.trim();
      if (restored !== stored.length || this.entries.size !== restored) await this.rewrite();
      const freshIds = new Set(fresh.map(entry => entry.id));
      return [...this.entries.values()].filter(entry => !freshIds.has(entry.id)).map(entry => entry.event);
    }, []);
  }

  /** Store events (new ones, or new versions of stored ones with the same message_id). */
  put(events: AnalyticsEvent[]): void {
    if (!events.length) return;
    const changed: Entry[] = events.map(event => {
      const existing = this.entries.get(event.message_id);
      const entry = { id: event.message_id, seq: existing?.seq ?? (this.seq = Math.max(this.seq + 1, Date.now() * 1000)), event };
      this.entries.set(entry.id, entry);
      return entry;
    });
    const dropped = this.trim();
    this.localDirty = true;
    void this.run(async () => {
      const db = await this.open();
      if (db && this.backend === 'idb') {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          for (const entry of changed) if (this.entries.has(entry.id)) store.put(entry);
          for (const id of dropped) store.delete(id);
          await done(tx);
          return;
        } catch { this.backend = 'local'; }
      }
      this.writeLocal();
    }, undefined);
  }

  /** Remove events that the collector accepted, or that were dropped for good. */
  remove(ids: string[]): void {
    const removed = ids.filter(id => this.entries.delete(id));
    if (!removed.length) return;
    this.localDirty = true;
    void this.run(async () => {
      const db = await this.open();
      if (db && this.backend === 'idb') {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          for (const id of removed) tx.objectStore(STORE).delete(id);
          await done(tx);
          return;
        } catch { this.backend = 'local'; }
      }
      this.writeLocal();
    }, undefined);
  }

  /** Delete every stored event (optOut(), setConsent(false), an excluded timezone). */
  clear(): Promise<void> {
    this.entries.clear();
    return this.run(async () => {
      removeLocal(this.name);
      const db = await this.open();
      if (!db) return;
      try { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); await done(tx); } catch { /* Nothing more to delete. */ }
    }, undefined);
  }

  /** Waits until every operation called so far is done (tests, and before a reload). */
  settled(): Promise<void> { return this.ops.then(() => undefined); }

  /** Over 1000 events: drop the oldest. Returns the dropped IDs. */
  private trim(): string[] {
    const dropped: string[] = [];
    for (const id of this.entries.keys()) {
      if (this.entries.size <= PERSIST_MAX_EVENTS) break;
      this.entries.delete(id);
      dropped.push(id);
    }
    return dropped;
  }

  /** localStorage holds the whole queue as one value: write it once for the changes made so far. */
  private writeLocal(): void {
    if (!this.localDirty) return;
    this.localDirty = false;
    writeLocalEntries(this.name, [...this.entries.values()]);
  }

  private async rewrite(): Promise<void> {
    const db = await this.open();
    if (db && this.backend === 'idb') {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.clear();
        for (const entry of this.entries.values()) store.put(entry);
        await done(tx);
        removeLocal(this.name);
        return;
      } catch { this.backend = 'local'; }
    }
    writeLocalEntries(this.name, [...this.entries.values()]);
  }

  private open(): Promise<IDBDatabase | undefined> {
    this.db ??= (async () => {
      const factory = idbFactory();
      if (!factory) return undefined;
      try {
        const req = factory.open(this.name, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
        const db = await request(req);
        this.backend = 'idb';
        return db;
      } catch { return undefined; }
    })();
    return this.db;
  }

  private run<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    const next = this.ops.then(op).catch(() => fallback);
    this.ops = next;
    return next;
  }
}

function readLocalEntries(key: string): Entry[] {
  const raw = readLocal(key);
  if (!raw) return [];
  try { const value = JSON.parse(raw) as unknown; return Array.isArray(value) ? value as Entry[] : []; } catch { return []; }
}

function writeLocalEntries(key: string, entries: Entry[]): void {
  if (entries.length) writeLocal(key, JSON.stringify(entries));
  else removeLocal(key);
}
