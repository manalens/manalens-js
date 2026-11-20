# @manalens/node

Manalens for Node.js. It sends `track` and `identify` events to `POST /v0/events` with batching, a flush timer and retries (exponential backoff with jitter, `Retry-After`). No dependencies. Node.js 20.3 or newer.

Ported from `@formo/analytics-node` without the wallet code.

## Modes

- `server` (default): a backend or a dedicated game server. Uses the **secret key** (`mana_sk_...`). Events have `channel: 'server'`. At most 100 events in a batch.
- `app`: the Electron main process, or a process on the player's machine. Uses the **Publishable key** (`mana_pk_...`), sent in the `x-publishable-key` header. API keys (`mana_api_`, `mana_mcp_`) are refused in both modes. Events have `channel: 'app'` and `context.app`. At most 50 events in a batch.

> Never put the secret key in a game build, a web page or an Electron app. The SDK refuses a secret key in app mode.

## Use

```ts
import { Manalens } from '@manalens/node';

const analytics = new Manalens(process.env.MANALENS_SECRET_KEY!, { endpoint: 'https://collect.example.com' });

analytics.track({ event: 'purchase_confirmed', userId: 'player_123', properties: { sku: 'dlc_1' }, context: { ip: req.ip, userAgent: req.get('user-agent') } });
analytics.identify({ userId: 'player_123', traits: { plan: 'supporter' } });

// Before the process exits. The SDK adds no exit hooks.
await analytics.shutdown();
```

App mode:

```ts
const analytics = new Manalens('mana_pk_...', {
  endpoint: 'https://collect.example.com',
  mode: 'app',
  app: { platform: 'windows', storefront: 'steam', app_version: '1.4.0' },
  anonymousId: savedPlayerUuid,
});
```

Full guide: [docs/sdks/node.mdx](../../docs/sdks/node.mdx).

## Develop

```bash
pnpm --filter @manalens/node build      # dist/esm and dist/cjs
pnpm --filter @manalens/node typecheck
pnpm --filter @manalens/node test       # tests/node-sdk.test.mjs (also part of pnpm test:unit)
```

End-to-end test against the local stack (Postgres, ElasticMQ, Tinybird Local): `pnpm test:node-sdk:local` from the repository root. It makes a test-only project with a new publishable key and secret key, starts its own API, queue and worker, sends events in both modes and checks the rows in the Tinybird Local workspace of this checkout (run `pnpm build:tb:local` first). See `scripts/test-node-sdk-local.mjs`.

Not published to npm yet.

## Layout

- `src/Manalens.ts`: client, key and mode checks, event envelope.
- `src/queue/EventQueue.ts`: batching, flush timer, retries.
- `src/utils/keys.ts`: copy of `packages/shared/src/keys.ts` (prefixes, CRC32 checksum). A unit test checks that they agree.
- `src/validators/`: the collector's rules, so a bad event is dropped and never fails a batch.
