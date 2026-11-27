// Hang detection (P-2833): the SDK watches the main thread of a game. A
// blocked main thread cannot run any code, so a hang is found when it ends:
//
// - Where the browser has it, a PerformanceObserver for
//   `long-animation-frame` (with the scripts that ran) or `longtask` gives
//   each long task with its start and duration.
// - Elsewhere (Firefox, Safari), a timer every HANG_TICK_MS: when it runs
//   late, the main thread was blocked for the delay.
//
// Background tabs throttle timers and can freeze, so no hang is reported for
// a time when the page was hidden, frozen or just visible again. A gap of
// more than MAX_HANG_MS, or a gap where the wall clock and the monotonic clock
// disagree, is a sleep of the computer, not a hang.

/** The default limit: a main thread blocked this long is a hang. */
export const HANG_THRESHOLD_MS = 5000;
/** The smallest and the largest limit for hangThresholdMs (0 turns detection off). */
export const MIN_HANG_THRESHOLD_MS = 1000;
export const MAX_HANG_THRESHOLD_MS = 60_000;
/** The timer of the fallback. */
export const HANG_TICK_MS = 500;
/** No hang is reported that starts less than this after the page became visible. */
export const VISIBLE_GRACE_MS = 1000;
/** A longer gap is a sleep of the computer. */
export const MAX_HANG_MS = 10 * 60_000;
/** The wall clock and the monotonic clock may differ this much in one gap. */
const CLOCK_DRIFT_MS = 1000;
/** At most this many scripts of a long animation frame go into the stack. */
const MAX_SCRIPTS = 10;

/** A script of a long animation frame (PerformanceScriptTiming). */
interface ScriptTiming { duration?: number; invoker?: string; sourceURL?: string; sourceFunctionName?: string }
interface LongEntry { startTime: number; duration: number; scripts?: ScriptTiming[] }

/** What the watchdog found: the blocked time, and the scripts that ran when the browser gives them. */
export interface Hang { durationMs: number; scripts: ScriptTiming[] }

const monotonic = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/** The entry type to observe, or undefined when the browser has neither. */
function observedType(): 'long-animation-frame' | 'longtask' | undefined {
  try {
    const types = typeof PerformanceObserver === 'function' ? (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes : undefined;
    if (!Array.isArray(types)) return undefined;
    if (types.includes('long-animation-frame')) return 'long-animation-frame';
    if (types.includes('longtask')) return 'longtask';
  } catch { /* No PerformanceObserver. */ }
  return undefined;
}

export class HangWatchdog {
  private observer?: PerformanceObserver;
  private timer?: ReturnType<typeof setInterval>;
  private lastTick = 0;
  private lastWall = 0;
  /** The monotonic time of the last visibility or lifecycle change (hidden, visible, frozen, resumed). */
  private lastChange = -Infinity;
  private readonly onChange = () => { this.lastChange = monotonic(); };

  constructor(private readonly thresholdMs: number, private readonly report: (hang: Hang) => void) {}

  start(): void {
    if (this.observer || this.timer || typeof window === 'undefined') return;
    for (const type of ['pageshow', 'pagehide', 'freeze', 'resume']) window.addEventListener(type, this.onChange);
    document.addEventListener?.('visibilitychange', this.onChange);
    const type = observedType();
    if (type) {
      try {
        this.observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) this.check(entry as unknown as LongEntry); });
        this.observer.observe({ type, buffered: false });
        return;
      } catch { this.observer = undefined; }
    }
    this.lastTick = monotonic();
    this.lastWall = Date.now();
    this.timer = setInterval(() => this.tick(), HANG_TICK_MS);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (typeof window === 'undefined') return;
    for (const type of ['pageshow', 'pagehide', 'freeze', 'resume']) window.removeEventListener(type, this.onChange);
    document.removeEventListener?.('visibilitychange', this.onChange);
  }

  private visible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }

  /** A long task or a long animation frame from the observer. */
  private check(entry: LongEntry): void {
    const duration = Number(entry?.duration);
    const start = Number(entry?.startTime);
    if (!Number.isFinite(duration) || !Number.isFinite(start) || duration < this.thresholdMs || duration > MAX_HANG_MS) return;
    // Hidden now, or hidden, frozen or just visible again since shortly before the task started.
    if (!this.visible() || this.lastChange >= start - VISIBLE_GRACE_MS) return;
    const scripts = Array.isArray(entry.scripts) ? entry.scripts : [];
    this.report({ durationMs: duration, scripts });
  }

  /** The fallback timer: a late tick means the main thread was blocked. */
  private tick(): void {
    const now = monotonic();
    const wall = Date.now();
    const gap = now - this.lastTick;
    const wallGap = wall - this.lastWall;
    const since = this.lastTick;
    this.lastTick = now;
    this.lastWall = wall;
    const blocked = gap - HANG_TICK_MS;
    if (blocked < this.thresholdMs || gap > MAX_HANG_MS || Math.abs(wallGap - gap) > CLOCK_DRIFT_MS) return;
    if (!this.visible() || this.lastChange >= since - VISIBLE_GRACE_MS) return;
    this.report({ durationMs: blocked, scripts: [] });
  }
}

/** The script that ran longest, and a stack-like list of the scripts (longest first). */
export function hangPlace(scripts: ScriptTiming[], cleanFile: (file: string) => string, clean: (text: string) => string): { file: string; fn: string; stack: string } {
  const sorted = scripts
    .filter(script => script && typeof script === 'object')
    .sort((a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0))
    .slice(0, MAX_SCRIPTS);
  const name = (script: ScriptTiming) => clean(typeof script.sourceFunctionName === 'string' && script.sourceFunctionName ? script.sourceFunctionName : typeof script.invoker === 'string' ? script.invoker : '');
  const file = (script: ScriptTiming) => cleanFile(typeof script.sourceURL === 'string' ? script.sourceURL : '');
  const top = sorted[0];
  return {
    file: top ? file(top) : '',
    fn: top ? name(top).slice(0, 256) : '',
    stack: sorted.map(script => `    at ${name(script) || '<anonymous>'} (${file(script) || 'unknown'})`).join('\n'),
  };
}
