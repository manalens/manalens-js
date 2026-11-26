# Changesets

Each pull request that changes a published package adds a changeset:

```sh
pnpm changeset
```

Pick the package (`@manalens/web`, `@manalens/node`, or both), the bump
(patch, minor, major), and write one line for the changelog. Commit the new
file in this folder with the change.

On main, the release workflow opens a "Version packages" pull request. It
bumps the versions, writes each package's CHANGELOG.md, and updates the
version constants in the code (`pnpm version-packages`). When that pull
request merges, the workflow publishes each package whose version is not on
npm yet. See [RELEASING.md](../RELEASING.md).
