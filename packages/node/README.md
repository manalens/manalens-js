# @manalens/node

Manalens for Node.js ([open source](https://github.com/manalens/manalens-js)). It sends `track`, `identify` and `traits` events to `POST /v0/events` with batching, a flush timer and retries (exponential backoff with jitter, `Retry-After`). No dependencies. Node.js 20.3 or newer.

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

## Traits

`traits()` sets traits on a player, with or without a user ID. Without
`userId`, the traits belong to the anonymous ID (one game install or browser).
A `null` value clears a trait.

```ts
analytics.traits({ anonymousId: installId, traits: { level: 3, discord_id: '123456789012345678' } });
analytics.traits({ userId: 'player_123', traits: { email: 'ana@example.com' } });
```

Server mode can set the protected traits `email`, `itch_user_id`,
`stripe_customer_id` and `paddle_customer_id`. App mode drops them with one
warning, because the collector drops them from app events.

## Verify Steam ownership

`link()` links the Steam account of a player with a Steam ticket. The game
makes the ticket with `GetAuthTicketForWebApi("manalens")` and sends you the
ticket bytes. Manalens checks the ticket with Steam and reads which of your
apps the account owns.

```ts
const result = await analytics.link({ provider: 'steam', ticket: ticketHex, anonymousId: installId, userId: 'player_123' });
if (!result.linked) console.warn('Steam link failed', result.status, result.code);
```

- It posts once to `<apiEndpoint>/v0/link`. `apiEndpoint` defaults to the
  `endpoint` with an `events.` host changed to `api.`.
- Server mode sends the secret key and may send `userId`. App mode sends the
  publishable key and its own anonymous ID, and never sends `userId`.
- A refusal is not sent again. After a `429` with `Retry-After` (up to 60 s),
  it tries once more. It returns `{ linked, status, code? }` and never throws
  for an HTTP or network error. A bad call throws.

See [Steam ownership](https://docs.manalens.dev/features/steam-ownership) and
the [Link API](https://docs.manalens.dev/api/link).

Full guide: [docs.manalens.dev/sdks/node](https://docs.manalens.dev/sdks/node).

## Install

```sh
npm install @manalens/node
```

## Develop

From the repository root (a pnpm workspace):

```bash
pnpm --filter @manalens/node build      # dist/esm and dist/cjs
pnpm --filter @manalens/node typecheck
pnpm --filter @manalens/node test       # builds, then runs test/*.test.mjs against dist/esm
```

The tests use a mocked `fetch` and no network. `test/fixtures/collector-contract.json`
is the collector contract: the request bodies the SDK must send, the app enums,
the key format and the property limits. The Manalens collector repository keeps
the same file and checks it against the collector schemas, so change both
copies together.

## Releasing

Releases use Changesets. See [RELEASING.md](https://github.com/manalens/manalens-js/blob/main/RELEASING.md).
The tag of a Node SDK release is `node-vX.Y.Z`.

## Layout

- `src/Manalens.ts`: client, key and mode checks, event envelope.
- `src/queue/EventQueue.ts`: batching, flush timer, retries.
- `src/utils/keys.ts`: the key format of the collector (prefixes, CRC32 checksum). The contract test checks it.
- `src/validators/`: the collector's rules, so a bad event is dropped and never fails a batch.
