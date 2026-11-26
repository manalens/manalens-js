// Error events for game mode and trackError() (P-2800). The grouping rule,
// the limits and the message cleaning follow the Godot, Unity and Unreal SDKs
// (manalens sdks/SPEC.md, docs/features/error-tracking.mdx).

export const errorSeverities = ['debug', 'info', 'warning', 'error', 'critical'] as const;
export type ErrorSeverity = (typeof errorSeverities)[number];

/** Optional details for trackError(). */
export interface TrackErrorOptions {
  /** `debug`, `info`, `warning`, `error` (default) or `critical`. */
  severity?: ErrorSeverity;
  /** The error class, for example `SaveFailed`. Default: the `name` of an Error object. */
  errorType?: string;
  /** `false` when the game could not recover. Default `true` for trackError(). */
  handled?: boolean;
  /** Your own grouping key. Default: a hash of the error type and the place in the code, or of the message without numbers and quoted text. */
  fingerprint?: string;
  /** A stack trace text (cut to 1024 characters). Default: the `stack` of an Error object. */
  stack?: string;
  file?: string;
  line?: number;
  function?: string;
  /** More scalar properties (level, mode ...). The error keys win over these. */
  properties?: Record<string, string | number | boolean | null>;
}

export type ErrorProperties = Record<string, string | number | boolean | null>;

/** Limits of the game SDKs (sdks/SPEC.md delivery-defaults). */
export const ERROR_DEDUPE_MS = 1000;
export const ERROR_WINDOW_MS = 10_000;
export const ERROR_WINDOW_MAX = 20;
export const MAX_AUTO_ERRORS_PER_SESSION = 50;
export const MAX_STRING = 1024;
export const MAX_PROPERTY_KEYS = 50;
export const MAX_PROPERTY_BYTES = 8 * 1024;

const left = (value: string, max: number) => value.length > max ? value.slice(0, max) : value;

/** SHA-1 of the UTF-8 text, as hex. Synchronous, so an error is queued in the same call. */
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const length = bytes.length;
  const words = new Uint32Array((((length + 8) >> 6) + 1) * 16);
  for (let i = 0; i < length; i++) words[i >> 2] |= bytes[i]! << (24 - (i % 4) * 8);
  words[length >> 2] |= 0x80 << (24 - (length % 4) * 8);
  words[words.length - 1] = length * 8;
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[block + t]!;
    for (let t = 16; t < 80; t++) { const x = w[t - 3]! ^ w[t - 8]! ^ w[t - 14]! ^ w[t - 16]!; w[t] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? ((b & c) | (~b & d)) + 0x5a827999 : t < 40 ? (b ^ c ^ d) + 0x6ed9eba1 : t < 60 ? ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc : (b ^ c ^ d) + 0xca62c1d6;
      const temp = (((a << 5) | (a >>> 27)) + f + e + w[t]!) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map(h => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * The group key, as in the game SDKs: the error type and the place in the code
 * (file and function, no line number), else the error type and the message
 * with quoted text and numbers removed. The first 16 hex characters of SHA-1.
 */
export function errorFingerprint(errorType: string, message: string, file: string, fn: string): string {
  const basis = file || fn
    ? `${errorType}|${file}|${fn}`
    : `${errorType}|${(message ?? '').replace(/"[^"]*"|'[^']*'/g, '?').replace(/0x[0-9A-Fa-f]+|\d+/g, 'N')}`;
  return sha1Hex(basis).slice(0, 16);
}

/** The first stack frame: Chrome and Node (`at fn (file:1:2)`), Firefox and Safari (`fn@file:1:2`). */
export function firstFrame(stack: string | undefined): { file: string; line: number; fn: string } | undefined {
  if (!stack) return undefined;
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    const v8 = /^at (?:(.+?) \()?(.+?):(\d+)(?::\d+)?\)?$/.exec(line);
    const gecko = v8 ? null : /^([^\s@]*)@(.+?):(\d+)(?::\d+)?$/.exec(line);
    const match = v8 ?? gecko;
    if (!match) continue;
    return { fn: (match[1] ?? '').trim(), file: match[2]!, line: Number(match[3]) };
  }
  return undefined;
}

/**
 * A script location without personal data: the path of an http(s) or file
 * URL (no origin, query or fragment), other URLs without query and fragment.
 */
export function cleanFile(file: string): string {
  if (!file) return '';
  try {
    const url = new URL(file);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.pathname;
    if (url.protocol === 'file:') return cleanMessage(decodeURIComponent(url.pathname));
    return `${url.protocol}${url.host ? `//${url.host}` : ''}${url.pathname}`;
  } catch {
    return cleanMessage(file.split(/[?#]/)[0]!);
  }
}

const END = `\\s"'<>()`;

/**
 * Removes personal data from a captured message or stack, with the rules of
 * the game SDKs: home folders become ~; URLs lose their user, query and
 * fragment; emails become [email]; values after key=, token=, secret=,
 * password=, authorization: and bearer, and runs of 24 or more letters,
 * digits, _ and - (also JWTs and base64 runs) become [redacted].
 */
export function cleanMessage(text: string): string {
  let out = text ?? '';
  out = out.replace(new RegExp(`(?:/Users/|/home/)[^/\\\\${END}]+`, 'gi'), '~');
  out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])[A-Za-z]:[\\\\/]Users[\\\\/][^/\\\\${END}]+`, 'gi'), '$1~');
  out = out.replace(new RegExp(`([A-Za-z][A-Za-z0-9+.-]*://)([^${END}]*)`, 'g'), (_all, scheme: string, rest: string) => {
    const noQuery = rest.split(/[?#]/)[0]!;
    const slash = noQuery.indexOf('/');
    let authority = slash < 0 ? noQuery : noQuery.slice(0, slash);
    const path = slash < 0 ? '' : noQuery.slice(slash);
    const at = authority.lastIndexOf('@');
    if (at >= 0) authority = authority.slice(at + 1);
    return scheme + authority + path;
  });
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]');
  out = out.replace(/(bearer )([^\s"'<>()]+)/gi, (_all, name: string, value: string) => value === '[redacted]' ? name + value : `${name}[redacted]`);
  out = out.replace(/(authorization|key|token|secret|password)(["']?\s*[:=]\s*)("[^"]*"?|'[^']*'?|[^\s"'<>()&,;\]}]+)/gi, (_all, name: string, sep: string, value: string) => {
    if (/^\[redacted\]$/.test(value)) return name + sep + value;
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${name}${sep}${quote}[redacted]${quote && value.endsWith(quote) && value.length > 1 ? quote : ''}`;
  });
  out = out.replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g, '[redacted]');
  out = out.replace(/[A-Za-z0-9_\-+/=]{24,}/g, run => {
    if (run.includes('+') || run.endsWith('=')) return '[redacted]';
    return run.replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]');
  });
  return out;
}

/**
 * Keeps keys in order while the object has at most 50 keys and 8 KB of JSON;
 * the collector refuses larger properties. The error keys come first, so the
 * cut drops custom keys first.
 */
export function fitProperties(values: ErrorProperties): ErrorProperties {
  const bytes = (value: unknown) => {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  };
  const entries = Object.entries(values);
  if (entries.length <= MAX_PROPERTY_KEYS && bytes(values) <= MAX_PROPERTY_BYTES) return values;
  const output: ErrorProperties = {};
  let total = 2;
  for (const [key, value] of entries) {
    if (Object.keys(output).length >= MAX_PROPERTY_KEYS) break;
    const entry = bytes({ [key]: value }) - 2 + (total > 2 ? 1 : 0);
    if (total + entry > MAX_PROPERTY_BYTES) continue;
    output[key] = value;
    total += entry;
  }
  return output;
}

export interface ErrorInput {
  message: string;
  severity: ErrorSeverity;
  errorType: string;
  handled: boolean;
  source: 'manual' | 'web_window';
  fingerprint?: string;
  file?: string;
  line?: number;
  fn?: string;
  stack?: string;
  properties?: ErrorProperties;
}

/** The properties of an `error` event, in the order of the game SDKs. */
export function errorProperties(input: ErrorInput): ErrorProperties {
  const errorType = left(input.errorType ?? '', 128);
  const file = left(input.file ?? '', 256);
  const fn = left(input.fn ?? '', 256);
  const message = left(input.message ?? '', MAX_STRING);
  const props: ErrorProperties = {
    severity: (errorSeverities as readonly string[]).includes(input.severity) ? input.severity : 'error',
    message,
    handled: input.handled,
    source: input.source,
    fingerprint: left(input.fingerprint ?? '', 128) || errorFingerprint(errorType, input.message ?? '', file, fn),
  };
  if (errorType) props.error_type = errorType;
  if (file) { props.file = file; props.line = Number.isFinite(input.line) ? Math.floor(input.line!) : 0; }
  if (fn) props.function = fn;
  const stack = (input.stack ?? '').trim();
  if (stack) props.stack = left(stack, MAX_STRING);
  for (const [key, value] of Object.entries(input.properties ?? {})) {
    if (!key || key.length > 100 || key in props) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) props[key] = typeof value === 'string' ? left(value, MAX_STRING) : value;
  }
  return fitProperties(props);
}

/**
 * The limits of the game SDKs: the same fingerprint at most once a second,
 * at most 20 errors in 10 seconds, and at most 50 automatic errors in one
 * session (manual errors skip only that cap). Dropped errors are counted for
 * `errors_dropped` on the next `session_end`.
 */
export class ErrorLimiter {
  private seen = new Map<string, number>();
  private times: number[] = [];
  autoErrors = 0;
  dropped = 0;

  allow(fingerprint: string, source: ErrorInput['source'], now = Date.now()): boolean {
    const last = this.seen.get(fingerprint);
    this.times = this.times.filter(at => now - at < ERROR_WINDOW_MS);
    if ((last !== undefined && now - last < ERROR_DEDUPE_MS) || this.times.length >= ERROR_WINDOW_MAX || (source !== 'manual' && this.autoErrors >= MAX_AUTO_ERRORS_PER_SESSION)) {
      this.dropped++;
      return false;
    }
    this.seen.set(fingerprint, now);
    this.times.push(now);
    if (source !== 'manual') this.autoErrors++;
    if (this.seen.size > 500) this.seen.clear();
    return true;
  }

  /** A new session: the per-session cap starts again. */
  newSession(): void { this.autoErrors = 0; }

  /** setConsent(false), optOut() and reset(): forget the error history. */
  clear(): void { this.seen.clear(); this.times = []; this.autoErrors = 0; this.dropped = 0; }

  /** The drop count for `session_end`, then zero. */
  takeDropped(): number { const dropped = this.dropped; this.dropped = 0; return dropped; }
}
