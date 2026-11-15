// Project key format. A copy of packages/shared/src/keys.ts (P-2524), so the
// published SDK has no dependency on the monorepo. A unit test checks that the
// two agree.
//
// New keys: <prefix><43 base62 characters><8 base62 characters: CRC32 of prefix + body>.
// Prefixes: ua_pk_ (publishable), ua_sk_ (secret), ua_api_ (API).
// Legacy keys: ua_... (publishable, no checksum) and ua_mcp_... (API).

export const publishableKeyPrefix = 'ua_pk_';
export const secretKeyPrefix = 'ua_sk_';
export const apiKeyPrefix = 'ua_api_';
export const legacyApiKeyPrefix = 'ua_mcp_';

const keyBodyLength = 43;
const keyChecksumLength = 8;
const base62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const checksummedPrefixes = [publishableKeyPrefix, secretKeyPrefix, apiKeyPrefix] as const;
const newKeyShape = /^ua_(?:pk|sk|api)_[0-9A-Za-z]+$/;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 (IEEE 802.3, as zlib) of an ASCII string. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) crc = crcTable[(crc ^ text.charCodeAt(i)) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The 8-character base62 checksum of `<prefix><body>`. */
export function keyChecksum(prefixAndBody: string): string {
  let value = crc32(prefixAndBody), out = '';
  do { out = base62[value % 62] + out; value = Math.floor(value / 62); } while (value > 0);
  return out.padStart(keyChecksumLength, '0');
}

/**
 * True when a key may be valid: a new key needs the right length and checksum;
 * a legacy key (`ua_mcp_`, or `ua_` with no new prefix) passes. Anything else is false.
 */
export function isWellFormedKey(key: string): boolean {
  const prefix = checksummedPrefixes.find(candidate => key.startsWith(candidate));
  if (prefix) {
    if (!newKeyShape.test(key) || key.length !== prefix.length + keyBodyLength + keyChecksumLength) return false;
    const split = key.length - keyChecksumLength;
    return keyChecksum(key.slice(0, split)) === key.slice(split);
  }
  return key.startsWith('ua_') && key.length <= 256;
}
