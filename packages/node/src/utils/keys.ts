// Project key format of the Manalens collector (P-2524). The contract test
// (test/fixtures/collector-contract.json) checks that the two agree.
//
// New keys: <prefix><43 base62 characters><8 base62 characters: CRC32 of prefix + body>.
// Prefixes: mana_pk_ (publishable), mana_sk_ (secret), mana_api_ (API).
// Any other value is refused.

export const publishableKeyPrefix = 'mana_pk_';
export const secretKeyPrefix = 'mana_sk_';
export const apiKeyPrefix = 'mana_api_';

const keyBodyLength = 43;
const keyChecksumLength = 8;
const base62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const checksummedPrefixes = [publishableKeyPrefix, secretKeyPrefix, apiKeyPrefix] as const;
const newKeyShape = /^mana_(?:pk|sk|api)_[0-9A-Za-z]+$/;

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
 * True when a key may be valid: a known prefix, the right length and a valid
 * checksum. Anything else is false.
 */
export function isWellFormedKey(key: string): boolean {
  const prefix = checksummedPrefixes.find(candidate => key.startsWith(candidate));
  if (prefix) {
    if (!newKeyShape.test(key) || key.length !== prefix.length + keyBodyLength + keyChecksumLength) return false;
    const split = key.length - keyChecksumLength;
    return keyChecksum(key.slice(0, split)) === key.slice(split);
  }
  return false;
}
