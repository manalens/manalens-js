// Supply-chain rule (README, Security): the published packages have zero
// runtime dependencies and no install lifecycle scripts. A customer who installs
// @manalens/web or @manalens/node then installs only our own code, and nothing
// runs on their machine at install time. Dev dependencies are fine: they never
// reach a customer.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const PACKAGES = ['packages/web', 'packages/node'];
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const root = new URL('../', import.meta.url);

for (const dir of PACKAGES) {
  const pkg = JSON.parse(readFileSync(new URL(`${dir}/package.json`, root), 'utf8'));
  // pnpm publish applies fields in publishConfig over the package.json, so check both.
  const manifests = [pkg, pkg.publishConfig ?? {}];

  test(`${pkg.name} has no runtime dependencies`, () => {
    for (const manifest of manifests) {
      for (const field of DEPENDENCY_FIELDS) {
        const value = manifest[field];
        const empty = value === undefined || value === false || (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0);
        assert.ok(empty, `${dir}/package.json has "${field}". The published packages must have zero runtime dependencies (README, Security).`);
      }
    }
  });

  test(`${pkg.name} has no install lifecycle scripts`, () => {
    for (const manifest of manifests) {
      for (const script of INSTALL_SCRIPTS) {
        assert.equal(manifest.scripts?.[script], undefined, `${dir}/package.json has the "${script}" script. The published packages must not run code at install time (README, Security).`);
      }
    }
    // npm adds an implicit "node-gyp rebuild" install script when binding.gyp exists.
    assert.ok(!existsSync(new URL(`${dir}/binding.gyp`, root)), `${dir}/binding.gyp makes npm run node-gyp at install time.`);
  });
}
