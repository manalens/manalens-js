// Keep the version constant in each SDK equal to its package.json version.
// `pnpm version-packages` runs this after `changeset version`. With --check it
// only reports a difference and exits 1 (part of `pnpm test`).
import { readFileSync, writeFileSync } from 'node:fs';

const targets = [
  { pkg: 'packages/web/package.json', file: 'packages/web/src/index.ts', pattern: /(export const LIBRARY_VERSION = ')([^']*)(';)/ },
  { pkg: 'packages/node/package.json', file: 'packages/node/src/Manalens.ts', pattern: /(export const SDK_VERSION = ')([^']*)(';)/ },
];
const check = process.argv.includes('--check');
const root = new URL('../', import.meta.url);
let failed = false;

for (const { pkg, file, pattern } of targets) {
  const { name, version } = JSON.parse(readFileSync(new URL(pkg, root), 'utf8'));
  const url = new URL(file, root);
  const source = readFileSync(url, 'utf8');
  const match = source.match(pattern);
  if (!match) throw new Error(`${file}: version constant not found`);
  if (match[2] === version) continue;
  if (check) {
    console.error(`${file} has version ${match[2]}, but ${name} is ${version}. Run: node scripts/sync-versions.mjs`);
    failed = true;
  } else {
    writeFileSync(url, source.replace(pattern, `$1${version}$3`));
    console.log(`${file}: ${match[2]} -> ${version}`);
  }
}
process.exit(failed ? 1 : 0);
