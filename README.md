# Manalens JavaScript SDKs

Open source JavaScript SDKs for [Manalens](https://manalens.dev), the analytics
and growth engine built for games. This repository is a pnpm workspace with one
folder per npm package.

| Package | Folder | For |
| --- | --- | --- |
| [`@manalens/web`](packages/web) | `packages/web` | Websites, web games, and the Electron renderer: page views, custom events, identified users, UTM parameters, and ad click IDs. Also served as a script tag from cdn.manalens.dev. |
| [`@manalens/node`](packages/node) | `packages/node` | Node.js: server events with the secret key, and app events from the Electron main process or a dedicated game server. |

Each package has its own README with the full guide. The docs are at
[docs.manalens.dev](https://docs.manalens.dev).

## Install

```sh
npm install @manalens/web
npm install @manalens/node
```

## Develop

Node.js 24 and pnpm 11 (see `packageManager` in `package.json`).

```sh
pnpm install
pnpm typecheck   # every package
pnpm build       # every package, one at a time
pnpm test        # every package (see TESTING.md)
```

Run one package with a filter, for example `pnpm --filter @manalens/node test`.

## Security

- **Zero runtime dependencies.** `@manalens/web` and `@manalens/node` have no
  `dependencies`, `optionalDependencies`, `peerDependencies`, or
  `bundleDependencies`, and no install scripts (`preinstall`, `install`,
  `postinstall`, `prepare`). When you install them, you install only our code,
  and nothing runs at install time. `pnpm test` fails if this changes
  (`scripts/zero-dependencies.test.mjs`).
- **Signed releases.** Both packages publish from GitHub Actions with npm
  trusted publishing (OIDC) and provenance. No npm token exists.
- **Dev dependencies.** `pnpm-workspace.yaml` refuses versions younger than 7
  days, non-registry transitive dependencies, and trust downgrades. Only
  `esbuild` may run an install script. CI checks every install with
  [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain) and runs
  `pnpm audit`. Dependabot waits 7 days before it proposes an update.

Report a vulnerability to support@manalens.dev.

## Releasing

Each pull request that changes a package adds a changeset (`pnpm changeset`).
See [RELEASING.md](RELEASING.md).

## License

MIT. See [LICENSE](LICENSE).
