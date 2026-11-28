/**
 * Optional app context for browser and Electron games (P-2516). When the
 * `app` option is set, every event carries `context.app`. On an http(s) page
 * it goes next to `context.page` and the channel stays `web`. On an
 * installed-app page (`app://`, `file://`, Tauri, Capacitor) the events are
 * app events: channel `app` and no `context.page`. The App filters and
 * breakdowns (platform, storefront, version, build, engine) and "errors by
 * build" read it.
 *
 * The enums and limits mirror the collector (manalens
 * packages/shared/src/app-context.ts and appInfoSchema). An invalid object
 * would make the collector refuse every event, so the SDK drops it with a
 * console warning and sends plain web events.
 */
export const appPlatforms = ['windows', 'macos', 'linux', 'web', 'android', 'ios', 'ps5', 'xbox_series', 'xbox_one', 'switch', 'switch2', 'other'] as const;
export const appStorefronts = ['steam', 'itch', 'epic', 'gog', 'app_store', 'play', 'psn', 'xbox', 'nintendo', 'other'] as const;
export const appEngines = ['godot', 'unity', 'unreal', 'other'] as const;

export interface AppInfo {
  platform: (typeof appPlatforms)[number];
  storefront?: (typeof appStorefronts)[number];
  /** Printable version, for example `1.4.0-beta.2+571`. 1 to 32 characters: A-Z a-z 0-9 . _ + - and space. */
  app_version?: string;
  /** Build number or label. 1 to 64 characters, same characters as app_version. */
  build?: string;
  engine?: (typeof appEngines)[number];
}

const label = /^[A-Za-z0-9._+\- ]+$/;
const keys = new Set(['platform', 'storefront', 'app_version', 'build', 'engine']);

/** Why an app object is not valid, or null when it is. */
export function appInfoProblem(app: unknown): string | null {
  if (!app || typeof app !== 'object' || Array.isArray(app)) return 'app must be an object';
  const value = app as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!keys.has(key)) return `app.${key} is not a known field`;
  if (!(appPlatforms as readonly unknown[]).includes(value.platform)) return `app.platform must be one of ${appPlatforms.join(', ')}`;
  if (value.storefront !== undefined && !(appStorefronts as readonly unknown[]).includes(value.storefront)) return `app.storefront must be one of ${appStorefronts.join(', ')}`;
  if (value.engine !== undefined && !(appEngines as readonly unknown[]).includes(value.engine)) return `app.engine must be one of ${appEngines.join(', ')}`;
  for (const [key, max] of [['app_version', 32], ['build', 64]] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || field.length < 1 || field.length > max || !label.test(field)) return `app.${key} must be 1 to ${max} characters: letters, digits, . _ + - and space`;
  }
  return null;
}

/** A clean copy of a valid app object, or undefined (with a warning) for an invalid one. */
export function resolveAppInfo(app: unknown, warn: (message: string) => void = message => console.warn(message)): AppInfo | undefined {
  if (app === undefined || app === null) return undefined;
  const problem = appInfoProblem(app);
  if (problem) { warn(`Manalens: the app option is ignored (${problem}). Events are sent without context.app.`); return undefined; }
  const value = app as AppInfo;
  return {
    platform: value.platform,
    ...(value.storefront ? { storefront: value.storefront } : {}),
    ...(value.app_version ? { app_version: value.app_version } : {}),
    ...(value.build ? { build: value.build } : {}),
    ...(value.engine ? { engine: value.engine } : {}),
  };
}

/** The app object from snippet data attributes (`data-app-platform` and friends), or undefined without a platform. */
export function appInfoFromDataset(dataset: Record<string, string | undefined>): unknown {
  if (!dataset.appPlatform) return undefined;
  return {
    platform: dataset.appPlatform,
    ...(dataset.appStorefront ? { storefront: dataset.appStorefront } : {}),
    ...(dataset.appVersion ? { app_version: dataset.appVersion } : {}),
    ...(dataset.appBuild ? { build: dataset.appBuild } : {}),
    ...(dataset.appEngine ? { engine: dataset.appEngine } : {}),
  };
}
