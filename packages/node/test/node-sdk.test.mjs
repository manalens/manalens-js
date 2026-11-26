// @manalens/node unit tests with a mocked fetch. No network. They run against the
// build (dist/esm), the code that is published.
//
// test/fixtures/collector-contract.json is the collector contract. The manalens
// monorepo keeps the same file and checks it against the collector schemas and
// key rules (packages/shared). Change both copies together.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Manalens, SDK_VERSION, APP_PLATFORMS, APP_STOREFRONTS, APP_ENGINES } from '../dist/esm/index.js';
import { retryDelay, parseRetryAfter, isRetryableStatus, refusedEvents } from '../dist/esm/queue/index.js';
import { isWellFormedKey, keyChecksum } from '../dist/esm/utils/keys.js';

const contract = JSON.parse(readFileSync(new URL('./fixtures/collector-contract.json', import.meta.url), 'utf8'));
const contractKey = prefix => contract.keys.find(entry => entry.well_formed && entry.key.startsWith(prefix)).key;
const SECRET = contractKey('mana_sk_');
const PUBLISHABLE = contractKey('mana_pk_');
const API_KEY = contractKey('mana_api_');
/** An old publishable key (no checksum, P-2609): refused in every mode. */
const OLD_KEY = 'ua_' + 'c'.repeat(32);
const LIBRARY = { library_name: '@manalens/node', library_version: SDK_VERSION };

/** The fields the collector knows, by channel: the union of the contract's request fixtures. */
const knownFields = Object.fromEntries(Object.entries(contract.requests).map(([channel, { body }]) => [channel, {
  event: new Set(body.events.flatMap(event => Object.keys(event))),
  context: new Set(body.events.flatMap(event => Object.keys(event.context ?? {}))),
}]));
/** Every body the SDK sends keeps to the contract: batch size and known fields only. */
const assertCollectorAccepts = (body) => {
  const channel = body.events[0].channel;
  assert.ok(body.events.length >= 1 && body.events.length <= contract.batch_limits[channel], `batch of ${body.events.length} ${channel} events`);
  for (const event of body.events) {
    assert.equal(event.channel, channel);
    for (const field of Object.keys(event)) assert.ok(knownFields[channel].event.has(field), `unknown ${channel} field ${field}`);
    for (const field of Object.keys(event.context ?? {})) assert.ok(knownFields[channel].context.has(field), `unknown ${channel} context field ${field}`);
  }
};
const ENDPOINT = 'https://collect.example.com';
const ANON = '11111111-1111-4111-8111-111111111111';
const app = { platform: 'windows', storefront: 'steam', app_version: '1.4.0', build: '571', engine: 'other' };

/** A fetch mock. `responses` items: a status number, a Response, an Error (thrown) or 'hang'. Default 200. */
function mockFetch(responses = []) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.length ? responses.shift() : 200;
    if (next instanceof Error) throw next;
    if (next === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    if (next instanceof Response) return next;
    return new Response(next === 200 ? '{"accepted":1}' : '{"error":{}}', { status: next });
  };
  return { fn, calls };
}

function client(key, options = {}, responses) {
  const mock = mockFetch(responses);
  const logs = [];
  const analytics = new Manalens(key, { endpoint: ENDPOINT, fetch: mock.fn, retryDelay: 1, debug: true, logger: m => logs.push(m), ...options });
  return { analytics, calls: mock.calls, logs };
}

test('server mode accepts only a secret key', () => {
  assert.doesNotThrow(() => new Manalens(SECRET, { endpoint: ENDPOINT }));
  assert.throws(() => new Manalens(PUBLISHABLE, { endpoint: ENDPOINT }), /secret key/);
  assert.throws(() => new Manalens(OLD_KEY, { endpoint: ENDPOINT }), /secret key/);
  assert.throws(() => new Manalens(API_KEY, { endpoint: ENDPOINT }), /API key/);
  assert.throws(() => new Manalens('mana_sk_' + 'a'.repeat(51), { endpoint: ENDPOINT }), /malformed/);
  assert.throws(() => new Manalens(SECRET.slice(0, -1) + (SECRET.endsWith('0') ? '1' : '0'), { endpoint: ENDPOINT }), /malformed/);
  assert.throws(() => new Manalens('', { endpoint: ENDPOINT }), /key is required/);
  assert.throws(() => new Manalens(SECRET, {}), /endpoint/);
  assert.throws(() => new Manalens(SECRET, { endpoint: 'ftp://x' }), /https/);
});

test('app mode refuses a secret key and accepts a publishable key', () => {
  assert.throws(() => new Manalens(SECRET, { endpoint: ENDPOINT, mode: 'app', app }), /not allowed in app mode/);
  assert.throws(() => new Manalens(API_KEY, { endpoint: ENDPOINT, mode: 'app', app }), /API key/);
  assert.throws(() => new Manalens('mana_pk_' + 'b'.repeat(51), { endpoint: ENDPOINT, mode: 'app', app }), /malformed/);
  assert.throws(() => new Manalens('pk_live_123', { endpoint: ENDPOINT, mode: 'app', app }), /publishable key/);
  assert.doesNotThrow(() => new Manalens(PUBLISHABLE, { endpoint: ENDPOINT, mode: 'app', app }));
  assert.throws(() => new Manalens(OLD_KEY, { endpoint: ENDPOINT, mode: 'app', app }), /publishable key/);
  assert.throws(() => new Manalens(PUBLISHABLE, { endpoint: ENDPOINT, mode: 'app' }), /app option/);
  assert.throws(() => new Manalens(PUBLISHABLE, { endpoint: ENDPOINT, mode: 'app', app: { platform: 'ps4' } }), /platform/);
  assert.doesNotThrow(() => new Manalens(PUBLISHABLE, { endpoint: ENDPOINT, mode: 'app', app: { platform: 'switch2', storefront: 'nintendo' } }));
  assert.throws(() => new Manalens(PUBLISHABLE, { endpoint: ENDPOINT, mode: 'app', app, anonymousId: 'nope' }), /UUID/);
});

test('server event shape, Bearer secret key and context.ip passthrough', async () => {
  const { analytics, calls } = client(SECRET);
  analytics.track({ event: 'match_won', userId: 'player_1', properties: { map: 'harbor', kills: 7 }, context: { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 Test', locale: 'en-SG' } });
  analytics.identify({ userId: 'player_1', anonymousId: ANON, traits: { plan: 'pro' } });
  await analytics.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ENDPOINT}/v0/events`);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].init.headers['x-publishable-key'], undefined);
  assert.equal(calls[0].init.headers['x-write-key'], undefined);
  const [track, identify] = calls[0].body.events;
  assert.equal(track.channel, 'server');
  assert.equal(track.type, 'track');
  assert.equal(track.event, 'match_won');
  assert.equal(track.user_id, 'player_1');
  assert.deepEqual(track.properties, { map: 'harbor', kills: 7 });
  assert.deepEqual(track.context, { ip: '203.0.113.7', user_agent: 'Mozilla/5.0 Test', locale: 'en-SG', ...LIBRARY });
  assertCollectorAccepts(calls[0].body);
  assert.match(track.message_id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(track.original_timestamp)));
  assert.equal(track.anonymous_id, undefined, 'server mode does not invent an anonymous_id');
  assert.equal(track.version, undefined);
  assert.equal(identify.type, 'identify');
  assert.deepEqual(identify.traits, { plan: 'pro' });
  assert.equal(identify.anonymous_id, ANON);
  assert.deepEqual(identify.context, LIBRARY);
});

test('server mode sends the app option as context.app', async () => {
  const { analytics, calls } = client(SECRET, { app: { platform: 'linux', engine: 'godot' } });
  analytics.track({ event: 'match_end', userId: 'p1' });
  await analytics.flush();
  assert.deepEqual(calls[0].body.events[0].context, { app: { platform: 'linux', engine: 'godot' }, ...LIBRARY });
  assertCollectorAccepts(calls[0].body);
});

test('app mode events match the collector schema', async () => {
  const { analytics, calls } = client(PUBLISHABLE, { mode: 'app', app, locale: 'en' });
  analytics.track({ event: 'app_opened', properties: { first_run: true } });
  analytics.identify({ userId: 'steam:7656', traits: { name: 'Ana' } });
  analytics.track({ event: 'level_complete', anonymousId: ANON, properties: { level: 3 } });
  await analytics.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['x-publishable-key'], PUBLISHABLE);
  assert.equal(calls[0].init.headers['x-write-key'], undefined);
  assert.equal(calls[0].init.headers.authorization, undefined);
  assertCollectorAccepts(calls[0].body);
  const [first, second, third] = calls[0].body.events;
  assert.equal(first.channel, 'app');
  assert.equal(first.version, SDK_VERSION);
  assert.deepEqual(first.context.app, app);
  assert.equal(first.context.locale, 'en');
  assert.equal(first.context.library_name, '@manalens/node');
  assert.equal(first.context.library_version, SDK_VERSION);
  assert.equal(first.anonymous_id, analytics.getAnonymousId());
  assert.equal(second.anonymous_id, first.anonymous_id, 'one anonymous_id per process');
  assert.equal(first.session_id, analytics.getSessionId());
  assert.equal(second.session_id, first.session_id);
  assert.equal(third.anonymous_id, ANON, 'per-call anonymousId wins');
});

test('app mode getSessionId works before the first event and matches it', async () => {
  const { analytics, calls } = client(PUBLISHABLE, { mode: 'app', app });
  const before = analytics.getSessionId();
  assert.match(before, /^[0-9a-f-]{36}$/);
  assert.equal(analytics.getSessionId(), before, 'a second read keeps the session');
  analytics.track({ event: 'app_opened' });
  await analytics.flush();
  assert.equal(calls[0].body.events[0].session_id, before);
});

test('app mode starts a new session after 30 minutes without events and when the session is 24 hours old', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-01T00:00:00Z') });
  const { analytics, calls } = client(PUBLISHABLE, { mode: 'app', app, flushAt: 1000 });
  const first = analytics.getSessionId();
  // An event every 20 minutes keeps the session, until it is 24 hours old.
  for (let minutes = 20; minutes < 24 * 60; minutes += 20) { t.mock.timers.tick(20 * 60_000); analytics.track({ event: 'tick' }); }
  assert.equal(analytics.getSessionId(), first, 'one session for 23 hours and 40 minutes of activity');
  t.mock.timers.tick(20 * 60_000);
  const second = analytics.getSessionId();
  assert.notEqual(second, first, 'a new session at 24 hours');
  analytics.track({ event: 'after_a_day' });
  // 30 minutes without events ends a session; exactly 30 minutes does not.
  t.mock.timers.tick(30 * 60_000);
  assert.equal(analytics.getSessionId(), second);
  t.mock.timers.tick(30 * 60_000 + 1);
  const third = analytics.getSessionId();
  assert.notEqual(third, second, 'a new session after more than 30 minutes without events');
  t.mock.timers.reset();
  await analytics.flush();
  const sent = calls.flatMap(call => call.body.events);
  assert.deepEqual([...new Set(sent.map(event => event.session_id))], [first, second]);
  assert.equal(sent.filter(event => event.session_id === first).length, 71);
});

test('app mode drops an event whose sessionId is the anonymousId; a fixed sessionId is never rotated', async t => {
  const logs = [];
  const { analytics, calls } = client(PUBLISHABLE, { mode: 'app', app, anonymousId: ANON, sessionId: 'electron-1', debug: true, logger: message => logs.push(message) });
  analytics.track({ event: 'bad', sessionId: ANON });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 48 * 3_600_000 });
  analytics.track({ event: 'good', timestamp: new Date() });
  t.mock.timers.reset();
  await analytics.flush();
  assert.deepEqual(calls.flatMap(call => call.body.events).map(event => [event.event, event.session_id]), [['good', 'electron-1']]);
  assert.ok(logs.some(line => /sessionId.*must not be the anonymousId/.test(line)), logs.join('\n'));
});

test('server mode sends the sessionId of each call and none by default', async () => {
  const { analytics, calls } = client(SECRET, {});
  analytics.track({ event: 'purchase_completed', userId: 'u1', anonymousId: ANON, sessionId: '22222222-2222-4222-8222-222222222222', properties: { revenue: 9.99, currency: 'USD' } });
  analytics.identify({ userId: 'u1', anonymousId: ANON, sessionId: '22222222-2222-4222-8222-222222222222' });
  analytics.track({ event: 'subscription_renewed', userId: 'u1' });
  await analytics.flush();
  const events = calls.flatMap(call => call.body.events);
  assert.deepEqual(events.map(event => event.session_id), ['22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', undefined]);
  assert.equal('session_id' in events[2], false, 'no session ID stays valid for a server event');
});

test('server mode has no session ID', () => {
  const { analytics } = client(SECRET, {});
  assert.equal(analytics.getSessionId(), undefined);
});

test('app mode keeps a given anonymousId and sessionId', async () => {
  const { analytics, calls } = client(PUBLISHABLE, { mode: 'app', app, anonymousId: ANON, sessionId: 'electron-1' });
  analytics.track({ event: 'window_opened' });
  await analytics.flush();
  assert.equal(calls[0].body.events[0].anonymous_id, ANON);
  assert.equal(calls[0].body.events[0].session_id, 'electron-1');
});

test('batches hold at most 100 server events', async () => {
  const { analytics, calls } = client(SECRET, { flushAt: 500, maxQueueLength: 1000 });
  for (let i = 0; i < 250; i++) analytics.track({ event: 'tick', userId: `u${i}` });
  await analytics.flush();
  assert.deepEqual(calls.map(c => c.body.events.length), [100, 100, 50]);
  for (const call of calls) assertCollectorAccepts(call.body);
  const ids = new Set(calls.flatMap(c => c.body.events.map(e => e.message_id)));
  assert.equal(ids.size, 250);
});

test('batches hold at most 50 app events', async () => {
  const { analytics, calls } = client(PUBLISHABLE, { mode: 'app', app, flushAt: 100 });
  for (let i = 0; i < 120; i++) analytics.track({ event: 'tick' });
  await analytics.flush();
  assert.deepEqual(calls.map(c => c.body.events.length), [50, 50, 20]);
  for (const call of calls) assertCollectorAccepts(call.body);
});

test('flushAt sends without a flush() call', async () => {
  const { analytics, calls } = client(SECRET, { flushAt: 2 });
  analytics.track({ event: 'a', userId: 'u' });
  assert.equal(calls.length, 0);
  analytics.track({ event: 'b', userId: 'u' });
  await analytics.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.events.length, 2);
});

test('flushInterval sends a partial batch', async () => {
  const { analytics, calls } = client(SECRET, { flushInterval: 1000 });
  analytics.track({ event: 'a', userId: 'u' });
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(calls.length, 1);
  await analytics.shutdown();
});

test('retries 5xx, 408, 429 and network errors with the same message_id', async () => {
  const { analytics, calls, logs } = client(SECRET, {}, [500, 408, new Response('', { status: 429, headers: { 'retry-after': '0' } }), new TypeError('fetch failed'), 200]);
  analytics.track({ event: 'purchase', userId: 'u', messageId: '22222222-2222-4222-8222-222222222222' });
  analytics.track({ event: 'refund', userId: 'u' });
  // retryCount 3 means 4 attempts: the 5th response is not reached.
  await analytics.flush();
  assert.equal(calls.length, 4);
  const bodies = calls.map(c => c.init.body);
  assert.ok(bodies.every(body => body === bodies[0]), 'every retry sends the same body');
  assert.equal(calls[0].body.events[0].message_id, '22222222-2222-4222-8222-222222222222');
  assert.ok(logs.some(m => /dropped 2 events after 4 attempts/.test(m)));
});

test('a retry that succeeds sends once more and stops', async () => {
  const { analytics, calls, logs } = client(SECRET, {}, [503, 200]);
  analytics.track({ event: 'a', userId: 'u' });
  await analytics.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.ok(!logs.some(m => /dropped/.test(m)));
});

test('other 4xx drops the batch without a retry', async () => {
  for (const status of [400, 401, 403, 413]) {
    const { analytics, calls, logs } = client(SECRET, {}, [status]);
    analytics.track({ event: 'a', userId: 'u' });
    await analytics.flush();
    assert.equal(calls.length, 1, `status ${status}`);
    assert.ok(logs.some(m => m.includes(`dropped 1 events: HTTP ${status}`)), `status ${status}`);
  }
});

test('refused events of an accepted batch are logged and not sent again (P-2787)', async () => {
  const body = { accepted: 1, rejected: 2, errors: [{ index: 1, message_id: null, code: 'INVALID_EVENT', message: 'x' }, { index: 2, message_id: null, code: 'INVALID_EVENT', message: 'y' }] };
  const { analytics, calls, logs } = client(SECRET, {}, [new Response(JSON.stringify(body), { status: 202 })]);
  analytics.track({ event: 'a', userId: 'u' });
  analytics.track({ event: 'b', userId: 'u' });
  analytics.track({ event: 'c', userId: 'u' });
  await analytics.flush();
  assert.equal(calls.length, 1, 'no retry');
  assert.ok(logs.some(m => m.includes('dropped 2 of 3 events: refused by the collector (INVALID_EVENT)')), logs.join('\n'));
  // An older collector (no rejected field), an empty or a broken body: nothing extra is logged, and the send still succeeds.
  for (const text of ['{"accepted":1}', '', 'not json', '{"rejected":0,"errors":[]}']) assert.equal(refusedEvents(text), undefined, text);
});

test('backoff, jitter and Retry-After', () => {
  assert.equal(retryDelay(0, 1000, undefined, () => 0), 500);
  assert.equal(retryDelay(0, 1000, undefined, () => 1), 1000);
  assert.equal(retryDelay(2, 1000, undefined, () => 1), 4000);
  for (let i = 0; i < 50; i++) {
    const delay = retryDelay(1, 1000);
    assert.ok(delay >= 1000 && delay <= 2000);
  }
  assert.equal(retryDelay(10, 1000, undefined, () => 1), 60000, 'capped at 60 s');
  assert.equal(retryDelay(0, 1000, 7000), 7000, 'Retry-After wins over backoff');
  assert.equal(retryDelay(0, 1000, 600000), 60000);
  assert.equal(parseRetryAfter('12'), 12000);
  assert.equal(parseRetryAfter(new Date(Date.UTC(2026, 0, 1, 0, 0, 30)).toUTCString(), Date.UTC(2026, 0, 1)), 30000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.deepEqual([408, 429, 500, 503, 599, 400, 401, 404, 413, 422].map(isRetryableStatus), [true, true, true, true, true, false, false, false, false, false]);
});

test('Retry-After sets the wait before the retry', async () => {
  const { analytics, calls } = client(SECRET, {}, [new Response('', { status: 429, headers: { 'retry-after': '1' } }), 200]);
  analytics.track({ event: 'a', userId: 'u' });
  const started = Date.now();
  await analytics.flush();
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started >= 950, 'waited about 1 s, not the 1 ms retryDelay');
});

test('invalid events are dropped with a debug log, never thrown', async () => {
  const { analytics, calls, logs } = client(SECRET);
  assert.doesNotThrow(() => {
    analytics.track({ event: '', userId: 'u' });
    analytics.track({ event: 'x'.repeat(129), userId: 'u' });
    analytics.track({ event: 'a' });
    analytics.track({ event: 'a', userId: 'u'.repeat(256) });
    analytics.track({ event: 'a', userId: 'u', properties: { nested: { a: 1 } } });
    analytics.track({ event: 'a', userId: 'u', properties: { n: Number.NaN } });
    analytics.track({ event: 'a', userId: 'u', properties: { s: 'x'.repeat(1025) } });
    analytics.track({ event: 'a', userId: 'u', anonymousId: 'not-a-uuid' });
    analytics.track({ event: 'a', userId: 'u', sessionId: 'has space' });
    analytics.track({ event: 'a', userId: 'u', context: { ip: 'not-an-ip' } });
    analytics.track({ event: 'a', userId: 'u', context: { country: 'SGP' } });
    analytics.track({ event: 'a', userId: 'u', context: { device: 'watch' } });
    analytics.track({ event: 'a', userId: 'u', context: { app: { platform: 'windows', storefront: 'switch' } } });
    analytics.track({ event: 'a', userId: 'u', timestamp: 'yesterday' });
    analytics.track({ event: 'a', userId: 'u', timestamp: new Date(Date.now() + 3_600_000) });
    analytics.identify({ anonymousId: ANON });
    analytics.identify({ userId: 'u', traits: { ['k'.repeat(101)]: 1 } });
    analytics.track(null);
  });
  analytics.track({ event: 'ok', userId: 'u', context: { ip: '2001:db8::1', country: 'sg', device: 'desktop', page: { path: '/shop', url: 'https://example.com/shop' } } });
  await analytics.flush();
  assertCollectorAccepts(calls[0].body);
  assert.equal(logs.filter(m => m.includes('dropped track') || m.includes('dropped identify')).length, 18);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.events.map(e => e.event), ['ok']);
});

test('old timestamps pass in server mode (backfill) and fail in app mode', async () => {
  const old = new Date(Date.now() - 30 * 24 * 3_600_000);
  const server = client(SECRET);
  server.analytics.track({ event: 'backfill', userId: 'u', timestamp: old });
  await server.analytics.flush();
  assert.equal(server.calls[0].body.events[0].original_timestamp, old.toISOString());
  assertCollectorAccepts(server.calls[0].body);
  const appClient = client(PUBLISHABLE, { mode: 'app', app });
  appClient.analytics.track({ event: 'late', timestamp: old });
  await appClient.analytics.flush();
  assert.equal(appClient.calls.length, 0);
  assert.ok(appClient.logs.some(m => /7 days/.test(m)));
});

test('app mode drops a bad per-call app context', async () => {
  const { analytics, calls, logs } = client(PUBLISHABLE, { mode: 'app', app });
  analytics.track({ event: 'a', context: { app: { platform: 'windows', build: 'bad/build' } } });
  analytics.track({ event: 'b', context: { app: { platform: 'windows', extra: 1 } } });
  await analytics.flush();
  assert.equal(calls.length, 0);
  assert.equal(logs.filter(m => m.includes('dropped track')).length, 2);
});

test('shutdown sends queued events, stops, and drops later calls', async () => {
  const { analytics, calls, logs } = client(SECRET, { flushInterval: 60_000 });
  analytics.track({ event: 'a', userId: 'u' });
  await analytics.shutdown();
  assert.equal(calls.length, 1);
  analytics.track({ event: 'b', userId: 'u' });
  await analytics.flush();
  assert.equal(calls.length, 1);
  assert.ok(logs.some(m => /shut down/.test(m)));
});

test('shutdown gives up after its timeout', async () => {
  const { analytics, calls, logs } = client(SECRET, { timeout: 60_000 }, ['hang']);
  analytics.track({ event: 'a', userId: 'u' });
  const started = Date.now();
  await analytics.shutdown(100);
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(logs.some(m => /shutdown timed out/.test(m)));
});

test('contract: the SDK sends the request fixtures', async () => {
  for (const [channel, spec] of Object.entries(contract.requests)) {
    const { analytics, calls } = client(channel === 'server' ? SECRET : PUBLISHABLE, spec.options);
    const before = Date.now();
    for (const [method, call] of spec.calls) analytics[method](call);
    await analytics.flush();
    assert.equal(calls.length, 1, channel);
    const sent = calls[0].body;
    for (const event of sent.events) {
      const sentAt = Date.parse(event.original_timestamp);
      assert.ok(sentAt >= before - 1000 && sentAt <= Date.now() + 1000, `${channel} original_timestamp is the send time`);
    }
    const expected = JSON.parse(JSON.stringify(spec.body).replaceAll('{{sdk_version}}', SDK_VERSION));
    for (const [index, event] of expected.events.entries()) event.original_timestamp = sent.events[index].original_timestamp;
    assert.deepEqual(sent, expected, channel);
  }
});

test('contract: app enums match the collector', () => {
  assert.deepEqual([...APP_PLATFORMS], contract.app_enums.platforms);
  assert.deepEqual([...APP_STOREFRONTS], contract.app_enums.storefronts);
  assert.deepEqual([...APP_ENGINES], contract.app_enums.engines);
});

test('contract: key format matches the collector', () => {
  for (const { key, well_formed } of contract.keys) assert.equal(isWellFormedKey(key), well_formed, key.slice(0, 12));
  for (const { text, checksum } of contract.checksums) assert.equal(keyChecksum(text), checksum, text.slice(0, 12));
});

test('contract: property limits match the collector (P-2700)', async () => {
  const { checkProperties, ValidationError } = await import('../dist/esm/validators/validate.js');
  for (const c of contract.properties) {
    const value = Object.fromEntries(Array.from({ length: c.count }, (_, i) => [c.key_length === undefined ? `k${i}` : 'a'.repeat(c.key_length), c.value_char ? c.value_char.repeat(c.value_length) : c.value]));
    let accepted = true;
    try { checkProperties('properties', value); } catch (error) { assert.ok(error instanceof ValidationError); accepted = false; }
    assert.equal(accepted, c.accepted, JSON.stringify(c));
  }
});

test('SDK_VERSION equals package.json version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(SDK_VERSION, pkg.version);
  assert.equal(pkg.name, LIBRARY.library_name);
});

test('traits: server mode sends a traits event with an anonymous ID or a user ID, protected traits included (P-2814)', async () => {
  const { analytics, calls } = client(SECRET);
  analytics.traits({ anonymousId: ANON, traits: { level: 3, email: 'ana@example.com' } });
  analytics.traits({ userId: 'player_1', traits: { stripe_customer_id: 'cus_1', note: null } });
  await analytics.flush();
  const [anon, user] = calls[0].body.events;
  assertCollectorAccepts(calls[0].body);
  assert.equal(anon.type, 'traits');
  assert.equal(anon.event, undefined);
  assert.equal(anon.properties, undefined);
  assert.deepEqual(anon.traits, { level: 3, email: 'ana@example.com' });
  assert.equal(anon.anonymous_id, ANON);
  assert.equal(anon.user_id, undefined);
  assert.deepEqual(user.traits, { stripe_customer_id: 'cus_1', note: null });
  assert.equal(user.user_id, 'player_1');
});

test('traits: app mode drops protected traits with one warning; invalid calls are dropped', async () => {
  const warnings = [];
  const { analytics, calls, logs } = client(PUBLISHABLE, { mode: 'app', app, anonymousId: ANON, debug: false, logger: m => warnings.push(m) });
  analytics.traits({ traits: { email: 'ana@example.com', itch_user_id: '9', level: 3 } });
  analytics.traits({ traits: { paddle_customer_id: 'ctm_1' } });
  analytics.traits({ traits: {} });
  analytics.traits({ traits: { bad: { nested: true } } });
  analytics.traits({ event: 'x', traits: { level: 1 } });
  await analytics.flush();
  assert.equal(logs.length, 0);
  assert.equal(calls.length, 1);
  const events = calls[0].body.events;
  assert.equal(events.length, 2, 'only the valid calls are sent');
  assert.deepEqual(events[0].traits, { level: 3 });
  assert.equal(events[0].anonymous_id, ANON);
  assert.ok(events[0].session_id);
  assert.equal(events[0].event, undefined);
  assert.deepEqual(events[1].traits, { level: 1 });
  assert.equal(events[1].event, undefined, 'a stray event field is not sent');
  assert.equal(warnings.filter(message => message.includes('protected traits')).length, 1, 'one warning');
  assert.ok(!JSON.stringify(calls).includes('ana@example.com'));
});

test('traits: server mode drops a call with neither userId nor anonymousId, or with no traits', async () => {
  const { analytics, calls, logs } = client(SECRET);
  analytics.traits({ traits: { level: 1 } });
  analytics.traits({ userId: 'p', traits: {} });
  analytics.traits({ userId: 'p' });
  await analytics.flush();
  assert.equal(calls.length, 0);
  assert.equal(logs.filter(message => message.includes('dropped traits')).length, 3);
});

const TICKET = '140000000a0b0c0d0e0f101112131415161718191a1b1c1d';
const linkResponse = (status, code, headers = {}) => new Response(status === 200 ? '{"linked":true,"provider":"steam"}' : JSON.stringify({ error: { code, message: 'no' } }), { status, headers });

test('link: server mode posts the ticket with the secret key, the anonymous ID and the user ID to the API host (P-2815)', async () => {
  const { analytics, calls } = client(SECRET, { endpoint: 'https://events.manalens.dev' }, [linkResponse(200)]);
  const result = await analytics.link({ provider: 'steam', ticket: Buffer.from(TICKET, 'hex'), anonymousId: ANON, userId: 'player_1' });
  assert.deepEqual(result, { linked: true, status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.manalens.dev/v0/link');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].init.headers['x-publishable-key'], undefined);
  assert.deepEqual(calls[0].body, { provider: 'steam', ticket: TICKET, anonymous_id: ANON, user_id: 'player_1' });
});

test('link: app mode sends the publishable key and its own anonymous ID, never the user ID; apiEndpoint wins', async () => {
  const { analytics, calls } = client(PUBLISHABLE, { mode: 'app', app, anonymousId: ANON, apiEndpoint: 'https://proxy.example.com/mana/' }, [linkResponse(200)]);
  assert.deepEqual(await analytics.link({ provider: 'steam', ticket: TICKET.toUpperCase(), userId: 'player_1' }), { linked: true, status: 200 });
  assert.equal(calls[0].url, 'https://proxy.example.com/mana/v0/link');
  assert.equal(calls[0].init.headers['x-publishable-key'], PUBLISHABLE);
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(calls[0].body, { provider: 'steam', ticket: TICKET.toUpperCase(), anonymous_id: ANON });
  // Another host (a local collector) serves both paths.
  const local = client(PUBLISHABLE, { mode: 'app', app, endpoint: 'http://localhost:3001' }, [linkResponse(200)]);
  await local.analytics.link({ provider: 'steam', ticket: TICKET });
  assert.equal(local.calls[0].url, 'http://localhost:3001/v0/link');
});

test('link: 4xx and 5xx are not sent again; a 429 with Retry-After is tried once; a network error returns', async t => {
  for (const [status, code] of [[400, 'STEAM_TICKET_INVALID'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [409, 'STEAM_NOT_CONNECTED'], [502, 'STEAM_KEY_REFUSED'], [503, 'NOT_CONFIGURED']]) {
    const { analytics, calls } = client(SECRET, {}, [linkResponse(status, code)]);
    assert.deepEqual(await analytics.link({ provider: 'steam', ticket: TICKET, anonymousId: ANON }), { linked: false, status, code });
    assert.equal(calls.length, 1, `${status} is sent once`);
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const limited = client(SECRET, {}, [linkResponse(429, 'RATE_LIMITED', { 'retry-after': '3' }), linkResponse(429, 'RATE_LIMITED', { 'retry-after': '3' })]);
  const pending = limited.analytics.link({ provider: 'steam', ticket: TICKET, anonymousId: ANON });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3000);
  assert.deepEqual(await pending, { linked: false, status: 429, code: 'RATE_LIMITED' });
  assert.equal(limited.calls.length, 2, 'one more try, then no loop');
  t.mock.timers.reset();
  const long = client(SECRET, {}, [linkResponse(429, 'RATE_LIMITED', { 'retry-after': '120' })]);
  assert.equal((await long.analytics.link({ provider: 'steam', ticket: TICKET, anonymousId: ANON })).status, 429);
  assert.equal(long.calls.length, 1, 'a Retry-After over 60 s is not waited for');
  const offline = client(SECRET, {}, [new TypeError('fetch failed')]);
  assert.deepEqual(await offline.analytics.link({ provider: 'steam', ticket: TICKET, anonymousId: ANON }), { linked: false, status: 0, code: 'NETWORK_ERROR' });
  assert.equal(offline.calls.length, 1);
});

test('link: a bad call throws; after shutdown nothing is sent', async () => {
  const { analytics, calls } = client(SECRET);
  await assert.rejects(analytics.link({ provider: 'epic', ticket: TICKET, anonymousId: ANON }), /provider must be 'steam'/);
  await assert.rejects(analytics.link({ provider: 'steam', ticket: 'abc', anonymousId: ANON }), /ticket must be hex/);
  await assert.rejects(analytics.link({ provider: 'steam', ticket: `${TICKET}0`, anonymousId: ANON }), /ticket must be hex/);
  await assert.rejects(analytics.link({ provider: 'steam', ticket: 'ab'.repeat(2049), anonymousId: ANON }), /ticket must be hex/);
  await assert.rejects(analytics.link({ provider: 'steam', ticket: TICKET }), /anonymousId is required in server mode/);
  await assert.rejects(analytics.link({ provider: 'steam', ticket: TICKET, anonymousId: 'nope' }), /must be a UUID/);
  await analytics.shutdown(10);
  assert.deepEqual(await analytics.link({ provider: 'steam', ticket: TICKET, anonymousId: ANON }), { linked: false, status: 0, code: 'SHUT_DOWN' });
  assert.equal(calls.length, 0);
});
