// Console logging, off by default. Option names follow getformo/sdk's `logger`.

export const logLevels = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevels)[number];

export interface LoggerOptions {
  /** Print logs to the console. Default false. */
  enabled?: boolean;
  /**
   * The levels to print, matched exactly (not "this level and above"):
   * `['warn']` prints warnings only. Default: all levels when `enabled` is true.
   */
  levels?: LogLevel[];
}

const methods: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = { trace: 'debug', debug: 'debug', info: 'info', warn: 'warn', error: 'error' };

/**
 * Logs SDK actions: event types and names, batch sizes, HTTP statuses. It never
 * logs property values, traits, user IDs or keys.
 */
export class Logger {
  private readonly levels: ReadonlySet<LogLevel>;

  constructor(options?: LoggerOptions) {
    const enabled = options?.enabled === true;
    const levels = Array.isArray(options?.levels) ? options.levels : logLevels;
    this.levels = new Set(enabled ? levels.filter(level => (logLevels as readonly string[]).includes(level)) : []);
  }

  log(level: LogLevel, message: string): void {
    if (!this.levels.has(level) || typeof console === 'undefined') return;
    console[methods[level]](`[Manalens] ${message}`);
  }
}
