import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';

export interface ReplayOptions {
  writeKey: string;
  endpoint: string;
  /** Return the current identified user ID, if the app called identify(). */
  getUserId?: () => string | undefined;
  blockSelector?: string;
  maskTextSelector?: string;
}

/** Opt-in recorder. It uses no cookies or persistent browser identity. */
export function startSessionReplay(options: ReplayOptions): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!options.writeKey || !options.endpoint) throw new Error('writeKey and endpoint are required');
  const endpoint = options.endpoint.replace(/\/$/, '');
  const recordingId = crypto.randomUUID();
  let sequence = 0;
  let pending: eventWithTime[] = [];
  let sending = false;
  let stopped = false;
  let stopRecord: ReturnType<typeof record>;
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  function pause() {
    stopRecord?.();
    stopRecord = undefined;
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = undefined;
    pending = [];
  }

  async function flush(keepalive = false) {
    if (sending || !pending.length) return;
    sending = true;
    const events = pending.splice(0, 50);
    const current = sequence;
    try {
      const response = await fetch(endpoint + '/v1/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-write-key': options.writeKey },
        body: JSON.stringify({ recording_id: recordingId, sequence: current, page_url: `${location.origin}${location.pathname}`, events,
          ...(options.getUserId?.() ? { user_id: options.getUserId?.() } : {}) }),
        credentials: 'omit', keepalive,
      });
      if (response.status === 403) { pause(); return; }
      if (!response.ok) throw new Error(`Replay upload failed: ${response.status}`);
      sequence++;
    } catch {
      if (!stopped) {
        pending.unshift(...events);
        if (pending.length > 500) pending = pending.slice(0, 500);
      }
    } finally { sending = false; }
  }

  function begin() {
    if (stopped || stopRecord) return;
    stopRecord = record({
      emit(event) {
        if (stopped) return;
        pending.push(event);
        if (pending.length >= 50) void flush();
      },
      maskAllInputs: true,
      maskTextSelector: options.maskTextSelector || '*',
      blockSelector: options.blockSelector || '[data-private], [data-replay-block]',
      recordCanvas: false,
      inlineImages: false,
      slimDOMOptions: 'all',
      checkoutEveryNms: 60000,
      sampling: { mousemove: 100, scroll: 500, input: 'last' },
    });
    flushTimer = setInterval(() => { void flush(); }, 5000);
  }

  async function sync() {
    if (stopped) return;
    try {
      const response = await fetch(endpoint + '/v1/replay/config', {
        headers: { 'x-write-key': options.writeKey }, credentials: 'omit', cache: 'no-store',
      });
      if (!response.ok) { pause(); return; }
      const config = await response.json() as { enabled?: boolean };
      if (config.enabled) begin(); else pause();
    } catch { pause(); }
  }

  void sync();
  const configTimer = setInterval(() => { void sync(); }, 30000);
  const onPageHide = () => { void flush(true); };
  window.addEventListener('pagehide', onPageHide);
  return () => {
    stopRecord?.();
    stopRecord = undefined;
    if (flushTimer) clearInterval(flushTimer);
    clearInterval(configTimer);
    window.removeEventListener('pagehide', onPageHide);
    void flush(true);
    stopped = true;
  };
}
