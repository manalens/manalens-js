# Releasing

The packages release with [Changesets](https://github.com/changesets/changesets)
and `.github/workflows/release.yml`. Each package has its own version, changelog
(`packages/*/CHANGELOG.md`), tag, and GitHub release.

| Package | Tag |
| --- | --- |
| `@manalens/web` | `web-vX.Y.Z` |
| `@manalens/node` | `node-vX.Y.Z` |

## Steps

1. In a pull request that changes a package, run `pnpm changeset`. Pick the
   package, the bump, and write one changelog line. Commit the file in
   `.changeset/`.
2. When that pull request merges, the workflow opens or updates the
   "Version packages" pull request. It runs `pnpm version-packages`: this bumps
   `package.json`, writes `CHANGELOG.md`, and sets the version constant in the
   code (`LIBRARY_VERSION` in `packages/web/src/index.ts`, `SDK_VERSION` in
   `packages/node/src/Manalens.ts`).
3. Merge the "Version packages" pull request. Nothing is published yet.
4. Run the **Release** workflow on `main` (Actions, Release, Run workflow):
   - Without "Publish to npm": a dry run. It builds, tests, and packs each
     package whose version is not on npm yet, runs `npm publish --dry-run`, and
     shows the SRI of the packed web snippet in the job summary.
   - With "Publish to npm": the same build, then the publish jobs wait for
     approval in the `npm-publish` environment. They publish the packed
     tarballs with npm trusted publishing (OIDC) and provenance.
5. After the publish, the workflow creates the tag and the GitHub release of
   each package. For `@manalens/web` it first checks that npm serves the
   published tarball and waits until cdn.manalens.dev serves identical bytes of
   `dist/snippet.global.js`. The release notes then hold the pinned snippet tag
   with its `integrity` hash.

The CDN Worker reads `package/dist/snippet.global.js` from the `@manalens/web`
tarball. Keep that path. `.github/workflows/cdn-check.yml` compares every
published version with the CDN every 6 hours.

## npm setup (once per package)

- On npmjs.com, add a trusted publisher to the package: GitHub Actions,
  repository `manalens/manalens-js`, workflow `release.yml`, environment
  `npm-publish`.
- npm can add a trusted publisher only to a package that exists. For the first
  publish of a package, the workflow can use the `NPM_TOKEN` secret instead.
  Delete the secret when both packages have a trusted publisher.

## Notes

- The "Version packages" pull request is made with the workflow's
  `GITHUB_TOKEN`, so the SDK tests workflow does not run on it. Its changes are
  only versions and changelogs. Run `pnpm test` locally if in doubt.
- `node scripts/sync-versions.mjs --check` is part of `pnpm test`: it fails when
  a version constant in the code is not the `package.json` version.
