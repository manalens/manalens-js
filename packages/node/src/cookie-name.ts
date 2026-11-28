/**
 * The name of a web SDK cookie (P-2886): `mana_<hash>_<name>`, where `<hash>`
 * is the FNV-1a 32-bit hash of the project's publishable key as 8 lower case
 * hex characters. The format is a stable contract (packages/web/src/storage.ts
 * storageKey makes the same name). A server reads `anonymous-id` (and
 * `session-id`) to join a checkout or a sign-in to the browser's visitor.
 *
 * @example
 * const anonymousId = req.cookies[sdkCookieName(publishableKey, 'anonymous-id')];
 */
export type SdkCookie = 'anonymous-id' | 'session-id' | 'user-id' | 'opt-out';

export function sdkCookieName(publishableKey: string, name: SdkCookie): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < publishableKey.length; i++) {
    hash ^= publishableKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `mana_${(hash >>> 0).toString(16).padStart(8, '0')}_${name}`;
}
