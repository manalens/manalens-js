/**
 * Basic type checks.
 */

export const isString = (value: unknown): value is string => typeof value === 'string';

export const isNullOrUndefined = (value: unknown): value is null | undefined => value === null || value === undefined;

export const isNonEmptyString = (value: unknown): value is string => isString(value) && value.length > 0;

/** True for a plain object (not null, not an array). */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Same rule as zod's `.uuid()` in the collector (RFC 9562 variant, plus the nil and max UUIDs). */
export const isUUID = (value: unknown): value is string =>
  isString(value) && /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(value);

/** True when the value is a string from the given list. */
export const isOneOf = <T extends string>(value: unknown, list: readonly T[]): value is T =>
  isString(value) && (list as readonly string[]).includes(value);
