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
  const sdk = new Analytics({ publishableKey: 'mana_pk_example', endpoint: `http://127.0.0.1:${server.address().port}`, flushIntervalMs: 60000 });
  try {
    sdk.track('signup_completed', { plan: 'starter' });
    await sdk.flush();
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-publishable-key'], 'mana_pk_example');
    assert.equal(options[0].credentials, 'omit');
    const events = received[0].body.events;
    assert.deepEqual(events.map(event => event.type), ['page', 'track']);
    assert.equal(events[0].context.page.path, '/pricing');
    assert.equal(events[0].context.page.url, 'https://example.com/pricing');
    assert.equal(events[0].context.referrer, 'https://google.com');
    assert.equal(events[0].context.utm_source, 'Newsletter');
    assert.equal(events[0].context.library_name, 'Manalens Web SDK');
    // The clock's UTC offset in minutes, for install matching (P-2489).
    assert.equal(events[0].context.utc_offset, 0 - new Date().getTimezoneOffset());
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
  const sdk = new Analytics({ publishableKey: 'mana_pk_example', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    await sdk.flush();
    assert.equal(eventsOf(sent)[0].context.referrer, 'android-app://com.google.android.youtube');
  } finally { sdk.destroy(); }
});

test('browser snippet initializes and sends a pageview', async () => {
  const { window, document } = browser('https://example.com/');
  document.currentScript = { dataset: { publishableKey: 'mana_pk_example', endpoint: 'https://collector.example' } };
  const sent = [];
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, setInterval: () => 1, clearInterval: () => {}, fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  assert.ok(window.manalens);
  await window.manalens.flush();
  assert.equal(sent[0].events[0].type, 'page');
  assert.match(sent[0].events[0].anonymous_id, uuid);
  window.manalens.destroy();
});

for (const [attr, apex] of [[undefined, true], ['true', true], ['false', false]]) test(`snippet data-cross-subdomain=${attr} ${apex ? 'scopes the cookie to the apex domain' : 'keeps the cookie host-only'}`, async () => {
  const { window, document, jar } = browser('https://play.snippet.com/');
  document.currentScript = { dataset: { publishableKey: 'mana_pk_snippet', endpoint: 'https://collector.example', ...(attr ? { crossSubdomain: attr } : {}) } };
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, setInterval: () => 1, clearInterval: () => {}, fetch: async () => ({ ok: true }) });
  const [cookie] = jar.find('mana_').filter(c => c.name.endsWith('_anonymous-id'));
  assert.equal(cookie.domain, apex ? 'snippet.com' : 'play.snippet.com'); assert.equal(cookie.hostOnly, !apex);
  window.manalens.destroy();
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
  const sdk = new Analytics({ publishableKey: 'mana_pk_example', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    await sdk.flush();
    await sdk.flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].events[0].message_id, sent[1].events[0].message_id);
    globalThis.location = new URL('https://example.com/docs?token=private');
    window.dispatchEvent(new Event('popstate'));
    globalThis.document.title = 'Docs'; // the router swaps the page after popstate
    await new Promise(resolve => setTimeout(resolve, 5));
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
  const sdk = new Analytics({ publishableKey: 'mana_pk_identify', endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000 });
  try {
    sdk.track('anonymous_step');
    await sdk.identify('user_123', { email: 'person@example.com', plan: 'pro', score: 7 });
    sdk.track('signed_in');
    await sdk.flush();
    assert.ok(sent.every(item => item.url === 'https://collector.example/v0/events'));
    const [before, identify, after] = eventsOf(sent);
    assert.equal(before.user_id, undefined);
    assert.equal(identify.type, 'identify');
    assert.equal(identify.event, undefined);
    assert.equal(identify.user_id, 'user_123');
    assert.deepEqual(identify.traits, { email: 'person@example.com', plan: 'pro', score: 7 });
    assert.equal(identify.anonymous_id, before.anonymous_id);
    assert.equal(after.user_id, 'user_123');
    assert.equal(after.traits, undefined);
    const userCookie = jar.find('mana_').find(c => c.name.endsWith('_user-id'));
    assert.equal(decodeURIComponent(userCookie.value), 'user_123');
    assert.equal(userCookie.expires, Infinity, 'user-id is a browser-session cookie, like Formo');

    // A reload in the same browser session restores user_id from the cookie.
    sdk.destroy();
    const reloaded = new Analytics({ publishableKey: 'mana_pk_identify', endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000 });
    assert.equal(reloaded.getUserId(), 'user_123');
    reloaded.reset();
    assert.equal(reloaded.getUserId(), undefined);
    assert.equal(jar.find('mana_').find(c => c.name.endsWith('_user-id')), undefined);
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
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', disabled: true });
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
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try { sdk.track('purchase', { revenue: 42 }); await sdk.flush(); await sdk.flush(); assert.deepEqual(sent[0].events, sent[1].events); }
  finally { sdk.destroy(); }
});

test('pagehide flushes queued events once with keepalive', async t => {
  const { window } = browser(); const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push({ body: JSON.parse(init.body), init }); return { ok: true }; });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000 });
  try {
    sdk.track('before_leave'); window.dispatchEvent(new Event('pagehide')); await sdk.flush();
    assert.equal(sent.length, 1); assert.equal(sent[0].init.keepalive, true);
    assert.deepEqual(sent[0].body.events.map(event => event.event), ['before_leave']);
  } finally { sdk.destroy(); }
});

test('destroy removes navigation and lifecycle listeners and discards pending events', async t => {
  const { window } = browser(); const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(init); return { ok: true }; });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  sdk.destroy(); globalThis.location = new URL('https://example.com/other'); window.dispatchEvent(new Event('popstate')); window.dispatchEvent(new Event('pagehide')); sdk.track('after_destroy'); await sdk.flush(); assert.equal(sent.length, 0);
});

test('a failed identify is retried with the same message and requests omit credentials', async t => {
  browser(); const sent = []; let fail = true;
  t.mock.method(globalThis, 'fetch', async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); if (fail) { fail = false; return { ok: false, status: 503 }; } return { ok: true }; });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example/', autoPageviews: false, flushIntervalMs: 60000 });
  try {
    await sdk.identify('user', { plan: 'pro' });
    await sdk.flush();
    assert.equal(sent.length, 2); assert.equal(sent[0].url, 'https://collector.example/v0/events'); assert.equal(sent[0].init.credentials, 'omit');
    assert.equal(sent[0].body.events[0].message_id, sent[1].body.events[0].message_id);
    assert.equal(sent[1].body.events[0].context.page.url, 'https://example.com/pricing');
  } finally { sdk.destroy(); }
});

for (const [key, network] of [['gclid','google'],['gbraid','google'],['wbraid','google'],['fbclid','meta'],['msclkid','microsoft'],['ttclid','tiktok'],['twclid','twitter'],['li_fat_id','linkedin'],['rdt_cid','reddit'],['ScCid','snapchat']]) test(`captures ${key} and carries it across route changes`, async t => {
  const {window}=browser(`https://example.com/?${key}=ad-token&utm_source=${network}&utm_campaign=launch`); const sent=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});
  const sdk=new Analytics({publishableKey:'mana_pk_key',endpoint:'https://collector.example',flushIntervalMs:60000});
  try { globalThis.location=new URL('https://example.com/checkout?email=private');window.dispatchEvent(new Event('manalens:navigate'));sdk.track('purchase',{revenue:120});await sdk.identify('customer');await sdk.flush();
    const events=sent.flatMap(x=>x.events||[]); assert.equal(events.length,4);
    for(const event of events){assert.equal(event.context[key],'ad-token');assert.equal(event.context.click_id,'ad-token');assert.equal(event.context.paid_source,network);assert.equal(event.context.utm_campaign,'launch');assert.ok(!JSON.stringify(event.context).includes('private'));}
    assert.equal(events.find(x=>x.type==='identify')?.context[key],'ad-token');
  } finally{sdk.destroy();}
});
test('preserves multiple network IDs and replaces an entire campaign on a new touch',async t=>{
  const {window}=browser('https://example.com/?gclid=g&fbclid=f&utm_source=google&utm_term=old&utm_id=c1&utm_source_platform=google');const sent=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});
  const sdk=new Analytics({publishableKey:'mana_pk_key',endpoint:'https://collector.example',flushIntervalMs:60000});
  try{globalThis.location=new URL('https://example.com/new?utm_source=newsletter&utm_medium=email');window.dispatchEvent(new Event('manalens:navigate'));await sdk.flush();const [first,last]=sent[0].events;assert.equal(first.context.gclid,'g');assert.equal(first.context.fbclid,'f');assert.equal(first.context.click_id,'g');assert.equal(first.context.utm_id,'c1');assert.equal(last.context.utm_source,'newsletter');assert.equal(last.context.gclid,undefined);assert.equal(last.context.utm_term,undefined);assert.equal(last.context.paid_source,undefined);}finally{sdk.destroy();}
});
test('gad_source marks Google traffic but is never a click token; paid UTMs and referral aliases work',async t=>{
  browser('https://example.com/?gad_source=1&referral_code=partner&utm_creative_format=video&utm_marketing_tactic=retargeting');const sent=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});let sdk=new Analytics({publishableKey:'mana_pk_key',endpoint:'https://collector.example',flushIntervalMs:60000});
  try{await sdk.flush();const c=sent[0].events[0].context;assert.equal(c.paid_source,'google');assert.equal(c.click_id,undefined);assert.equal(c.gad_source,'1');assert.equal(c.ref,'partner');assert.equal(c.utm_creative_format,'video');}finally{sdk.destroy();}
  browser('https://example.com/?utm_medium=paid_social');sdk=new Analytics({publishableKey:'mana_pk_key',endpoint:'https://collector.example',flushIntervalMs:60000});try{await sdk.flush();assert.equal(sent[1].events[0].context.paid_source,'paid_utm');}finally{sdk.destroy();}
});
test('campaign values reject unsafe and oversized input and arbitrary queries',async t=>{
  browser('https://example.com/?gclid=%3Cscript%3E&utm_term='+ 'x'.repeat(256)+'&email=private&token=secret');const sent=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});const sdk=new Analytics({publishableKey:'mana_pk_key',endpoint:'https://collector.example',flushIntervalMs:60000});try{await sdk.flush();const c=sent[0].events[0].context;assert.equal(c.gclid,undefined);assert.equal(c.utm_term,undefined);assert.ok(!JSON.stringify(c).includes('secret'));assert.ok(!JSON.stringify(c).includes('private'));}finally{sdk.destroy();}
});
test('UTC midnight drops carried campaign context',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2025-06-20T23:59:59Z').getTime()});const {window}=browser('https://example.com/?gclid=g&utm_source=google');const sent=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});const sdk=new Analytics({publishableKey:'mana_pk_key',endpoint:'https://collector.example',flushIntervalMs:60000});try{t.mock.timers.tick(2000);globalThis.location=new URL('https://example.com/next');window.dispatchEvent(new Event('manalens:navigate'));await sdk.flush();assert.equal(sent[0].events[0].context.gclid,'g');assert.equal(sent[0].events[1].context.gclid,undefined);}finally{sdk.destroy();}
});


const make = (options = {}) => new Analytics({ endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000, publishableKey: 'mana_pk_identity', ...options });
async function firstEvent(sdk, sent) { sdk.track('probe'); await sdk.flush(); return eventsOf(sent).at(-1); }

test('anonymous ID is created on first load, stored in a one-year cookie, survives reloads and is publishable-key scoped', async t => {
  const jar = cookieJar(); const local = memoryStorage(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://example.com/', { jar, local });
  let sdk = make();
  const cookie = jar.find('mana_').find(c => c.name.endsWith('_anonymous-id'));
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
  sdk = make({ publishableKey: 'mana_pk_other_site' }); assert.notEqual((await firstEvent(sdk, sent)).anonymous_id, first); sdk.destroy();
});

test('by default one anonymous ID is shared between example.com and play.example.com', async t => {
  const jar = cookieJar(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://play.shared.com/', { jar });
  let sdk = make({ publishableKey: 'mana_pk_cross' });
  const play = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  const cookie = jar.find('mana_').find(c => c.name.endsWith('_anonymous-id'));
  assert.equal(cookie.domain, 'shared.com'); assert.equal(cookie.hostOnly, false);
  browser('https://shared.com/', { jar });
  sdk = make({ publishableKey: 'mana_pk_cross' });
  assert.equal((await firstEvent(sdk, sent)).anonymous_id, play); sdk.destroy();
});

test('crossSubdomainCookies: false keeps a separate anonymous ID per host', async t => {
  const jar = cookieJar(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://play.split.com/', { jar });
  let sdk = make({ publishableKey: 'mana_pk_split', crossSubdomainCookies: false }); const play = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  browser('https://split.com/', { jar });
  sdk = make({ publishableKey: 'mana_pk_split', crossSubdomainCookies: false }); assert.notEqual((await firstEvent(sdk, sent)).anonymous_id, play); sdk.destroy();
});

test('an existing host-only cookie migrates to the apex domain under the default setting', async t => {
  const jar = cookieJar(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://app.migrate.com/', { jar });
  let sdk = make({ publishableKey: 'mana_pk_migrate', crossSubdomainCookies: false }); const legacy = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  sdk = make({ publishableKey: 'mana_pk_migrate' }); assert.equal((await firstEvent(sdk, sent)).anonymous_id, legacy); sdk.destroy();
  const cookies = jar.find('mana_').filter(c => c.name.endsWith('_anonymous-id'));
  assert.equal(cookies.length, 1); assert.equal(cookies[0].domain, 'migrate.com');
});

test('blocked cookies fall back to localStorage, then to memory', async t => {
  const local = memoryStorage(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://nocookie.test/', { jar: cookieJar({ blocked: true }), local });
  let sdk = make({ publishableKey: 'mana_pk_fallback' }); const stored = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  assert.match(stored, uuid);
  assert.ok([...local.stored.values()].includes(stored));
  browser('https://nocookie.test/', { jar: cookieJar({ blocked: true }), local });
  sdk = make({ publishableKey: 'mana_pk_fallback' }); assert.equal((await firstEvent(sdk, sent)).anonymous_id, stored); sdk.destroy();

  browser('https://nothing.test/', { jar: cookieJar({ blocked: true }), localBlocked: true });
  sdk = make({ publishableKey: 'mana_pk_memory_only' });
  const a = await firstEvent(sdk, sent); const b = await firstEvent(sdk, sent);
  assert.match(a.anonymous_id, uuid); assert.equal(a.anonymous_id, b.anonymous_id, 'memory keeps the ID for the page lifetime');
  sdk.destroy();
});

test('a localStorage ID is adopted into the cookie and the fallback copy is removed', async t => {
  const local = memoryStorage(); const sent = [];
  t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://adopt.test/', { jar: cookieJar({ blocked: true }), local });
  let sdk = make({ publishableKey: 'mana_pk_adopt' }); const id = (await firstEvent(sdk, sent)).anonymous_id; sdk.destroy();
  const { jar } = browser('https://adopt.test/', { local });
  sdk = make({ publishableKey: 'mana_pk_adopt' }); assert.equal((await firstEvent(sdk, sent)).anonymous_id, id); sdk.destroy();
  assert.equal(decodeURIComponent(jar.find('mana_').find(c => c.name.endsWith('_anonymous-id')).value), id);
  assert.ok(![...local.stored.values()].includes(id));
});

test('session_id is stable during activity and rotates after 30 minutes of inactivity', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://example.com/');
  const sdk = make({ publishableKey: 'mana_pk_session' });
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
  let sdk = make({ publishableKey: 'mana_pk_optout' });
  sdk.track('queued'); await sdk.identify('user_1');
  const before = eventsOf(sent).at(-1).anonymous_id; const count = sent.length;
  sdk.track('queued_then_dropped'); sdk.optOut();
  assert.equal(sdk.isOptedOut(), true); assert.equal(sdk.getUserId(), undefined); assert.equal(sdk.getAnonymousId(), undefined);
  sdk.track('ignored'); await sdk.identify('user_2'); await sdk.flush();
  assert.equal(sent.length, count);
  assert.deepEqual(jar.find('mana_').filter(c => !c.name.endsWith('_opt-out')), []);
  sdk.destroy();
  sdk = make({ publishableKey: 'mana_pk_optout' }); assert.equal(sdk.isOptedOut(), true); sdk.track('still_ignored'); await sdk.flush(); assert.equal(sent.length, count);
  sdk.optIn(); const after = await firstEvent(sdk, sent);
  assert.match(after.anonymous_id, uuid); assert.notEqual(after.anonymous_id, before); assert.equal(after.user_id, undefined);
  sdk.destroy();
});

test('requireConsent: no storage and no identity fields until setConsent(true)', async t => {
  const { jar, local } = browser('https://consent.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = make({ publishableKey: 'mana_pk_consent', requireConsent: true });
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
    assert.ok(jar.find('mana_').some(c => c.name.endsWith('_anonymous-id')));
  } finally { sdk.destroy(); }
});

test('setConsent(false) clears identity storage and strips identity from queued events', async t => {
  const { jar, local } = browser('https://withdraw.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = make({ publishableKey: 'mana_pk_withdraw', requireConsent: true });
  try {
    sdk.setConsent(true);
    await sdk.identify('user_w', { plan: 'pro' });
    sdk.track('queued');
    sdk.setConsent(false);
    assert.deepEqual(jar.find('mana_'), []); assert.equal(local.stored.size, 0); assert.equal(sdk.getUserId(), undefined);
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
  document.currentScript = { dataset: { publishableKey: 'mana_pk_snippet_consent', endpoint: 'https://collector.example', requireConsent: 'true' } };
  const sent = [];
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, setInterval: () => 1, clearInterval: () => {}, fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  await window.manalens.flush();
  assert.equal(jar.writes.length, 0); assert.equal(sent[0].events[0].anonymous_id, undefined);
  window.manalens.destroy();
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
  const sdk = make({ publishableKey: 'mana_pk_race', requireConsent: true });
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
  const sdk = make({ publishableKey: 'mana_pk_race_optout' });
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
  let sdk = own({ publishableKey: 'mana_pk_delete' }); await sdk.identify('user_d'); sdk.destroy();
  local.setItem([...jar.store.values()].find(c => c.name.endsWith('_anonymous-id')).name, 'stale-copy');
  assert.ok(jar.find('mana_').length >= 3);

  sdk = own({ publishableKey: 'mana_pk_delete', requireConsent: true });
  sdk.reset();
  assert.deepEqual(jar.find('mana_'), [], 'apex and host cookies cleared without consent');
  assert.equal(local.stored.size, 0, 'localStorage cleared without consent');
  sdk.optOut(); sdk.destroy();
  assert.ok(jar.find('mana_').some(c => c.name.endsWith('_opt-out')));

  sdk = own({ publishableKey: 'mana_pk_delete', requireConsent: true });
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
  const sdk = make({ publishableKey: `mana_pk_generation_${name.length}` });
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

/** A fake History whose pushState / replaceState move globalThis.location. */
function fakeHistory() {
  const calls = [];
  const move = (url) => { if (url !== undefined && url !== null) globalThis.location = new URL(String(url), globalThis.location.href); };
  return { calls, pushState(state, title, url) { calls.push(['push', String(url)]); move(url); }, replaceState(state, title, url) { calls.push(['replace', String(url)]); move(url); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('SPA navigation: pushState sends a pageview with the new title; query-only and same-URL replaceState send none', async t => {
  const { document } = browser('https://example.com/');
  const history = fakeHistory(); globalThis.history = history;
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    history.replaceState(null, '', 'https://example.com/'); // hydration: same URL
    history.pushState(null, '', '/docs?token=private');
    document.title = 'Docs'; // routers set the title after pushState
    await tick();
    history.replaceState(null, '', '/docs?tab=api'); // query-only change
    await tick();
    history.pushState(null, '', '/pricing'); document.title = 'Pricing';
    await tick();
    await sdk.flush();
    const pages = eventsOf(sent).filter(event => event.type === 'page');
    assert.deepEqual(pages.map(event => [event.context.page.path, event.context.page.title]), [['/', 'Pricing'], ['/docs', 'Docs'], ['/pricing', 'Pricing']]);
    assert.equal(pages[1].context.page.url, 'https://example.com/docs');
    // The wrapper keeps the original behavior (the URL moved).
    assert.equal(globalThis.location.pathname, '/pricing');
  } finally { sdk.destroy(); delete globalThis.history; }
});

test('SPA navigation: the history wrapper is installed once for several instances, and destroy() stops pageviews', async t => {
  browser('https://example.com/');
  const history = fakeHistory(); const originalPush = history.pushState; globalThis.history = history;
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const first = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  const wrapped = history.pushState;
  assert.notEqual(wrapped, originalPush);
  const second = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    assert.equal(history.pushState, wrapped, 'a second instance does not wrap again');
    first.destroy(); // React Strict Mode: the first instance is torn down
    history.pushState(null, '', '/next');
    history.pushState(null, '', '/next'); // a repeated push to the same path
    await tick();
    await second.flush();
    const pages = eventsOf(sent).filter(event => event.type === 'page').map(event => event.context.page.path);
    assert.deepEqual(pages, ['/', '/next'], 'one pageview per path change, from the live instance only');
    second.destroy();
    history.pushState(null, '', '/after-destroy'); await tick();
    assert.equal(eventsOf(sent).some(event => event.context?.page?.path === '/after-destroy'), false);
  } finally { first.destroy(); second.destroy(); delete globalThis.history; }
});

test('autoPageviews: false does not wrap history', async t => {
  browser('https://example.com/');
  const history = fakeHistory(); const original = history.pushState; globalThis.history = history;
  t.mock.method(globalThis, 'fetch', collector([]));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', autoPageviews: false });
  try { assert.equal(history.pushState, original); } finally { sdk.destroy(); delete globalThis.history; }
});

test('a session is at most 24 hours old: continuous activity starts a new session at 24 hours', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://example.com/');
  const sdk = make({ publishableKey: 'mana_pk_session_age' });
  try {
    const first = await firstEvent(sdk, sent);
    // An event every 20 minutes: 23 hours and 40 minutes in one session.
    let last = first;
    for (let minutes = 20; minutes < 24 * 60; minutes += 20) { t.mock.timers.tick(20 * 60000); last = await firstEvent(sdk, sent); }
    assert.equal(last.session_id, first.session_id);
    t.mock.timers.tick(20 * 60000);
    const next = await firstEvent(sdk, sent);
    assert.notEqual(next.session_id, first.session_id, 'a new session when the session is 24 hours old');
    assert.match(next.session_id, uuid);
    assert.equal(next.anonymous_id, first.anonymous_id);
    for (const event of eventsOf(sent)) assert.notEqual(event.session_id, event.anonymous_id, 'the session ID is never the anonymous ID');
  } finally { sdk.destroy(); }
});

test('a session stored by a pre-release SDK build (no start time) is not continued: the first event starts a new session', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const { jar } = browser('https://example.com/');
  let sdk = make({ publishableKey: 'mana_pk_session_old' });
  try {
    const before = await firstEvent(sdk, sent);
    const cookie = jar.find('mana_').find(c => c.name.endsWith('_session-id'));
    assert.match(cookie.value, /^[a-f0-9-]{36}\.\d+\.\d+$/, 'stored as <uuid>.<last activity>.<start>');
    sdk.destroy();
    // The old format, one minute old: valid for the pre-release format, and without a start time.
    const old = '11111111-1111-4111-8111-111111111111';
    document.cookie = `${cookie.name}=${old}.${Date.now() - 60000}; max-age=1800; path=/`;
    for (const broken of [`${old}.${Date.now() - 60000}`, `${old}.${Date.now()}.`, `${old}.${Date.now()}.abc`, `${old}.x.${Date.now()}`]) {
      document.cookie = `${cookie.name}=${broken}; max-age=1800; path=/`;
      sdk = make({ publishableKey: 'mana_pk_session_old' });
      const event = await firstEvent(sdk, sent);
      assert.match(event.session_id, uuid, broken);
      assert.notEqual(event.session_id, old, `${broken} was continued`);
      assert.equal(event.anonymous_id, before.anonymous_id);
      sdk.destroy();
    }
    sdk = make({ publishableKey: 'mana_pk_session_old' });
  } finally { sdk.destroy(); }
});

test('getSessionId: the session ID of the next event; reading it is not activity; undefined before consent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  browser('https://example.com/');
  const sdk = make({ publishableKey: 'mana_pk_session_getter' });
  try {
    const before = sdk.getSessionId();
    assert.match(before, uuid, 'a session starts when there is none');
    const first = await firstEvent(sdk, sent);
    assert.equal(first.session_id, before);
    assert.notEqual(before, sdk.getAnonymousId());
    // 20 minutes later a read does not keep the session alive: 31 minutes after the event it has ended.
    t.mock.timers.tick(20 * 60000); assert.equal(sdk.getSessionId(), before);
    t.mock.timers.tick(11 * 60000);
    const after = sdk.getSessionId();
    assert.notEqual(after, before, 'a read is not activity');
    assert.equal((await firstEvent(sdk, sent)).session_id, after);
  } finally { sdk.destroy(); }
  browser('https://consent-getter.com/');
  const consent = make({ publishableKey: 'mana_pk_session_getter_consent', requireConsent: true });
  try {
    assert.equal(consent.getSessionId(), undefined, 'no session ID before consent');
    consent.setConsent(true);
    assert.match(consent.getSessionId(), uuid);
    consent.optOut();
    assert.equal(consent.getSessionId(), undefined, 'no session ID after optOut()');
  } finally { consent.destroy(); }
});

test('a refusal with a reason: the error log and the errorHandler name the reason codes, and the batch is not sent again', async t => {
  browser('https://example.com/');
  const body = { error: { code: 'INVALID_EVENT', message: '1 of 2 events break the session ID contract. No event of the batch was accepted', refused: [{ index: 1, message_id: 'x', code: 'SESSION_ID_REQUIRED', message: 'An event with an anonymous_id needs a session_id' }] } };
  const sent = []; const errors = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return sent.length === 1 ? { ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify(body) } : { ok: true, status: 202 };
  });
  const logged = []; t.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, logger: { enabled: true, levels: ['error'] }, errorHandler: error => errors.push(error) });
  try {
    sdk.track('one'); sdk.track('two'); await sdk.flush(); await sdk.flush();
    assert.equal(sent.length, 1, 'the refused batch is not sent again');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 400); assert.equal(errors[0].dropped, 2);
    assert.deepEqual(errors[0].reasons, ['INVALID_EVENT', 'SESSION_ID_REQUIRED']);
    assert.match(errors[0].message, /The collector refused 2 event\(s\): HTTP 400 INVALID_EVENT, SESSION_ID_REQUIRED: 1 of 2 events break the session ID contract.*The events are dropped/);
    assert.ok(logged.some(line => line.includes('SESSION_ID_REQUIRED')), logged.join('\n'));
    sdk.track('next'); await sdk.flush();
    assert.deepEqual(sent[1].events.map(event => event.event), ['next']);
  } finally { sdk.destroy(); }
});

const response = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null } });

test('retry: a refused batch (400, 401, 403) is dropped, not sent again', async t => {
  for (const status of [400, 401, 403, 413]) {
    browser('https://example.com/');
    const sent = []; t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return response(sent.length === 1 ? status : 202); });
    const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false });
    try {
      sdk.track('refused'); await sdk.flush(); await sdk.flush();
      assert.equal(sent.length, 1, `status ${status}`);
      sdk.track('next'); await sdk.flush();
      assert.deepEqual(sent[1].events.map(event => event.event), ['next'], `status ${status}`);
    } finally { sdk.destroy(); }
  }
});

test('retry: 408, 429 and 5xx are sent again at most retryCount times', async t => {
  for (const status of [408, 429, 500, 503]) {
    browser('https://example.com/');
    const sent = []; t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return response(status); });
    const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, retryCount: 2 });
    try {
      sdk.track('flaky');
      for (let i = 0; i < 5; i++) await sdk.flush();
      assert.equal(sent.length, 3, `status ${status}: the first send and 2 retries`);
      assert.equal(new Set(sent.map(body => body.events[0].message_id)).size, 1);
    } finally { sdk.destroy(); }
  }
});

test('retry: network errors (offline) are not counted; the events wait until the network is back', async t => {
  browser('https://example.com/');
  let offline = 6; const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); if (offline-- > 0) throw new TypeError('Failed to fetch'); return response(202); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, retryCount: 1 });
  try {
    sdk.track('offline_event');
    for (let i = 0; i < 8; i++) await sdk.flush();
    assert.equal(sent.length, 7);
    assert.deepEqual(sent.at(-1).events.map(event => event.event), ['offline_event']);
  } finally { sdk.destroy(); }
});

test('backoff: after a failure, a full batch waits; flush() sends now; a success resets the backoff', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T00:00:00Z') });
  browser('https://example.com/');
  let fail = true; const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return response(fail ? 503 : 202); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, batchSize: 1 });
  try {
    sdk.track('a'); await tick(); // full batch: sent, 503
    assert.equal(sent.length, 1);
    sdk.track('b'); await tick(); // full batch during backoff: waits
    assert.equal(sent.length, 1);
    t.mock.timers.tick(1300); // past the first backoff (1 s + up to 25%)
    fail = false;
    sdk.track('c'); await tick();
    assert.equal(sent.length, 2);
    await sdk.flush(); await sdk.flush(); // explicit flush ignores backoff
    assert.deepEqual(sent.flatMap(body => body.events.map(event => event.event)).sort(), ['a', 'a', 'b', 'c'].sort());
  } finally { sdk.destroy(); }
});

test('backoff: Retry-After on 429 is honoured, up to 60 s', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T00:00:00Z') });
  browser('https://example.com/');
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return sent.length === 1 ? response(429, { 'retry-after': '45' }) : response(202); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, batchSize: 1 });
  try {
    sdk.track('a'); await tick();
    t.mock.timers.tick(40_000);
    sdk.track('b'); await tick();
    assert.equal(sent.length, 1, 'still inside Retry-After');
    t.mock.timers.tick(6_000);
    sdk.track('c'); await tick();
    assert.equal(sent.length, 2);
  } finally { sdk.destroy(); }
});

test('maxQueueSize: the queue stays under the byte limit and drops the oldest events first', async t => {
  browser('https://example.com/');
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, batchSize: 1000, maxQueueSize: 4000 });
  const sent = [];
  try {
    for (let i = 0; i < 20; i++) sdk.track(`event_${i}`, { note: 'x'.repeat(300) });
    t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return response(202); });
    await sdk.flush();
    const names = sent[0].events.map(event => event.event);
    assert.ok(names.length < 20 && names.length > 1, `kept ${names.length}`);
    assert.equal(names.at(-1), 'event_19', 'the newest event is kept');
    assert.equal(names[0], `event_${20 - names.length}`, 'the oldest events were dropped');
    assert.ok(new TextEncoder().encode(JSON.stringify(sent[0].events)).byteLength <= 4000 + names.length);
  } finally { sdk.destroy(); }
});

test('tracking.excludeHosts: exact and *. hosts send nothing and write no identity', async t => {
  for (const [url, hosts] of [['https://staging.example.com/', ['STAGING.example.com']], ['https://app-git-x.vercel.app/', ['*.vercel.app']]]) {
    const { jar } = browser(url);
    const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
    const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking: { excludeHosts: hosts } });
    try {
      sdk.track('signup'); await sdk.identify('user-1'); await sdk.flush();
      assert.equal(sent.length, 0, url);
      assert.equal(jar.writes.length, 0, `${url}: no cookie written`);
      assert.equal(sdk.getAnonymousId(), undefined);
    } finally { sdk.destroy(); }
  }
  // The wildcard does not match the bare domain or a look-alike.
  for (const url of ['https://vercel.app/', 'https://evilvercel.app/']) {
    browser(url); const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
    const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking: { excludeHosts: ['*.vercel.app'] } });
    try { await sdk.flush(); assert.equal(eventsOf(sent).length, 1, url); } finally { sdk.destroy(); }
  }
});

test('tracking.excludePaths: exact and /* prefix paths, checked per event as a SPA navigates', async t => {
  const { window } = browser('https://example.com/admin/users');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking: { excludePaths: ['/admin/*', '/checkout/'] } });
  try {
    sdk.track('admin_click');
    globalThis.location = new URL('https://example.com/pricing'); window.dispatchEvent(new Event('manalens:navigate'));
    sdk.track('pricing_click');
    globalThis.location = new URL('https://example.com/checkout'); window.dispatchEvent(new Event('manalens:navigate'));
    sdk.track('checkout_click');
    globalThis.location = new URL('https://example.com/administrator'); window.dispatchEvent(new Event('manalens:navigate'));
    await sdk.flush();
    const events = eventsOf(sent).map(event => event.type === 'page' ? `page ${event.context.page.path}` : event.event);
    assert.deepEqual(events, ['page /pricing', 'pricing_click', 'page /administrator']);
    assert.match(eventsOf(sent)[0].anonymous_id, uuid, 'identity starts on the first allowed page');
  } finally { sdk.destroy(); }
});

test('tracking.excludeTimezones: no events, no storage, and an existing identity is deleted', async t => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { jar } = browser('https://example.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const first = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  first.destroy();
  assert.ok(jar.find('mana_').some(cookie => cookie.name.endsWith('_anonymous-id')), 'identity from an earlier visit');
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking: { excludeTimezones: ['Mars/Olympus', zone.toUpperCase()] } });
  try {
    sdk.track('x'); await sdk.identify('u'); sdk.optIn(); await sdk.flush();
    assert.equal(sent.length, 0);
    assert.equal(jar.find('mana_').some(cookie => cookie.name.endsWith('_anonymous-id')), false, 'existing identity deleted');
    assert.equal(sdk.getAnonymousId(), undefined);
  } finally { sdk.destroy(); }
  // Another timezone in the list does not exclude this visitor.
  const other = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking: { excludeTimezones: ['Mars/Olympus'] } });
  try { await other.flush(); assert.equal(eventsOf(sent).length, 1); } finally { other.destroy(); }
});

test('tracking rules: trailing dots, IDN hosts, double slashes, escapes and timezone aliases still match', async t => {
  const cases = [
    ['https://staging.example.com./', { excludeHosts: ['staging.example.com'] }],
    ['https://xn--bcher-kva.example/', { excludeHosts: ['bücher.example'] }],
    ['https://preview.münchen.example/', { excludeHosts: ['*.münchen.example.'] }],
    ['https://example.com//admin//users', { excludePaths: ['/admin/*'] }],
    ['https://example.com/%61dmin', { excludePaths: ['/admin'] }],
  ];
  for (const [url, tracking] of cases) {
    browser(url); const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
    const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking });
    try { sdk.track('x'); await sdk.flush(); assert.equal(sent.length, 0, url); } finally { sdk.destroy(); }
  }
  // A visitor in Asia/Calcutta is excluded by Asia/Kolkata, and the reverse.
  const original = Intl.DateTimeFormat;
  for (const [visitor, rule] of [['Asia/Calcutta', 'Asia/Kolkata'], ['Asia/Kolkata', 'Asia/Calcutta'], ['Europe/Kiev', 'Europe/Kyiv'], ['Etc/UTC', 'UTC']]) {
    t.mock.method(Intl, 'DateTimeFormat', function (...args) { const real = new original(...args); return args.length ? real : { resolvedOptions: () => ({ ...real.resolvedOptions(), timeZone: visitor }) }; });
    browser('https://example.com/'); const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
    const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking: { excludeTimezones: [rule] } });
    try { await sdk.flush(); assert.equal(sent.length, 0, `${visitor} vs ${rule}`); } finally { sdk.destroy(); Intl.DateTimeFormat.mock?.restore?.(); t.mock.restoreAll(); }
  }
});

test('tracking rules: an excluded landing page carries no campaign, and a held identify is sent on the next allowed page', async t => {
  const { window } = browser('https://example.com/admin?utm_source=internal');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking: { excludePaths: ['/admin/*'] } });
  try {
    await sdk.identify('user-9', { plan: 'pro' });
    globalThis.location = new URL('https://example.com/pricing'); window.dispatchEvent(new Event('manalens:navigate'));
    await sdk.flush();
    const events = eventsOf(sent);
    assert.deepEqual(events.map(event => event.type), ['identify', 'page']);
    assert.equal(events[0].user_id, 'user-9'); assert.deepEqual(events[0].traits, { plan: 'pro' });
    assert.equal(events[1].context.utm_source, undefined, 'no campaign from the excluded page');
  } finally { sdk.destroy(); }
});

test('consent on an excluded page holds the identify until an allowed page', async t => {
  const { window, jar } = browser('https://example.com/admin');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, requireConsent: true, tracking: { excludePaths: ['/admin'] } });
  try {
    await sdk.identify('user-7', { plan: 'team' });
    sdk.setConsent(true);
    assert.equal(jar.find('mana_').some(cookie => cookie.name.endsWith('_user-id')), false, 'no user cookie on the excluded page');
    globalThis.location = new URL('https://example.com/home'); window.dispatchEvent(new Event('manalens:navigate'));
    await sdk.flush();
    const events = eventsOf(sent);
    assert.equal(events[0].type, 'identify'); assert.equal(events[0].user_id, 'user-7');
  } finally { sdk.destroy(); }
});

test('identify() while opted out is a no-op, and optIn() starts without a user ID', async t => {
  browser('https://example.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false });
  try {
    await sdk.identify('before');
    sdk.optOut();
    await sdk.identify('during-opt-out');
    assert.equal(sdk.getUserId(), undefined);
    sdk.optIn();
    sdk.track('after_opt_in'); await sdk.flush();
    const after = eventsOf(sent).find(event => event.event === 'after_opt_in');
    assert.equal(after.user_id, undefined);
  } finally { sdk.destroy(); }
});

const gameId = '22222222-2222-4222-8222-222222222222';
test('game handoff: mana_hid leaves the address bar and one identity_handoff event joins the game ID', async t => {
  browser(`https://example.com/wiki?tab=boss&mana_hid=${gameId.toUpperCase()}.1794784346#drops`);
  const history = fakeHistory(); globalThis.history = history;
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_handoff', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    assert.equal(globalThis.location.href, 'https://example.com/wiki?tab=boss#drops');
    assert.deepEqual(history.calls, [['replace', 'https://example.com/wiki?tab=boss#drops']]);
    await sdk.flush();
    const events = eventsOf(sent);
    const handoff = events.filter(event => event.event === 'identity_handoff');
    assert.equal(handoff.length, 1);
    assert.deepEqual(handoff[0].properties, { source_anonymous_id: gameId, handoff_at: 1794784346 });
    assert.equal(handoff[0].anonymous_id, sdk.getAnonymousId());
    assert.ok(events.every(event => !JSON.stringify(event).includes('mana_pk_hid')), 'no event carries the parameter');
    // A reload (same page, no parameter) sends no second handoff.
    const again = new Analytics({ publishableKey: 'mana_pk_handoff', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
    await again.flush(); again.destroy();
    assert.equal(eventsOf(sent).filter(event => event.event === 'identity_handoff').length, 1);
  } finally { sdk.destroy(); delete globalThis.history; }
});

test('game handoff: waits for consent, and is dropped by setConsent(false), opt-out or a malformed value', async t => {
  browser(`https://consent.com/?mana_hid=${gameId}.1794784346`);
  globalThis.history = fakeHistory();
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  let sdk = make({ publishableKey: 'mana_pk_handoff_consent', requireConsent: true });
  try {
    await sdk.flush();
    assert.equal(globalThis.location.search, '', 'removed before consent too');
    assert.equal(eventsOf(sent).some(event => event.event === 'identity_handoff'), false);
    sdk.setConsent(true); await sdk.flush();
    const [handoff] = eventsOf(sent).filter(event => event.event === 'identity_handoff');
    assert.match(handoff.anonymous_id, uuid);
    assert.equal(handoff.properties.source_anonymous_id, gameId);
    sdk.destroy();

    sent.length = 0;
    browser(`https://withdraw.com/?mana_hid=${gameId}.1794784346`); globalThis.history = fakeHistory();
    sdk = make({ publishableKey: 'mana_pk_handoff_withdraw', requireConsent: true });
    sdk.setConsent(false); sdk.setConsent(true); await sdk.flush();
    assert.equal(eventsOf(sent).some(event => event.event === 'identity_handoff'), false, 'withdrawn consent drops the handoff');
    sdk.destroy();

    browser(`https://optout.com/?mana_hid=${gameId}.1794784346`); globalThis.history = fakeHistory();
    sdk = make({ publishableKey: 'mana_pk_handoff_optout', requireConsent: true });
    sdk.optOut(); sdk.optIn(); sdk.setConsent(true); await sdk.flush();
    assert.equal(eventsOf(sent).some(event => event.event === 'identity_handoff'), false, 'opt-out drops the handoff');
    sdk.destroy();

    for (const value of ['not-an-id', `${gameId}`, `${gameId}.abc`]) {
      browser(`https://bad.com/?mana_hid=${encodeURIComponent(value)}&q=1`); globalThis.history = fakeHistory();
      sdk = make({ publishableKey: 'mana_pk_handoff_bad' });
      await sdk.flush();
      assert.equal(globalThis.location.search, '?q=1', value);
      assert.equal(eventsOf(sent).some(event => event.event === 'identity_handoff'), false, value);
      sdk.destroy();
    }
  } finally { sdk.destroy(); delete globalThis.history; }
});

test('game handoff: an own ID is ignored, and the URL is unchanged without the parameter', async t => {
  const jar = cookieJar();
  browser('https://self.com/', { jar });
  globalThis.history = fakeHistory();
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  let sdk = make({ publishableKey: 'mana_pk_handoff_self' });
  const own = sdk.getAnonymousId(); sdk.destroy();
  assert.deepEqual(globalThis.history.calls, [], 'no replaceState without the parameter');
  browser(`https://self.com/?mana_hid=${own}.1794784346`, { jar }); globalThis.history = fakeHistory();
  sdk = make({ publishableKey: 'mana_pk_handoff_self' });
  try {
    await sdk.flush();
    assert.equal(eventsOf(sent).some(event => event.event === 'identity_handoff'), false);
  } finally { sdk.destroy(); delete globalThis.history; }
});

// P-2516: optional app context for browser and Electron games.
const gameApp = { platform: 'web', storefront: 'itch', app_version: '1.4.0', build: '571', engine: 'other' };

test('app option: every event carries context.app next to context.page; the channel stays web', async t => {
  browser('https://game.example/play');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_game', endpoint: 'https://collector.example', flushIntervalMs: 60000, app: gameApp });
  try {
    sdk.track('game_open', { is_first_open: true });
    await sdk.identify('player-1', { plan: 'free' });
    await sdk.flush();
    const events = eventsOf(sent);
    assert.deepEqual(events.map(event => event.type).sort(), ['identify', 'page', 'track']);
    for (const event of events) {
      assert.equal(event.channel, 'web');
      assert.deepEqual(event.context.app, gameApp);
      assert.equal(event.context.page.path, '/play');
    }
  } finally { sdk.destroy(); }
});

test('app option: an invalid object is dropped with a warning and events are sent without context.app', async t => {
  const invalid = [
    'web', [], { storefront: 'steam' }, { platform: 'nintendo' }, { platform: 'web', storefront: 'humble' }, { platform: 'web', engine: 'phaser' },
    { platform: 'web', build: 'bad/build' }, { platform: 'web', build: '' }, { platform: 'web', build: 'x'.repeat(65) }, { platform: 'web', app_version: 'x'.repeat(33) },
    { platform: 'web', app_version: 1 }, { platform: 'web', extra: 1 },
  ];
  for (const app of invalid) {
    browser('https://game.example/');
    const sent = []; const fetchMock = t.mock.method(globalThis, 'fetch', collector(sent));
    const warn = t.mock.method(console, 'warn', () => {});
    const sdk = new Analytics({ publishableKey: 'mana_pk_game', endpoint: 'https://collector.example', flushIntervalMs: 60000, app });
    try {
      await sdk.flush();
      assert.equal(warn.mock.callCount(), 1, JSON.stringify(app));
      assert.match(warn.mock.calls[0].arguments[0], /app option is ignored/);
      assert.equal(eventsOf(sent)[0].context.app, undefined);
    } finally { sdk.destroy(); warn.mock.restore(); fetchMock.mock.restore(); }
  }
});

test('app option: the longest valid labels pass, and a copy is sent (later changes to the object are ignored)', async t => {
  browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const app = { platform: 'windows', app_version: `${'1'.repeat(31)}+`, build: 'Build 2026.11.16 rc-1_a'.padEnd(64, 'x') };
  const sdk = new Analytics({ publishableKey: 'mana_pk_game', endpoint: 'https://collector.example', flushIntervalMs: 60000, app });
  try {
    app.platform = 'nintendo';
    await sdk.flush();
    assert.equal(eventsOf(sent)[0].context.app.platform, 'windows');
    assert.equal(eventsOf(sent)[0].context.app.build.length, 64);
  } finally { sdk.destroy(); }
});

// G-2525: the app-channel delivery spec of the game SDKs (manalens sdks/SPEC.md).
// examples/fixtures/app-event.json is a copy of one event of the shared request
// fixtures (manalens sdks/unity/Tests~/fixtures/request-1.json). Update it by
// hand when those fixtures change.
const appFixture = JSON.parse(await readFile(new URL('./fixtures/app-event.json', import.meta.url), 'utf8'));

test('app option: the request has the shape of the game SDK request fixtures; the channel, the page, the library and the locale differ', async t => {
  browser('https://game.example/play');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_game', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, app: appFixture.context.app });
  try {
    sdk.track(appFixture.event, appFixture.properties);
    await sdk.flush();
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0].body), ['events'], 'the body is {"events":[...]}');
    const [event] = sent[0].body.events;
    assert.deepEqual(event.context.app, appFixture.context.app);
    assert.equal(event.type, appFixture.type);
    assert.equal(event.event, appFixture.event);
    assert.deepEqual(event.properties, appFixture.properties);
    assert.match(event.message_id, uuid);
    assert.match(event.anonymous_id, uuid);
    assert.ok(event.session_id, 'a session ID, as in app events');
    for (const key of Object.keys(appFixture)) assert.ok(key in event, `the web event has ${key}`);
    // Documented differences: the channel stays web and the context has the page.
    assert.equal(event.channel, 'web');
    assert.equal(event.context.page.path, '/play');
  } finally { sdk.destroy(); }
});

test('delivery defaults are the web column of the SDK spec: 30 per batch, 15 s, 3 retries, 500 KiB', async t => {
  browser('https://example.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', autoPageviews: false });
  try {
    const { batchSize, flushIntervalMs, retryCount, maxQueueSize } = sdk.options;
    assert.deepEqual({ batchSize, flushIntervalMs, retryCount, maxQueueSize }, { batchSize: 30, flushIntervalMs: 15000, retryCount: 3, maxQueueSize: 512000 });
    sdk.track('one');
    t.mock.timers.tick(14999);
    assert.equal(sent.length, 0, 'no send before 15 s');
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(eventsOf(sent).length, 1, 'the timer sends after 15 s');
    for (let i = 0; i < 31; i++) sdk.track(`event_${i}`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent[1].body.events.length, 30, 'a full batch of 30 sends at once');
  } finally { sdk.destroy(); }
});

test('snippet data-app-* attributes set the app context', async () => {
  const { window, document } = browser('https://game.example/');
  document.currentScript = { dataset: { publishableKey: 'mana_pk_snippet', endpoint: 'https://collector.example', appPlatform: 'web', appStorefront: 'itch', appVersion: '1.4.0', appBuild: '571', appEngine: 'other' } };
  const sent = [];
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, console, setInterval: () => 1, clearInterval: () => {}, fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  await window.manalens.flush();
  assert.deepEqual(sent[0].events[0].context.app, gameApp);
  assert.equal(sent[0].events[0].channel, 'web');
  window.manalens.destroy();
});

test('publishableKey takes the publishable key: only mana_pk_ keys pass; secret keys, API keys and other values are refused', () => {
  browser('https://example.com/');
  new Analytics({ publishableKey: 'mana_pk_abc', endpoint: 'https://collector.example', disabled: true }).destroy();
  for (const key of ['mana_sk_abc', 'mana_api_abc', 'pk_abc', 'abc']) {
    assert.throws(() => new Analytics({ publishableKey: key, endpoint: 'https://collector.example', disabled: true }), /publishable key \(mana_pk_/, key);
  }
  assert.throws(() => new Analytics({ endpoint: 'https://collector.example', disabled: true }), /publishableKey and endpoint are required/);
});

test('the publishable key is sent in x-publishable-key only, and the writeKey option is ignored', async t => {
  browser('https://example.com/');
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(init.headers); return { ok: true }; });
  const sdk = new Analytics({ publishableKey: 'mana_pk_header', writeKey: 'mana_pk_other', endpoint: 'https://collector.example', autoPageviews: false, flushIntervalMs: 60000 });
  sdk.track('header_check'); await sdk.flush(); sdk.destroy();
  assert.equal(sent[0]['x-publishable-key'], 'mana_pk_header');
  assert.equal(sent[0]['x-write-key'], undefined);
  assert.throws(() => new Analytics({ writeKey: 'mana_pk_alias', endpoint: 'https://collector.example', disabled: true }), /publishableKey and endpoint are required/);
});

test('snippet: data-publishable-key works; data-write-key is not read', async () => {
  for (const dataset of [{ publishableKey: 'mana_pk_snippet_new' }, { writeKey: 'mana_pk_snippet_old' }]) {
    const { window, document } = browser('https://example.com/');
    document.currentScript = { dataset: { ...dataset, endpoint: 'https://collector.example' } };
    const sent = [];
    const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
    vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, setInterval: () => 1, clearInterval: () => {}, fetch: async (_url, init) => { sent.push(init.headers); return { ok: true }; } });
    if (dataset.writeKey) { assert.equal(window.manalens, undefined); continue; }
    assert.ok(window.manalens, JSON.stringify(dataset));
    await window.manalens.flush();
    assert.equal(sent[0]['x-publishable-key'], dataset.publishableKey);
    window.manalens.destroy();
  }
});

/** Mock timers run one level of timers per tick(): step 10 ms at a time, so timers set by timers run too. */
const advance = (t, ms) => { for (let step = 0; step < ms; step += 10) t.mock.timers.tick(Math.min(10, ms - step)); if (ms === 0) t.mock.timers.tick(0); };
const pagesOf = sent => eventsOf(sent).filter(event => event.type === 'page').map(event => [event.context.page.path, event.context.page.title]);

test('back and forward: the page view waits for the framework to change the title, and is sent once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { window, document } = browser('https://example.com/a');
  document.title = 'A';
  const history = fakeHistory(); globalThis.history = history;
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    history.pushState(null, '', '/b'); document.title = 'B';
    advance(t, 0);
    // Back: the URL is /a at once, but the framework loads and swaps the page later.
    globalThis.location = new URL('https://example.com/a');
    window.dispatchEvent(new Event('popstate'));
    advance(t, 100);
    history.replaceState(null, '', '/a'); // a router saves the scroll position: no early page view
    advance(t, 100);
    await sdk.flush();
    assert.deepEqual(pagesOf(sent), [['/a', 'A'], ['/b', 'B']], 'nothing yet: the title is still the page you left');
    document.title = 'A'; // the swap, 200 ms after popstate
    advance(t, 50);
    sdk.page(); // for example page() on astro:page-load: same path and query, no second page view
    advance(t, 2000);
    await sdk.flush();
    assert.deepEqual(pagesOf(sent), [['/a', 'A'], ['/b', 'B'], ['/a', 'A']]);
  } finally { sdk.destroy(); delete globalThis.history; }
});

test('back and forward: without a title change the page view is sent after 1 s; a hash-only change sends nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { window } = browser('https://example.com/a');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    globalThis.location = new URL('https://example.com/b');
    window.dispatchEvent(new Event('popstate'));
    advance(t, 950);
    await sdk.flush();
    assert.deepEqual(pagesOf(sent).map(([path]) => path), ['/a']);
    advance(t, 100);
    await sdk.flush();
    assert.deepEqual(pagesOf(sent).map(([path]) => path), ['/a', '/b']);
    globalThis.location = new URL('https://example.com/b#section');
    window.dispatchEvent(new Event('popstate'));
    advance(t, 2000);
    await sdk.flush();
    assert.deepEqual(pagesOf(sent).map(([path]) => path), ['/a', '/b']);
  } finally { sdk.destroy(); }
});

test('back and forward: a page view that waits is sent with the pagehide flush, not lost', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { window } = browser('https://example.com/a');
  const sent = []; t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push({ body: JSON.parse(init.body), init }); return { ok: true }; });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    await sdk.flush();
    globalThis.location = new URL('https://example.com/b');
    window.dispatchEvent(new Event('popstate'));
    window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent[1].init.keepalive, true);
    assert.deepEqual(sent[1].body.events.map(event => event.context.page.path), ['/b']);
    advance(t, 2000);
    await sdk.flush();
    assert.equal(sent.length, 2, 'the timer sends no second page view');
  } finally { sdk.destroy(); }
});

test('first load: the page view is queued at once with the current title (no wait)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browser('https://example.com/pricing');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try { await sdk.flush(); assert.deepEqual(pagesOf(sent), [['/pricing', 'Pricing']]); } finally { sdk.destroy(); }
});

const runSnippet = async (dataset, extra = {}) => {
  const { window, document } = browser('https://example.com/');
  document.currentScript = { dataset: { publishableKey: 'mana_pk_snippet', endpoint: 'https://collector.example', ...dataset } };
  const sent = [];
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, CustomEvent, console, setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout, history: globalThis.history, fetch: async (_url, init) => { sent.push({ body: JSON.parse(init.body) }); return { ok: true }; }, ...extra });
  return { window, sent };
};

test('snippet data-auto-pageviews="false" sends no page view and does not wrap history; page() still works', async () => {
  const history = fakeHistory(); const original = history.pushState; globalThis.history = history;
  try {
    const { window, sent } = await runSnippet({ autoPageviews: 'false' });
    assert.equal(history.pushState, original);
    window.manalens.track('clicked'); await window.manalens.flush();
    assert.deepEqual(eventsOf(sent).map(event => event.type), ['track']);
    window.manalens.page(); await window.manalens.flush();
    assert.deepEqual(eventsOf(sent).map(event => event.type), ['track', 'page']);
    window.manalens.destroy();
    const auto = await runSnippet({ autoPageviews: 'true' });
    await auto.window.manalens.flush();
    assert.deepEqual(eventsOf(auto.sent).map(event => event.type), ['page']);
    auto.window.manalens.destroy();
  } finally { delete globalThis.history; }
});

test('snippet: manalens:ready fires on window with the instance; data-debug="true" logs', async t => {
  const lines = [];
  const fakeConsole = { debug: m => lines.push(m), info: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) };
  t.mock.method(console, 'info', m => lines.push(m)); t.mock.method(console, 'debug', m => lines.push(m));
  let detail;
  const { window, document } = browser('https://example.com/');
  window.addEventListener('manalens:ready', event => { detail = event.detail; });
  document.currentScript = { dataset: { publishableKey: 'mana_pk_snippet', endpoint: 'https://collector.example', debug: 'true' } };
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, CustomEvent, console: fakeConsole, setInterval: () => 1, clearInterval: () => {}, fetch: async () => ({ ok: true }) });
  assert.equal(detail, window.manalens);
  assert.ok(lines.some(line => line.includes('Initialized')), lines.join('\n'));
  assert.ok(lines.some(line => line.includes('Queued page')));
  window.manalens.destroy();
});

test('tracking: false is the same as disabled: true; tracking: true tracks', async t => {
  const { jar } = browser('https://example.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const off = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', tracking: false });
  off.track('x'); await off.flush(); off.destroy();
  assert.equal(sent.length, 0); assert.equal(jar.writes.length, 0);
  const on = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', tracking: true, flushIntervalMs: 60000 });
  try { await on.flush(); assert.deepEqual(eventsOf(sent).map(event => event.type), ['page']); } finally { on.destroy(); }
});

test('localhost is tracked by default', async t => {
  browser('http://localhost:4321/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try { await sdk.flush(); assert.equal(eventsOf(sent).length, 1); } finally { sdk.destroy(); }
});

test('tracking.excludeQueryParams: named campaign parameters are never read (case-insensitive)', async t => {
  browser('https://example.com/?ref=friend42&utm_source=news&gclid=g1&referral=r2');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking: { excludeQueryParams: ['REF', 'gclid', 'referral'] } });
  try {
    sdk.track('x'); await sdk.flush();
    for (const event of eventsOf(sent)) {
      assert.equal(event.context.utm_source, 'news');
      for (const key of ['ref', 'gclid', 'click_id', 'paid_source']) assert.equal(event.context[key], undefined, key);
      assert.equal(JSON.stringify(event).includes('friend42'), false);
      assert.equal(JSON.stringify(event).includes('r2'), false);
    }
  } finally { sdk.destroy(); }
});

test('logger: off by default; levels match exactly; no property values or user IDs in logs', async t => {
  browser('https://example.com/');
  const lines = [];
  for (const method of ['debug', 'info', 'warn', 'error']) t.mock.method(console, method, message => lines.push([method, message]));
  t.mock.method(globalThis, 'fetch', async () => response(500));
  const quiet = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  quiet.track('a'); await quiet.flush(); quiet.destroy();
  assert.deepEqual(lines, []);
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, logger: { enabled: true, levels: ['warn'] } });
  try {
    sdk.track('secret_event', { email: 'person@example.com' }); await sdk.identify('user_private', { plan: 'pro' });
    assert.ok(lines.length > 0);
    assert.ok(lines.every(([method]) => method === 'warn'));
    assert.equal(JSON.stringify(lines).includes('person@example.com'), false);
    assert.equal(JSON.stringify(lines).includes('user_private'), false);
  } finally { sdk.destroy(); }
});

test('ready: called once with the instance, also when disabled; an error in it is caught', t => {
  browser('https://example.com/');
  t.mock.method(globalThis, 'fetch', collector([]));
  t.mock.method(console, 'error', () => {});
  const calls = [];
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', ready: instance => calls.push(instance) });
  assert.deepEqual(calls, [sdk]); sdk.destroy();
  const off = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', disabled: true, ready: instance => calls.push(instance) });
  assert.equal(calls[1], off);
  assert.doesNotThrow(() => new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', disabled: true, ready: () => { throw new Error('bad'); } }));
  assert.equal(console.error.mock.callCount(), 1);
});

test('errorHandler: called when events are refused or dropped after retries, not for network errors', async t => {
  browser('https://example.com/');
  const errors = [];
  let mode = 'offline';
  t.mock.method(globalThis, 'fetch', async () => { if (mode === 'offline') throw new Error('offline'); return response(mode); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, retryCount: 1, errorHandler: error => errors.push(error) });
  try {
    sdk.track('a'); await sdk.flush();
    assert.equal(errors.length, 0, 'offline: the events wait');
    mode = 503; await sdk.flush(); assert.equal(errors.length, 0, 'first server error: retried');
    await sdk.flush();
    assert.equal(errors.length, 1); assert.equal(errors[0].name, 'SendError'); assert.equal(errors[0].status, 503); assert.equal(errors[0].dropped, 1);
    mode = 400; sdk.track('b'); await sdk.flush();
    assert.equal(errors.length, 2); assert.equal(errors[1].status, 400);
  } finally { sdk.destroy(); }
});
