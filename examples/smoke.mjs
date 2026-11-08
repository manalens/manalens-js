import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { Analytics } from '../dist/index.js';

/** Minimal document.cookie emulation: host-only and domain cookies, expiry, public-suffix rejection. */
function cookieJar({ blocked = false, publicSuffixes = ['com', 'test', 'co.uk'] } = {}) {
  const store = new Map();
  const writes = [];
  const visible = () => {
    const host = globalThis.location.hostname; const now = Date.now();
    return [...store.values()].filter(c => c.expires > now && (c.hostOnly ? c.domain === host : host === c.domain || host.endsWith(`.${c.domain}`)));
  };
  return {
    store, writes,
    get() { if (blocked) return ''; return visible().map(c => `${c.name}=${c.value}`).join('; '); },
    set(raw) {
      writes.push(raw);
      if (blocked) return;
      const [pair, ...attrs] = raw.split(';').map(part => part.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index); const value = pair.slice(index + 1);
      let domain = ''; let expires = Infinity; let maxAge;
      for (const attr of attrs) {
        const [k, v = ''] = attr.split('=');
        const key = k.toLowerCase();
        if (key === 'domain') domain = v.replace(/^\./, '').toLowerCase();
        if (key === 'max-age') maxAge = Number(v);
        if (key === 'expires') expires = new Date(v).getTime();
      }
      if (maxAge !== undefined) expires = maxAge <= 0 ? -1 : Date.now() + maxAge * 1000;
      const host = globalThis.location.hostname;
      if (domain && (publicSuffixes.includes(domain) || !(host === domain || host.endsWith(`.${domain}`)))) return;
      const id = `${domain || host}|${!domain}|${name}`;
      if (expires <= Date.now()) store.delete(id);
      else store.set(id, { name, value, domain: domain || host, hostOnly: !domain, expires });
    },
    /** Value of a named cookie as the current host sees it. */
    read(name) { const c = visible().find(c => c.name === name); return c ? decodeURIComponent(c.value) : undefined; },
    find(prefix) { return [...store.values()].filter(c => c.name.startsWith(prefix) && c.expires > Date.now()); },
  };
}

function memoryStorage(stored = new Map()) {
  return { stored, getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) };
}

function browser(url = 'https://example.com/pricing?email=private%40example.com&utm_source=Newsletter#secret', { jar = cookieJar(), local = memoryStorage(), localBlocked = false } = {}) {
  const window = new EventTarget();
  const document = { title: 'Pricing', referrer: 'https://google.com/search?q=private' };
  Object.defineProperty(document, 'cookie', { configurable: true, get: () => jar.get(), set: value => jar.set(value) });
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { if (localBlocked) throw new Error('blocked'); return local; } });
  delete globalThis.localStorage; delete globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US' } });
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = new URL(url);
  return { window, document, jar, local };
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const collector = (sent) => async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 202 }; };
const eventsOf = sent => sent.flatMap(item => item.body.events || []);

test('ESM SDK sends page and custom events with first-party identity to a local collector', async () => {
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
    assert.equal(events[0].context.library_name, 'Untitled Analytics Web SDK');
    assert.equal(events[0].context.library_version, events[0].version);
    assert.deepEqual(events[1].properties, { plan: 'starter' });
    assert.match(events[0].anonymous_id, uuid);
    assert.match(events[0].session_id, uuid);
    assert.equal(events[1].anonymous_id, events[0].anonymous_id);
    assert.equal(events[1].session_id, events[0].session_id);
    assert.equal(events[0].attribution_consent, undefined);
    assert.ok(events.every(event => !JSON.stringify(event).includes('private')));
  } finally {
    sdk.destroy(); globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
  }
});

test('an Android app referrer such as YouTube is kept as android-app://<package>', async () => {
  const { document } = browser('https://example.com/');
  document.referrer = 'android-app://com.google.android.youtube/';
  const sent = [];
  globalThis.fetch = collector(sent);
  const sdk = new Analytics({ writeKey: 'ua_example', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    await sdk.flush();
    assert.equal(eventsOf(sent)[0].context.referrer, 'android-app://com.google.android.youtube');
  } finally { sdk.destroy(); }
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
  assert.match(sent[0].events[0].anonymous_id, uuid);
  window.untitledAnalytics.destroy();
});

for (const [attr, apex] of [[undefined, true], ['true', true], ['false', false]]) test(`snippet data-cross-subdomain=${attr} ${apex ? 'scopes the cookie to the apex domain' : 'keeps the cookie host-only'}`, async () => {
  const { window, document, jar } = browser('https://play.snippet.com/');
  document.currentScript = { dataset: { writeKey: 'ua_snippet', endpoint: 'https://collector.example', ...(attr ? { crossSubdomain: attr } : {}) } };
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, setInterval: () => 1, clearInterval: () => {}, fetch: async () => ({ ok: true }) });
  const [cookie] = jar.find('ua_').filter(c => c.name.endsWith('_anonymous-id'));
  assert.equal(cookie.domain, apex ? 'snippet.com' : 'play.snippet.com'); assert.equal(cookie.hostOnly, !apex);
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

test('identify works without a wallet, persists user_id, and reset clears identity', async () => {
  const { jar } = browser('https://example.com/app');
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = collector(sent);
  const sdk = new Analytics({ writeKey: 'ua_identify', endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000 });
  try {
    sdk.track('anonymous_step');
    await sdk.identify('user_123', { email: 'person@example.com', plan: 'pro', score: 7 });
    sdk.track('signed_in');
    await sdk.flush();
    assert.ok(sent.every(item => item.url === 'https://collector.example/v1/events'));
    const [before, identify, after] = eventsOf(sent);
    assert.equal(before.user_id, undefined);
    assert.equal(identify.type, 'identify');
    assert.equal(identify.event, undefined);
    assert.equal(identify.user_id, 'user_123');
    assert.deepEqual(identify.traits, { email: 'person@example.com', plan: 'pro', score: 7 });
    assert.equal(identify.anonymous_id, before.anonymous_id);
    assert.equal(after.user_id, 'user_123');
    assert.equal(after.traits, undefined);
    const userCookie = jar.find('ua_').find(c => c.name.endsWith('_user-id'));
    assert.equal(decodeURIComponent(userCookie.value), 'user_123');
    assert.equal(userCookie.expires, Infinity, 'user-id is a browser-session cookie, like Formo');

    // A reload in the same browser session restores user_id from the cookie.
    sdk.destroy();
    const reloaded = new Analytics({ writeKey: 'ua_identify', endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000 });
    assert.equal(reloaded.getUserId(), 'user_123');
    reloaded.reset();
    assert.equal(reloaded.getUserId(), undefined);
    assert.equal(jar.find('ua_').find(c => c.name.endsWith('_user-id')), undefined);
    reloaded.track('signed_out');
    await reloaded.flush();
    const last = eventsOf(sent).at(-1);
    assert.equal(last.user_id, undefined);
    assert.match(last.anonymous_id, uuid);
    assert.notEqual(last.anonymous_id, before.anonymous_id, 'reset() rotates the anonymous ID');
    assert.notEqual(last.session_id, before.session_id, 'reset() starts a new session');
    reloaded.destroy();
  } finally { sdk.destroy(); globalThis.fetch = originalFetch; }
});

test('disabled tracking sends nothing, touches no storage, and event / identity limits are enforced', async t => {
  const { jar, local } = browser(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: true }; });
  const sdk = new Analytics({ writeKey: 'key', endpoint: 'https://collector.example', disabled: true });
  try {
    sdk.page(); sdk.track('ignored'); await sdk.identify('user', { vip: true }); sdk.reset(); await sdk.flush();
    assert.equal(calls, 0); assert.equal(jar.writes.length, 0); assert.equal(local.stored.size, 0);
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

test('pagehide flushes queued events once with keepalive', async t => {
  const { window } = browser(); const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push({ body: JSON.parse(init.body), init }); return { ok: true }; });
  const sdk = new Analytics({ writeKey: 'key', endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000 });
  try {
    sdk.track('before_leave'); window.dispatchEvent(new Event('pagehide')); await sdk.flush();
    assert.equal(sent.length, 1); assert.equal(sent[0].init.keepalive, true);
    assert.deepEqual(sent[0].body.events.map(event => event.event), ['before_leave']);
  } finally { sdk.destroy(); }
});

test('destroy removes navigation and lifecycle listeners and discards pending events', async t => {
  const { window } = browser(); const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(init); return { ok: true }; });
  const sdk = new Analytics({ writeKey: 'key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  sdk.destroy(); globalThis.location = new URL('https://example.com/other'); window.dispatchEvent(new Event('popstate')); window.dispatchEvent(new Event('pagehide')); sdk.track('after_destroy'); await sdk.flush(); assert.equal(sent.length, 0);
});

test('a failed identify is retried with the same message and requests omit credentials', async t => {
  browser(); const sent = []; let fail = true;
  t.mock.method(globalThis, 'fetch', async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); if (fail) { fail = false; return { ok: false, status: 503 }; } return { ok: true }; });
  const sdk = new Analytics({ writeKey: 'key', endpoint: 'https://collector.example/', autoPageviews: false, flushIntervalMs: 60000 });
  try {
    await sdk.identify('user', { plan: 'pro' });
    await sdk.flush();
    assert.equal(sent.length, 2); assert.equal(sent[0].url, 'https://collector.example/v1/events'); assert.equal(sent[0].init.credentials, 'omit');
    assert.equal(sent[0].body.events[0].message_id, sent[1].body.events[0].message_id);
    assert.equal(sent[1].body.events[0].context.page.url, 'https://example.com/pricing');
  } finally { sdk.destroy(); }
});

for (const [key, network] of [['gclid','google'],['gbraid','google'],['wbraid','google'],['fbclid','meta'],['msclkid','microsoft'],['ttclid','tiktok'],['twclid','twitter'],['li_fat_id','linkedin'],['rdt_cid','reddit'],['ScCid','snapchat']]) test(`captures ${key} and carries it across route changes`, async t => {
  const {window}=browser(`https://example.com/?${key}=ad-token&utm_source=${network}&utm_campaign=launch`); const sent=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});
  const sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',flushIntervalMs:60000});
  try { globalThis.location=new URL('https://example.com/checkout?email=private');window.dispatchEvent(new Event('popstate'));sdk.track('purchase',{revenue:120});await sdk.identify('customer');await sdk.flush();
    const events=sent.flatMap(x=>x.events||[]); assert.equal(events.length,4);
    for(const event of events){assert.equal(event.context[key],'ad-token');assert.equal(event.context.click_id,'ad-token');assert.equal(event.context.paid_source,network);assert.equal(event.context.utm_campaign,'launch');assert.ok(!JSON.stringify(event.context).includes('private'));}
    assert.equal(events.find(x=>x.type==='identify')?.context[key],'ad-token');
  } finally{sdk.destroy();}
});
test('preserves multiple network IDs and replaces an entire campaign on a new touch',async t=>{
  const {window}=browser('https://example.com/?gclid=g&fbclid=f&utm_source=google&utm_term=old&utm_id=c1&utm_source_platform=google');const sent=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});
  const sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',flushIntervalMs:60000});
  try{globalThis.location=new URL('https://example.com/new?utm_source=newsletter&utm_medium=email');window.dispatchEvent(new Event('popstate'));await sdk.flush();const [first,last]=sent[0].events;assert.equal(first.context.gclid,'g');assert.equal(first.context.fbclid,'f');assert.equal(first.context.click_id,'g');assert.equal(first.context.utm_id,'c1');assert.equal(last.context.utm_source,'newsletter');assert.equal(last.context.gclid,undefined);assert.equal(last.context.utm_term,undefined);assert.equal(last.context.paid_source,undefined);}finally{sdk.destroy();}
});
test('gad_source marks Google traffic but is never a click token; paid UTMs and referral aliases work',async t=>{
  browser('https://example.com/?gad_source=1&referral_code=partner&utm_creative_format=video&utm_marketing_tactic=retargeting');const sent=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});let sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',flushIntervalMs:60000});
  try{await sdk.flush();const c=sent[0].events[0].context;assert.equal(c.paid_source,'google');assert.equal(c.click_id,undefined);assert.equal(c.gad_source,'1');assert.equal(c.ref,'partner');assert.equal(c.utm_creative_format,'video');}finally{sdk.destroy();}
  browser('https://example.com/?utm_medium=paid_social');sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',flushIntervalMs:60000});try{await sdk.flush();assert.equal(sent[1].events[0].context.paid_source,'paid_utm');}finally{sdk.destroy();}
});
test('campaign values reject unsafe and oversized input and arbitrary queries',async t=>{
  browser('https://example.com/?gclid=%3Cscript%3E&utm_term='+ 'x'.repeat(256)+'&email=private&token=secret');const sent=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});const sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',flushIntervalMs:60000});try{await sdk.flush();const c=sent[0].events[0].context;assert.equal(c.gclid,undefined);assert.equal(c.utm_term,undefined);assert.ok(!JSON.stringify(c).includes('secret'));assert.ok(!JSON.stringify(c).includes('private'));}finally{sdk.destroy();}
});
test('UTC midnight drops carried campaign context',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2025-06-20T23:59:59Z').getTime()});const {window}=browser('https://example.com/?gclid=g&utm_source=google');const sent=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});const sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',flushIntervalMs:60000});try{t.mock.timers.tick(2000);globalThis.location=new URL('https://example.com/next');window.dispatchEvent(new Event('popstate'));await sdk.flush();assert.equal(sent[0].events[0].context.gclid,'g');assert.equal(sent[0].events[1].context.gclid,undefined);}finally{sdk.destroy();}
});


const make = (options = {}) => new Analytics({ endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000, writeKey: 'ua_identity', ...options });
async function firstEvent(sdk, sent) { sdk.track('probe'); await sdk.flush(); return eventsOf(sent).at(-1); }

test('anonymous ID is created on first load, stored in a one-year cookie, survives reloads and is write-key scoped', async t => {
  const jar = cookieJar(); const local = memoryStorage(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://example.com/', { jar, local });
  let sdk = make();
  const cookie = jar.find('ua_').find(c => c.name.endsWith('_anonymous-id'));
  assert.match(decodeURIComponent(cookie.value), uuid, 'created before any event');
  assert.equal(cookie.hostOnly, false, 'apex-scoped by default, like Formo'); assert.equal(cookie.domain, 'example.com');
  assert.ok(cookie.expires > Date.now() + 364 * 86400000);
  assert.ok(jar.writes.some(raw => raw.includes('samesite=lax') && raw.includes('secure')));
  assert.equal(local.stored.size, 0, 'no localStorage copy while cookies work');
  const first = (await firstEvent(sdk, sent)).anonymous_id;
  assert.equal(sdk.getAnonymousId(), first);
  sdk.destroy();
  browser('https://example.com/other', { jar, local });
  sdk = make(); assert.equal((await firstEvent(sdk, sent)).anonymous_id, first); sdk.destroy();
  sdk = make({ writeKey: 'ua_other_site' }); assert.notEqual((await firstEvent(sdk, sent)).anonymous_id, first); sdk.destroy();
});

test('by default one anonymous ID is shared between example.com and play.example.com', async t => {
  const jar = cookieJar(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://play.shared.com/', { jar });
  let sdk = make({ writeKey: 'ua_cross' });
  const play = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  const cookie = jar.find('ua_').find(c => c.name.endsWith('_anonymous-id'));
  assert.equal(cookie.domain, 'shared.com'); assert.equal(cookie.hostOnly, false);
  browser('https://shared.com/', { jar });
  sdk = make({ writeKey: 'ua_cross' });
  assert.equal((await firstEvent(sdk, sent)).anonymous_id, play); sdk.destroy();
});

test('crossSubdomainCookies: false keeps a separate anonymous ID per host', async t => {
  const jar = cookieJar(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://play.split.com/', { jar });
  let sdk = make({ writeKey: 'ua_split', crossSubdomainCookies: false }); const play = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  browser('https://split.com/', { jar });
  sdk = make({ writeKey: 'ua_split', crossSubdomainCookies: false }); assert.notEqual((await firstEvent(sdk, sent)).anonymous_id, play); sdk.destroy();
});

test('an existing host-only cookie migrates to the apex domain under the default setting', async t => {
  const jar = cookieJar(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://app.migrate.com/', { jar });
  let sdk = make({ writeKey: 'ua_migrate', crossSubdomainCookies: false }); const legacy = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  sdk = make({ writeKey: 'ua_migrate' }); assert.equal((await firstEvent(sdk, sent)).anonymous_id, legacy); sdk.destroy();
  const cookies = jar.find('ua_').filter(c => c.name.endsWith('_anonymous-id'));
  assert.equal(cookies.length, 1); assert.equal(cookies[0].domain, 'migrate.com');
});

test('blocked cookies fall back to localStorage, then to memory', async t => {
  const local = memoryStorage(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://nocookie.test/', { jar: cookieJar({ blocked: true }), local });
  let sdk = make({ writeKey: 'ua_fallback' }); const stored = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  assert.match(stored, uuid);
  assert.ok([...local.stored.values()].includes(stored));
  browser('https://nocookie.test/', { jar: cookieJar({ blocked: true }), local });
  sdk = make({ writeKey: 'ua_fallback' }); assert.equal((await firstEvent(sdk, sent)).anonymous_id, stored); sdk.destroy();

  browser('https://nothing.test/', { jar: cookieJar({ blocked: true }), localBlocked: true });
  sdk = make({ writeKey: 'ua_memory_only' });
  const a = await firstEvent(sdk, sent); const b = await firstEvent(sdk, sent);
  assert.match(a.anonymous_id, uuid); assert.equal(a.anonymous_id, b.anonymous_id, 'memory keeps the ID for the page lifetime');
  sdk.destroy();
});

test('a localStorage ID is adopted into the cookie and the fallback copy is removed', async t => {
  const local = memoryStorage(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://adopt.test/', { jar: cookieJar({ blocked: true }), local });
  let sdk = make({ writeKey: 'ua_adopt' }); const id = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  const { jar } = browser('https://adopt.test/', { local });
  sdk = make({ writeKey: 'ua_adopt' }); assert.equal((await firstEvent(sdk, sent)).anonymous_id, id); sdk.destroy();
  assert.equal(decodeURIComponent(jar.find('ua_').find(c => c.name.endsWith('_anonymous-id')).value), id);
  assert.ok(![...local.stored.values()].includes(id));
});

test('session_id is stable during activity and rotates after 30 minutes of inactivity', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://example.com/');
  const sdk = make({ writeKey: 'ua_session' });
  try {
    const a = await firstEvent(sdk, sent);
    t.mock.timers.tick(29 * 60000); const b = await firstEvent(sdk, sent);
    t.mock.timers.tick(29 * 60000); const c = await firstEvent(sdk, sent);
    t.mock.timers.tick(31 * 60000); const d = await firstEvent(sdk, sent);
    assert.equal(a.session_id, b.session_id); assert.equal(b.session_id, c.session_id);
    assert.notEqual(c.session_id, d.session_id); assert.match(d.session_id, uuid);
    assert.equal(a.anonymous_id, d.anonymous_id, 'anonymous ID outlives the session');
  } finally { sdk.destroy(); }
});

test('optOut drops queued events, clears identity, persists across reloads, and optIn resumes', async t => {
  const jar = cookieJar(); const local = memoryStorage(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://example.com/', { jar, local });
  let sdk = make({ writeKey: 'ua_optout' });
  sdk.track('queued'); await sdk.identify('user_1');
  const before = eventsOf(sent).at(-1).anonymous_id; const count = sent.length;
  sdk.track('queued_then_dropped'); sdk.optOut();
  assert.equal(sdk.isOptedOut(), true); assert.equal(sdk.getUserId(), undefined); assert.equal(sdk.getAnonymousId(), undefined);
  sdk.track('ignored'); await sdk.identify('user_2'); await sdk.flush();
  assert.equal(sent.length, count);
  assert.deepEqual(jar.find('ua_').filter(c => !c.name.endsWith('_opt-out')), []);
  sdk.destroy();
  sdk = make({ writeKey: 'ua_optout' }); assert.equal(sdk.isOptedOut(), true); sdk.track('still_ignored'); await sdk.flush(); assert.equal(sent.length, count);
  sdk.optIn(); const after = await firstEvent(sdk, sent);
  assert.match(after.anonymous_id, uuid); assert.notEqual(after.anonymous_id, before); assert.equal(after.user_id, undefined);
  sdk.destroy();
});

test('requireConsent: no storage and no identity fields until setConsent(true)', async t => {
  const { jar, local } = browser('https://consent.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = make({ writeKey: 'ua_consent', requireConsent: true });
  try {
    sdk.track('before'); await sdk.identify('user_c', { plan: 'pro' }); await sdk.flush();
    assert.equal(jar.writes.length, 0); assert.equal(local.stored.size, 0); assert.equal(sdk.getAnonymousId(), undefined);
    const [before] = eventsOf(sent);
    assert.equal(before.type, 'track');
    for (const field of ['anonymous_id', 'session_id', 'user_id']) assert.equal(before[field], undefined);
    assert.equal(eventsOf(sent).some(event => event.type === 'identify'), false, 'identify waits for consent');
    sdk.setConsent(true); sdk.track('after'); await sdk.flush();
    const events = eventsOf(sent);
    const identify = events.find(event => event.type === 'identify'); const after = events.at(-1);
    assert.equal(identify.user_id, 'user_c'); assert.deepEqual(identify.traits, { plan: 'pro' });
    assert.match(after.anonymous_id, uuid); assert.match(after.session_id, uuid); assert.equal(after.user_id, 'user_c');
    assert.ok(jar.find('ua_').some(c => c.name.endsWith('_anonymous-id')));
  } finally { sdk.destroy(); }
});

test('setConsent(false) clears identity storage and strips identity from queued events', async t => {
  const { jar, local } = browser('https://withdraw.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = make({ writeKey: 'ua_withdraw', requireConsent: true });
  try {
    sdk.setConsent(true);
    await sdk.identify('user_w', { plan: 'pro' });
    sdk.track('queued');
    sdk.setConsent(false);
    assert.deepEqual(jar.find('ua_'), []); assert.equal(local.stored.size, 0); assert.equal(sdk.getUserId(), undefined);
    const writes = jar.writes.length;
    sdk.track('later'); await sdk.flush();
    const [queued, later] = eventsOf(sent).slice(-2);
    for (const event of [queued, later]) for (const field of ['anonymous_id', 'session_id', 'user_id']) assert.equal(event[field], undefined);
    assert.equal(queued.event, 'queued'); assert.equal(later.event, 'later');
    assert.equal(jar.writes.length, writes, 'no storage writes after withdrawal');
  } finally { sdk.destroy(); }
});

test('snippet data-require-consent="true" starts without browser storage', async () => {
  const { window, document, jar } = browser('https://snippet-consent.com/');
  document.currentScript = { dataset: { writeKey: 'ua_snippet_consent', endpoint: 'https://collector.example', requireConsent: 'true' } };
  const sent = [];
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, setInterval: () => 1, clearInterval: () => {}, fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  await window.untitledAnalytics.flush();
  assert.equal(jar.writes.length, 0); assert.equal(sent[0].events[0].anonymous_id, undefined);
  window.untitledAnalytics.destroy();
});

function gatedFetch(sent) {
  let release;
  const fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    if (release === undefined) return { ok: true };
    const gate = release; release = undefined; await gate.promise; throw new Error('offline');
  };
  return { fetch, holdNext() { let resolve; const promise = new Promise(r => { resolve = r; }); release = { promise }; return resolve; } };
}

test('a failed in-flight batch is re-queued without identity after setConsent(false)', async t => {
  browser('https://race.com/');
  const sent = []; const gate = gatedFetch(sent); t.mock.method(globalThis, 'fetch', gate.fetch);
  const sdk = make({ writeKey: 'ua_race', requireConsent: true });
  try {
    sdk.setConsent(true);
    sdk.track('a');
    const open = gate.holdNext();
    const pendingIdentify = sdk.identify('user_r', { plan: 'pro' });
    await new Promise(resolve => setImmediate(resolve));
    sdk.setConsent(false);
    open(); await pendingIdentify;
    await sdk.flush();
    const retried = sent.at(-1).body.events;
    assert.deepEqual(retried.map(event => event.event ?? event.type), ['a']);
    for (const field of ['anonymous_id', 'session_id', 'user_id']) assert.equal(retried[0][field], undefined);
  } finally { sdk.destroy(); }
});

test('a failed in-flight batch is dropped after optOut()', async t => {
  browser('https://race-optout.com/');
  const sent = []; const gate = gatedFetch(sent); t.mock.method(globalThis, 'fetch', gate.fetch);
  const sdk = make({ writeKey: 'ua_race_optout' });
  try {
    sdk.track('a');
    const open = gate.holdNext();
    const flushing = sdk.flush();
    await new Promise(resolve => setImmediate(resolve));
    sdk.optOut(); open(); await flushing;
    sdk.optIn(); await sdk.flush();
    assert.equal(sent.length, 1, 'nothing re-sent after opt-out');
  } finally { sdk.destroy(); }
});

test('consent mode before consent: reset() deletes stored identity and optOut() persists the flag', async t => {
  const jar = cookieJar(); const local = memoryStorage();
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const instances = []; t.after(() => instances.forEach(instance => instance.destroy()));
  const own = options => { const instance = make(options); instances.push(instance); return instance; };
  browser('https://play.delete.com/', { jar, local });
  let sdk = own({ writeKey: 'ua_delete' }); await sdk.identify('user_d'); sdk.destroy();
  local.setItem([...jar.store.values()].find(c => c.name.endsWith('_anonymous-id')).name, 'stale-copy');
  assert.ok(jar.find('ua_').length >= 3);

  sdk = own({ writeKey: 'ua_delete', requireConsent: true });
  sdk.reset();
  assert.deepEqual(jar.find('ua_'), [], 'apex and host cookies cleared without consent');
  assert.equal(local.stored.size, 0, 'localStorage cleared without consent');
  sdk.optOut(); sdk.destroy();
  assert.ok(jar.find('ua_').some(c => c.name.endsWith('_opt-out')));

  sdk = own({ writeKey: 'ua_delete', requireConsent: true });
  const before = sent.length; sdk.track('ignored'); await sdk.flush();
  assert.equal(sdk.isOptedOut(), true); assert.equal(sent.length, before);
  sdk.setConsent(true); assert.equal(sdk.isOptedOut(), true, 'consent does not override opt-out');
  sdk.destroy();
});

for (const [name, change] of [
  ['reset()', sdk => sdk.reset()],
  ['setConsent(false) then setConsent(true)', sdk => { sdk.setConsent(false); sdk.setConsent(true); }],
  ['optOut() then optIn()', sdk => { sdk.optOut(); sdk.optIn(); }],
]) test(`a failed in-flight batch loses its old identity after ${name}`, async t => {
  browser('https://generation.com/');
  const sent = []; const gate = gatedFetch(sent); t.mock.method(globalThis, 'fetch', gate.fetch);
  const sdk = make({ writeKey: `ua_generation_${name.length}` });
  try {
    sdk.track('a');
    const open = gate.holdNext();
    const pendingIdentify = sdk.identify('user_g', { plan: 'pro' });
    await new Promise(resolve => setImmediate(resolve));
    const oldId = sent[0].body.events[0].anonymous_id;
    change(sdk);
    open(); await pendingIdentify;
    sdk.track('b'); await sdk.flush();
    const events = eventsOf(sent.slice(1));
    assert.equal(JSON.stringify(sent.slice(1)).includes(oldId), false, 'old anonymous_id never re-sent');
    assert.equal(events.some(event => event.type === 'identify'), false);
    assert.equal(events.some(event => event.user_id === 'user_g'), false);
    const b = events.find(event => event.event === 'b');
    assert.match(b.anonymous_id, uuid); assert.notEqual(b.anonymous_id, oldId);
    if (name === 'optOut() then optIn()') assert.equal(events.some(event => event.event === 'a'), false, 'opted-out batch is dropped');
    else {
      const a = events.find(event => event.event === 'a');
      for (const field of ['anonymous_id', 'session_id', 'user_id']) assert.equal(a[field], undefined);
    }
  } finally { sdk.destroy(); }
});
