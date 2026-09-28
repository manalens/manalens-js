import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { Analytics } from '../dist/index.js';

function browser(url = 'https://example.com/pricing?email=private%40example.com&utm_source=Newsletter#secret') {
  const window = new EventTarget();
  const document = { title: 'Pricing', referrer: 'https://google.com/search?q=private' };
  Object.defineProperties(document, { cookie: { get() { throw new Error('SDK read cookies'); }, set() { throw new Error('SDK wrote cookies'); } } });
  const forbidden = { get() { throw new Error('SDK read browser storage'); } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...forbidden });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, ...forbidden });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US' } });
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = new URL(url);
  return { window, document };
}

test('ESM SDK sends page and custom events to a local collector without persistent browser storage', async () => {
  browser();
  const received = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ headers: request.headers, body: JSON.parse(body) });
    response.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":2}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalFetch = globalThis.fetch;
  const options = [];
  globalThis.fetch = (url, init) => { options.push(init); return originalFetch(url, init); };
  const sdk = new Analytics({ writeKey: 'ua_example', endpoint: `http://127.0.0.1:${server.address().port}`, flushIntervalMs: 60000 });
  try {
    sdk.track('signup_completed', { plan: 'starter' });
    await sdk.flush();
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-write-key'], 'ua_example');
    assert.equal(options[0].credentials, 'omit');
    const events = received[0].body.events;
    assert.deepEqual(events.map(event => event.type), ['page', 'track']);
    assert.equal(events[0].context.page.path, '/pricing');
    assert.equal(events[0].context.page.url, 'https://example.com/pricing');
    assert.equal(events[0].context.referrer, 'https://google.com');
    assert.equal(events[0].context.utm_source, 'Newsletter');
    assert.deepEqual(events[1].properties, { plan: 'starter' });
    assert.ok(events.every(event => !JSON.stringify(event).includes('private')));
  } finally {
    sdk.destroy(); globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
  }
});

test('browser snippet initializes and sends a pageview', async () => {
  const { window, document } = browser('https://example.com/');
  document.currentScript = { dataset: { writeKey: 'ua_example', endpoint: 'https://collector.example' } };
  const sent = [];
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, setInterval: () => 1, clearInterval: () => {}, fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  assert.ok(window.untitledAnalytics);
  await window.untitledAnalytics.flush();
  assert.equal(sent[0].events[0].type, 'page');
  window.untitledAnalytics.destroy();
});

test('route changes create new pageviews and failed batches retry in memory', async () => {
  const { window } = browser('https://example.com/');
  const sent = [];
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    attempts++;
    return { ok: attempts !== 1, status: attempts === 1 ? 503 : 202 };
  };
  const sdk = new Analytics({ writeKey: 'ua_example', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    await sdk.flush();
    await sdk.flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].events[0].message_id, sent[1].events[0].message_id);
    globalThis.location = new URL('https://example.com/docs?token=private');
    window.dispatchEvent(new Event('popstate'));
    await sdk.flush();
    assert.equal(sent[2].events[0].context.page.path, '/docs');
    assert.equal(sent[2].events[0].context.page.url, 'https://example.com/docs');
  } finally { sdk.destroy(); globalThis.fetch = originalFetch; }
});

test('identify sends a stable user ID and custom traits without browser storage', async () => {
  browser('https://example.com/app');
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  const sdk = new Analytics({ writeKey: 'ua_example', endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000 });
  try {
    await sdk.identify('user_123', { email: 'person@example.com', plan: 'pro', score: 7 });
    sdk.track('signed_in');
    await sdk.flush();
    assert.equal(sent[0].url, 'https://collector.example/v1/identify');
    assert.equal(sent[0].body.user_id, 'user_123');
    assert.equal(sent[0].body.traits.email, 'person@example.com');
    assert.equal(sent[1].body.events[0].user_id, 'user_123');
    sdk.clearUserId();
    sdk.track('signed_out');
    await sdk.flush();
    assert.equal(sent[2].body.events[0].user_id, undefined);
  } finally { sdk.destroy(); globalThis.fetch = originalFetch; }
});

test('disabled tracking sends nothing and event / identity limits are enforced', async t => {
  browser(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: true }; });
  const sdk = new Analytics({ writeKey: 'key', endpoint: 'https://collector.example', disabled: true });
  try {
    sdk.page(); sdk.track('ignored'); await sdk.identify('user', { vip: true }); await sdk.flush();
    assert.equal(calls, 0);
    assert.throws(() => sdk.track(''), /Event name/); assert.throws(() => sdk.track('x'.repeat(129)), /Event name/);
    await assert.rejects(() => sdk.identify(''), /User ID/); await assert.rejects(() => sdk.identify('x'.repeat(256)), /User ID/);
    await assert.rejects(() => sdk.identify('user', { note: 'x'.repeat(2050) }), /2KB/);
  } finally { sdk.destroy(); }
});

test('network retries retain message identity and queued events', async t => {
  browser(); let fail = true; const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); if (fail) { fail = false; throw new Error('offline'); } return { ok: true }; });
  const sdk = new Analytics({ writeKey: 'key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try { sdk.track('purchase', { revenue: 42 }); await sdk.flush(); await sdk.flush(); assert.deepEqual(sent[0].events, sent[1].events); }
  finally { sdk.destroy(); }
});

test('pagehide Web Vitals report is sparse, rounded and sent once with landing path', async t => {
  const { window } = browser('https://example.com/landing?email=private'); const callbacks = {}; const sent = [];
  const module = Object.fromEntries(['LCP','INP','CLS','FCP','TTFB'].map(name => [`on${name}`, callback => { callbacks[name] = callback; }]));
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push({ body: JSON.parse(init.body), init }); return { ok: true }; });
  const sdk = new Analytics({ writeKey: 'key', endpoint: 'https://collector.example', autoPageviews: false, webVitals: module, flushIntervalMs: 60000 });
  try {
    callbacks.LCP({ name: 'LCP', value: 1200.7, navigationType: 'navigate' });
    callbacks.CLS({ name: 'CLS', value: 0.123456 });
    callbacks.INP({ name: 'INP', value: -1 }); callbacks.TTFB({ name: 'TTFB', value: Infinity });
    globalThis.location = new URL('https://example.com/next'); window.dispatchEvent(new Event('pagehide')); await sdk.flush();
    const metric = sent.flatMap(item => item.body.events).find(event => event.type === 'web_vitals');
    assert.equal(metric.context.page.path, '/landing'); assert.equal(metric.properties.lcp, 1201); assert.equal(metric.properties.cls, 0.1235);
    assert.equal(metric.properties.inp, undefined); assert.equal(metric.properties.ttfb, undefined); assert.equal(sent[0].init.keepalive, true);
    window.dispatchEvent(new Event('pagehide')); await sdk.flush(); assert.equal(sent.flatMap(item => item.body.events).filter(event => event.type === 'web_vitals').length, 1);
  } finally { sdk.destroy(); }
});

test('destroy removes navigation and lifecycle listeners and discards pending events', async t => {
  const { window } = browser(); const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(init); return { ok: true }; });
  const sdk = new Analytics({ writeKey: 'key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  sdk.destroy(); globalThis.location = new URL('https://example.com/other'); window.dispatchEvent(new Event('popstate')); window.dispatchEvent(new Event('pagehide')); sdk.track('after_destroy'); await sdk.flush(); assert.equal(sent.length, 0);
});

test('identify failure is surfaced to the caller and successful requests omit credentials', async t => {
  browser(); const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(init); return { ok: false, status: 503 }; });
  const sdk = new Analytics({ writeKey: 'key', endpoint: 'https://collector.example/', autoPageviews: false, flushIntervalMs: 60000 });
  try { await assert.rejects(() => sdk.identify('user', { plan: 'pro' }), /503/); assert.equal(sent[0].credentials, 'omit'); assert.equal(JSON.parse(sent[0].body).page_url, 'https://example.com/pricing'); }
  finally { sdk.destroy(); }
});

test('replay is fail-closed when project config disables recording', async t => {
  browser(); const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ enabled: false }) }; });
  const { startSessionReplay } = await import('../dist/replay.js');
  const stop = startSessionReplay({ writeKey: 'key', endpoint: 'https://collector.example/' });
  await new Promise(resolve => setImmediate(resolve)); stop();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://collector.example/v1/replay/config'); assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.cache, 'no-store');
});

test('replay config network failure does not upload any recordings', async t => {
  browser(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('offline'); });
  const { startSessionReplay } = await import('../dist/replay.js');
  const stop = startSessionReplay({ writeKey: 'key', endpoint: 'https://collector.example' });
  await new Promise(resolve => setImmediate(resolve)); stop(); assert.equal(calls, 1);
});
