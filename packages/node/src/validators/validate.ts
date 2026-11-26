/**
 * Event checks. They mirror the collector's schemas (see the contract test),
 * so the SDK drops a bad event on its own and never sends a batch that the
 * collector refuses as a whole with 400.
 */

import { isIP } from 'node:net';
import { isNonEmptyString, isObject, isOneOf, isString, isUUID } from './checks.js';
import { APP_ENGINES, APP_PLATFORMS, APP_STOREFRONTS, BROWSERS, DEVICES, OSES, type Mode, type WireEvent } from '../types/index.js';

export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Invalid ${field}: ${reason}`);
    this.name = 'ValidationError';
  }
}

export const LIMITS = {
  eventName: 128,
  userId: 255,
  sessionId: 64,
  stringValue: 1024,
  propertyKey: 100,
  propertyKeys: 50,
  propertiesBytes: 8 * 1024,
  locale: 32,
  userAgent: 1024,
  pagePath: 2048,
  pageTitle: 300,
  pageUrl: 2048,
  appVersion: 32,
  build: 64,
} as const;

/** Collector limits on `original_timestamp`. */
export const APP_EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const APP_EVENT_FUTURE_SKEW_MS = 10 * 60_000;
export const SERVER_EVENT_FUTURE_SKEW_MS = 5 * 60_000;

const SESSION_ID = /^[A-Za-z0-9_.:-]+$/;
const APP_LABEL = /^[A-Za-z0-9._+\- ]+$/;

function fail(field: string, reason: string): never {
  throw new ValidationError(field, reason);
}

function checkString(field: string, value: unknown, max: number, min = 0): void {
  if (!isString(value) || value.length < min || value.length > max) fail(field, `must be a string of ${min} to ${max} characters`);
}

/**
 * Properties and traits: at most 50 keys of 1 to 100 characters, and at most
 * 8 KB as JSON (UTF-8). Values: string (up to 1024 characters), finite number,
 * boolean or null.
 */
export function checkProperties(field: string, value: unknown): void {
  if (!isObject(value)) fail(field, 'must be an object');
  const entries = Object.entries(value);
  if (entries.length > LIMITS.propertyKeys) fail(field, `must have at most ${LIMITS.propertyKeys} keys`);
  for (const [key, item] of entries) {
    if (key.length < 1 || key.length > LIMITS.propertyKey) fail(`${field} key`, `must be 1 to ${LIMITS.propertyKey} characters`);
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(`${field}.${key}`, 'must be a finite number'); continue; }
    if (typeof item === 'string') { if (item.length > LIMITS.stringValue) fail(`${field}.${key}`, `must be at most ${LIMITS.stringValue} characters`); continue; }
    fail(`${field}.${key}`, 'must be a string, number, boolean or null');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.propertiesBytes) fail(field, `must be at most ${LIMITS.propertiesBytes} bytes as JSON`);
}

/** `context.app` (strict: no other keys). */
export function checkApp(value: unknown, field = 'context.app'): void {
  if (!isObject(value)) fail(field, 'must be an object');
  for (const key of Object.keys(value)) {
    if (!['platform', 'storefront', 'app_version', 'build', 'engine'].includes(key)) fail(`${field}.${key}`, 'is not a known key');
  }
  if (!isOneOf(value.platform, APP_PLATFORMS)) fail(`${field}.platform`, `must be one of ${APP_PLATFORMS.join(', ')}`);
  if (value.storefront !== undefined && !isOneOf(value.storefront, APP_STOREFRONTS)) fail(`${field}.storefront`, `must be one of ${APP_STOREFRONTS.join(', ')}`);
  if (value.engine !== undefined && !isOneOf(value.engine, APP_ENGINES)) fail(`${field}.engine`, `must be one of ${APP_ENGINES.join(', ')}`);
  for (const [key, max] of [['app_version', LIMITS.appVersion], ['build', LIMITS.build]] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (!isString(item) || item.length < 1 || item.length > max || !APP_LABEL.test(item)) fail(`${field}.${key}`, `must be 1 to ${max} printable characters (letters, digits, . _ + - and space)`);
  }
}

function checkPage(value: unknown): void {
  if (!isObject(value)) fail('context.page', 'must be an object');
  for (const key of Object.keys(value)) if (!['path', 'title', 'url'].includes(key)) fail(`context.page.${key}`, 'is not a known key');
  if (value.path !== undefined) {
    checkString('context.page.path', value.path, LIMITS.pagePath);
    if (!(value.path as string).startsWith('/')) fail('context.page.path', 'must start with /');
  }
  if (value.title !== undefined) checkString('context.page.title', value.title, LIMITS.pageTitle);
  if (value.url !== undefined) {
    checkString('context.page.url', value.url, LIMITS.pageUrl);
    try { new URL(value.url as string); } catch { fail('context.page.url', 'must be a URL'); }
  }
}

function checkTimestamp(value: string, mode: Mode, now: number): void {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) fail('timestamp', 'must be a date');
  if (mode === 'app') {
    if (at < now - APP_EVENT_MAX_AGE_MS) fail('timestamp', 'is more than 7 days old (app events)');
    if (at > now + APP_EVENT_FUTURE_SKEW_MS) fail('timestamp', 'is in the future');
  } else if (at > now + SERVER_EVENT_FUTURE_SKEW_MS) {
    fail('timestamp', 'is in the future');
  }
}

function checkCommon(event: WireEvent, mode: Mode, now: number): void {
  if (event.type !== 'track' && event.type !== 'identify' && event.type !== 'traits') fail('type', 'must be track, identify or traits');
  if (!isUUID(event.message_id)) fail('messageId', 'must be a UUID');
  checkTimestamp(event.original_timestamp, mode, now);
  if (event.type === 'track') {
    if (!isNonEmptyString(event.event)) fail('event', 'is required for track');
    checkString('event', event.event, LIMITS.eventName, 1);
    if (event.traits !== undefined) fail('traits', 'are only valid on identify and traits');
  } else {
    if (event.event !== undefined) fail('event', `is not valid on ${event.type}`);
    if (event.type === 'identify' && event.user_id === undefined) fail('userId', 'is required for identify');
    if (event.type === 'traits' && (!isObject(event.traits) || Object.keys(event.traits).length === 0)) fail('traits', 'needs at least one key');
  }
  if (event.user_id !== undefined) checkString('userId', event.user_id, LIMITS.userId, 1);
  if (event.anonymous_id !== undefined && !isUUID(event.anonymous_id)) fail('anonymousId', 'must be a UUID');
  if (event.session_id !== undefined) {
    checkString('sessionId', event.session_id, LIMITS.sessionId, 1);
    if (!SESSION_ID.test(event.session_id)) fail('sessionId', 'may only use letters, digits and _ . : -');
  }
  if (event.properties !== undefined) checkProperties('properties', event.properties);
  if (event.traits !== undefined) checkProperties('traits', event.traits);
}

/** Server event: `channel: 'server'`, user_id or anonymous_id, optional server context. */
export function validateServerEvent(event: WireEvent, now = Date.now()): void {
  checkCommon(event, 'server', now);
  if (event.channel !== 'server') fail('channel', 'must be server');
  if (event.user_id === undefined && event.anonymous_id === undefined) fail('userId', 'or anonymousId is required');
  const context = event.context;
  if (context === undefined) return;
  if (!isObject(context)) fail('context', 'must be an object');
  for (const [key, value] of Object.entries(context)) {
    switch (key) {
      case 'ip': if (!isString(value) || isIP(value) === 0 || value.includes('%')) fail('context.ip', 'must be an IPv4 or IPv6 address'); break;
      case 'user_agent': checkString('context.userAgent', value, LIMITS.userAgent, 1); break;
      case 'country': if (!isString(value) || !/^[A-Za-z]{2}$/.test(value)) fail('context.country', 'must be a two-letter country code'); break;
      case 'locale': checkString('context.locale', value, LIMITS.locale); break;
      case 'device': if (!isOneOf(value, DEVICES)) fail('context.device', `must be one of ${DEVICES.join(', ')}`); break;
      case 'os': if (!isOneOf(value, OSES)) fail('context.os', `must be one of ${OSES.join(', ')}`); break;
      case 'browser': if (!isOneOf(value, BROWSERS)) fail('context.browser', `must be one of ${BROWSERS.join(', ')}`); break;
      case 'page': checkPage(value); break;
      case 'app': checkApp(value); break;
      case 'library_name': checkString('context.library_name', value, 64); break;
      case 'library_version': checkString('context.library_version', value, 32); break;
      default: fail(`context.${key}`, 'is not a known key');
    }
  }
}

/** App event: `channel: 'app'`, anonymous_id, `context.app`. Same shape as the collector's browserEventSchema with context.app. */
export function validateAppEvent(event: WireEvent, now = Date.now()): void {
  checkCommon(event, 'app', now);
  if (event.channel !== 'app') fail('channel', 'must be app');
  if (event.anonymous_id === undefined) fail('anonymousId', 'is required in app mode');
  // The collector refuses these two (SESSION_ID_REQUIRED, SESSION_ID_IS_ANONYMOUS_ID): drop them here with a clear message.
  if (event.session_id === undefined) fail('sessionId', 'is required in app mode');
  if (event.session_id === event.anonymous_id) fail('sessionId', 'must not be the anonymousId');
  checkString('version', event.version, 32);
  const context = event.context;
  if (!isObject(context)) fail('context', 'must be an object');
  for (const key of Object.keys(context)) {
    if (!['app', 'locale', 'library_name', 'library_version'].includes(key)) fail(`context.${key}`, 'is not a known key');
  }
  checkApp(context.app);
  if (context.locale !== undefined) checkString('context.locale', context.locale, LIMITS.locale);
  if (context.library_name !== undefined) checkString('context.library_name', context.library_name, 64);
  if (context.library_version !== undefined) checkString('context.library_version', context.library_version, 32);
}
