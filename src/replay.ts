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
  const recordingId = crypto.randomUUID();
  let sequence = 0;
  let pending: eventWithTime[] = [];
  let sending = false;
  let stopped = false;
  async function flush(keepalive = false) {
    if (sending || !pending.length) return;
    sending = true;
    const events = pending.splice(0, 50);
    const current = sequence;
    try {
      const response = await fetch(options.endpoint.replace(/\/$/, '') + '/v1/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-write-key': options.writeKey },
        body: JSON.stringify({ recording_id: recordingId, sequence: current, page_url: `${location.origin}${location.pathname}`, events,
          ...(options.getUserId?.() ? { user_id: options.getUserId?.() } : {}) }),
        credentials: 'omit', keepalive,
      });
      if (!response.ok) throw new Error(`Replay upload failed: ${response.status}`);
      sequence++;
    } catch {
      pending.unshift(...events);
      if (pending.length > 500) pending = pending.slice(0, 500);
    } finally { sending = false; }
  }
  const stopRecord = record({
    emit(event) {
      if (stopped) return;
      pending.push(event);
      if (pending.length >= 50) void flush();
    },
    maskAllInputs: true,
    maskTextSelector: options.maskTextSelector || '[data-mask], [data-pii]',
    blockSelector: options.blockSelector || '[data-private], [data-replay-block]',
    recordCanvas: false,
    inlineImages: false,
    slimDOMOptions: 'all',
    checkoutEveryNms: 60000,
    sampling: { mousemove: 100, scroll: 500, input: 'last' },
  });
  const timer = setInterval(() => { void flush(); }, 5000);
  const onPageHide = () => { void flush(true); };
  window.addEventListener('pagehide', onPageHide);
  return () => {
    stopRecord?.();
    clearInterval(timer);
    window.removeEventListener('pagehide', onPageHide);
    void flush(true);
    stopped = true;
  };
}
