/**
 * Manalens Node.js SDK: server events (secret key) and Electron
 * main-process or game server app events (publishable key).
 *
 * @packageDocumentation
 */

export { Manalens, SDK_VERSION, PROTECTED_TRAITS } from './Manalens.js';
export { ValidationError } from './validators/index.js';
export { APP_PLATFORMS, APP_STOREFRONTS, APP_ENGINES } from './types/index.js';
export type {
  Mode,
  AnalyticsOptions,
  TrackCall,
  IdentifyCall,
  TraitsCall,
  LinkCall,
  LinkResult,
  AppInfo,
  ServerContext,
  AppContext,
  Properties,
  PropertyValue,
  Logger,
  WireEvent,
} from './types/index.js';
