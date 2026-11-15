/**
 * Untitled Analytics Node.js SDK: server events (secret key) and Electron
 * main-process or game server app events (publishable key).
 *
 * @packageDocumentation
 */

export { UntitledAnalytics, SDK_VERSION } from './UntitledAnalytics.js';
export { ValidationError } from './validators/index.js';
export { APP_PLATFORMS, APP_STOREFRONTS, APP_ENGINES } from './types/index.js';
export type {
  Mode,
  AnalyticsOptions,
  TrackCall,
  IdentifyCall,
  AppInfo,
  ServerContext,
  AppContext,
  Properties,
  PropertyValue,
  Logger,
  WireEvent,
} from './types/index.js';
