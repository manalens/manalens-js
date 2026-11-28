import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { Analytics, errorFingerprint } from '../dist/index.js';

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
    // The email and the campaign parameter are not in the URL; the plain fragment passes the value check.
    assert.equal(events[0].context.page.url, 'https://example.com/pricing#secret');
    assert.equal(events[0].context.page.hash, '#secret');
    assert.ok(!JSON.stringify(events).includes('private'));
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

test('snippet works on an http:// page, where crypto.randomUUID is missing (not a secure context)', async () => {
  const { window, document } = browser('http://example.com/');
  document.currentScript = { dataset: { publishableKey: 'mana_pk_example', endpoint: 'https://collector.example' } };
  const sent = [];
  const insecureCrypto = { getRandomValues: array => webcrypto.getRandomValues(array) };
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: insecureCrypto, URL, setInterval: () => 1, clearInterval: () => {}, fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  assert.ok(window.manalens);
  window.manalens.track('level_start');
  await window.manalens.flush();
  const events = sent.flatMap(body => body.events);
  assert.ok(events.length >= 2);
  for (const event of events) { assert.match(event.anonymous_id, uuid); assert.match(event.message_id, uuid); assert.match(event.session_id, uuid); }
  assert.equal(new Set(events.map(event => event.message_id)).size, events.length);
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

test('page URLs keep the query and the fragment without secrets, campaign parameters and excludeQueryParams', async t => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  browser(`https://example.com/buy/?mp=KELP422&from=title&token=abc&Session_ID=cs_live_x&x=${jwt}&u=76561198000000000&gclid=g1&lang=de#l=Dear%20Mira&owns=c2FpbG9yLTEyMzQ1Njc4.QmFzZTY0VXJsU2lnbmF0dXJlXzEyMzQ1Ng&tab=crew`);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example/', autoPageviews: false, flushIntervalMs: 60000, tracking: { excludeQueryParams: ['MP', 'l'] } });
  try {
    await sdk.page();
    await sdk.flush();
    const { page, gclid } = sent[0].events[0].context;
    assert.deepEqual(page, { path: '/buy', title: page.title, url: 'https://example.com/buy?from=title&lang=de#tab=crew', hash: '#tab=crew' });
    assert.equal(gclid, 'g1', 'a click ID stays a campaign field');
    const text = JSON.stringify(sent);
    for (const leaked of ['KELP422', 'Mira', 'token=', 'cs_live_x', jwt, '76561198000000000', 'owns=']) assert.ok(!text.includes(leaked), leaked);
  } finally { sdk.destroy(); }
});

test('page URLs: nested URLs and encoded pairs in a value are removed, `;` separates, fragment path IDs become :id', async t => {
  browser('https://example.com/play?next=https%3A%2F%2Fx%2F%3Ftoken%3Dabc&r=a%3Db%26code%3D123&from=title;token=abc;lang=de#/letters/abc123def456/read');
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example/', autoPageviews: false, flushIntervalMs: 60000 });
  try {
    await sdk.page();
    await sdk.flush();
    const { page } = sent[0].events[0].context;
    assert.equal(page.url, 'https://example.com/play?from=title&lang=de#/letters/:id/read');
    assert.equal(page.hash, '#/letters/:id/read');
    for (const leaked of ['abc123def456', 'code', 'token', 'x%2F']) assert.ok(!JSON.stringify(sent).includes(leaked), leaked);
  } finally { sdk.destroy(); }
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
    assert.equal(sent[1].body.events[0].context.page.url, 'https://example.com/pricing#secret');
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

test('refused events of an accepted batch go to the error log and the errorHandler, and are not sent again (P-2787)', async t => {
  browser('https://example.com/');
  const body = { accepted: 1, rejected: 1, errors: [{ index: 1, message_id: 'x', code: 'INVALID_EVENT', message: 'properties: at most 50 keys' }] };
  const sent = []; const errors = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return sent.length === 1 ? { ok: true, status: 202, headers: { get: () => null }, text: async () => JSON.stringify(body) } : { ok: true, status: 202 };
  });
  t.mock.method(console, 'error', () => {});
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, logger: { enabled: true, levels: ['error'] }, errorHandler: error => errors.push(error) });
  try {
    sdk.track('one'); sdk.track('two'); await sdk.flush(); await sdk.flush();
    assert.equal(sent.length, 1, 'nothing is sent again');
    assert.equal(errors.length, 1);
    assert.deepEqual([errors[0].status, errors[0].dropped, errors[0].reasons], [202, 1, ['INVALID_EVENT']]);
    assert.match(errors[0].message, /The collector refused 1 of 2 event\(s\): HTTP 202 INVALID_EVENT\. The events are dropped/);
    // A 202 from an older collector ({ accepted }) or with no readable body reports nothing.
    sdk.track('next'); await sdk.flush();
    assert.equal(errors.length, 1);
  } finally { sdk.destroy(); }
});

const response = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null } });

test('retry: a refused batch (400, 401, 403, and 413 for one event) is dropped, not sent again', async t => {
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

test('413: a batch of 20 is halved and sent again at once; no event lost, no errorHandler, no backoff', async t => {
  browser('https://example.com/');
  const statuses = [413, 202, 202]; const sent = []; const errors = []; const warnings = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push({ body: JSON.parse(init.body), init }); return response(statuses[sent.length - 1] ?? 202); });
  t.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, batchSize: 30, logger: { enabled: true, levels: ['warn'] }, errorHandler: error => errors.push(error) });
  try {
    for (let i = 0; i < 20; i++) sdk.track(`e${i}`);
    await sdk.flush();
    assert.deepEqual(sent.map(item => item.body.events.length), [20, 10], 'the 413 is followed at once by a batch of 10');
    assert.equal(sdk.retryAt, 0, 'no backoff wait after a 413');
    await sdk.flush();
    assert.deepEqual(sent.map(item => item.body.events.length), [20, 10, 10]);
    const first = sent[0].body.events.map(event => event.message_id);
    assert.deepEqual([...sent[1].body.events, ...sent[2].body.events].map(event => event.message_id), first, 'same events, same order, same message_id');
    assert.deepEqual(sent[0].body.events.map(event => event.event), Array.from({ length: 20 }, (_, i) => `e${i}`));
    assert.equal(errors.length, 0);
    assert.ok(warnings.some(line => line.includes('413: batch of 20 events too large, sending 10')), warnings.join('\n'));
  } finally { sdk.destroy(); }
});

test('413: a batch of one event (also after halving) is dropped with SendError status 413, dropped 1', async t => {
  browser('https://example.com/');
  const sent = []; const errors = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return response(413); });
  t.mock.method(console, 'error', () => {});
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, errorHandler: error => errors.push(error) });
  try {
    sdk.track('alone'); await sdk.flush();
    assert.equal(sent.length, 1);
    assert.equal(errors.length, 1); assert.equal(errors[0].status, 413); assert.equal(errors[0].dropped, 1);
    await sdk.flush();
    assert.equal(sent.length, 1, 'the dropped event is not sent again');
    sdk.track('a'); sdk.track('b'); sdk.track('c'); await sdk.flush();
    assert.deepEqual(sent.slice(1).map(body => body.events.length), [3, 1], '3 events, then 1 after halving');
    assert.equal(errors.length, 2); assert.deepEqual([errors[1].status, errors[1].dropped], [413, 1]);
    assert.deepEqual(sent[2].events.map(event => event.event), ['a']);
  } finally { sdk.destroy(); }
});

test('413: after an accepted batch the next batch uses the full batchSize again', async t => {
  browser('https://example.com/');
  const statuses = [413]; const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return response(statuses[sent.length - 1] ?? 202); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, batchSize: 20 });
  try {
    for (let i = 0; i < 20; i++) sdk.track(`e${i}`); // a full batch: sent at once
    await tick();
    assert.deepEqual(sent.map(body => body.events.length), [20, 10]);
    for (let i = 20; i < 35; i++) sdk.track(`e${i}`);
    await tick(); await sdk.flush();
    assert.equal(sent[2].events.length, 20, 'full size after the 202');
    assert.deepEqual(sent.slice(1).flatMap(body => body.events.map(event => event.event)), Array.from({ length: 35 }, (_, i) => `e${i}`), 'no event lost or sent twice');
  } finally { sdk.destroy(); }
});

test('413: not counted as a retry; events that already had a server error are not dropped by it', async t => {
  browser('https://example.com/');
  const statuses = [503, 413, 202, 202]; const sent = []; const errors = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return response(statuses[sent.length - 1] ?? 202); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, retryCount: 1, errorHandler: error => errors.push(error) });
  try {
    sdk.track('a'); sdk.track('b');
    await sdk.flush(); // 503: one retry used
    await sdk.flush(); // 413, then 1 event: 202
    await sdk.flush(); // the other event: 202
    assert.deepEqual(sent.map(body => body.events.length), [2, 2, 1, 1]);
    assert.equal(errors.length, 0);
  } finally { sdk.destroy(); }
});

test('413 on the pagehide keepalive send: no second send on that page; the next normal send uses half', async t => {
  const { window } = browser('https://example.com/');
  const statuses = [413]; const sent = []; const errors = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push({ body: JSON.parse(init.body), init }); return response(statuses[sent.length - 1] ?? 202); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, batchSize: 30, errorHandler: error => errors.push(error) });
  try {
    for (let i = 0; i < 20; i++) sdk.track(`e${i}`);
    window.dispatchEvent(new Event('pagehide')); await tick();
    assert.equal(sent.length, 1); assert.equal(sent[0].init.keepalive, true);
    await sdk.flush();
    assert.equal(sent.length, 2); assert.equal(sent[1].init.keepalive, false);
    assert.deepEqual(sent[1].body.events.map(event => event.message_id), sent[0].body.events.slice(0, 10).map(event => event.message_id));
    await sdk.flush();
    assert.deepEqual(sent[2].body.events.map(event => event.message_id), sent[0].body.events.slice(10).map(event => event.message_id));
    assert.equal(errors.length, 0);
  } finally { sdk.destroy(); }
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

test('traits(): a traits event with the anonymous ID and no user ID; the user ID after identify() (P-2814)', async t => {
  browser('https://example.com/play');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = make({ publishableKey: 'mana_pk_traits' });
  try {
    sdk.traits({ level: 3, difficulty: 'hard', note: null });
    await sdk.flush();
    const [anon] = eventsOf(sent);
    assert.equal(anon.type, 'traits');
    assert.equal(anon.event, undefined);
    assert.equal(anon.channel, 'web');
    assert.deepEqual(anon.properties, {});
    assert.deepEqual(anon.traits, { level: 3, difficulty: 'hard', note: null });
    assert.match(anon.anonymous_id, uuid);
    assert.match(anon.session_id, uuid);
    assert.equal(anon.user_id, undefined);
    await sdk.identify('user_t');
    sdk.traits({ level: 4 });
    sdk.track('after');
    await sdk.flush();
    const user = eventsOf(sent).find(event => event.type === 'traits' && event.traits.level === 4);
    assert.equal(user.user_id, 'user_t');
    assert.equal(user.anonymous_id, anon.anonymous_id);
    assert.equal(eventsOf(sent).at(-1).traits, undefined, 'a track event has no traits');
  } finally { sdk.destroy(); }
});

test('traits(): protected traits are dropped with one console warning; bad input throws', async t => {
  browser('https://example.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const warnings = []; t.mock.method(console, 'warn', message => warnings.push(message));
  const sdk = make({ publishableKey: 'mana_pk_traits' });
  try {
    sdk.traits({ email: 'person@example.com', itch_user_id: '1', plan: 'pro' });
    sdk.traits({ stripe_customer_id: 'cus_1', paddle_customer_id: 'ctm_1' });
    await sdk.flush();
    const events = eventsOf(sent);
    assert.equal(events.length, 1, 'a call with only protected traits sends nothing');
    assert.deepEqual(events[0].traits, { plan: 'pro' });
    assert.ok(!JSON.stringify(sent).includes('person@example.com'));
    assert.equal(warnings.length, 1, 'one warning per instance');
    assert.match(warnings[0], /email, itch_user_id not sent/);
    assert.throws(() => sdk.traits({}), /at least one key/);
    assert.throws(() => sdk.traits(null), /must be an object/);
    assert.throws(() => sdk.traits(['a']), /must be an object/);
    assert.throws(() => sdk.traits(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 1]))), /at most 50 keys/);
    assert.throws(() => sdk.traits({ bio: 'x'.repeat(2100) }), /under 2KB/);
  } finally { sdk.destroy(); }
});

test('traits(): waits for consent, merges held calls, and setConsent(false) drops them and queued traits events', async t => {
  const { jar } = browser('https://consent.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = make({ publishableKey: 'mana_pk_consent', requireConsent: true });
  try {
    sdk.traits({ level: 1, mode: 'easy' });
    sdk.traits({ level: 2 });
    sdk.track('before');
    await sdk.flush();
    assert.equal(jar.writes.length, 0);
    assert.deepEqual(eventsOf(sent).map(event => event.type), ['track'], 'traits wait for consent');
    sdk.setConsent(true);
    await sdk.flush();
    const held = eventsOf(sent).at(-1);
    assert.equal(held.type, 'traits');
    assert.deepEqual(held.traits, { level: 2, mode: 'easy' });
    assert.match(held.anonymous_id, uuid);
    // Withdrawn consent: a queued traits event is discarded, and a held one is forgotten.
    sdk.traits({ level: 3 });
    sdk.setConsent(false);
    sdk.traits({ level: 4 });
    sdk.track('later');
    await sdk.flush();
    assert.deepEqual(eventsOf(sent).slice(-1).map(event => event.type), ['track']);
    sdk.setConsent(true);
    sdk.track('again');
    await sdk.flush();
    const traits = eventsOf(sent).filter(event => event.type === 'traits').map(event => event.traits.level);
    assert.deepEqual(traits, [2, 4], 'the queued level 3 is discarded; level 4 waits for consent again');
  } finally { sdk.destroy(); }
});

test('traits(): on an excluded page they are held and sent on the next allowed page; opted out is a no-op', async t => {
  const { window } = browser('https://example.com/admin');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, tracking: { excludePaths: ['/admin'] } });
  try {
    sdk.traits({ level: 5 });
    globalThis.location = new URL('https://example.com/home'); window.dispatchEvent(new Event('manalens:navigate'));
    await sdk.flush();
    assert.deepEqual(eventsOf(sent).map(event => event.type), ['traits', 'page']);
    sdk.optOut();
    sdk.traits({ level: 6 });
    sdk.optIn();
    sdk.track('back');
    await sdk.flush();
    assert.equal(eventsOf(sent).filter(event => event.type === 'traits').length, 1);
  } finally { sdk.destroy(); }
});

const linkTicket = '140000000a0b0c0d0e0f101112131415161718191a1b1c1d';
test('link(): posts the Steam ticket and the anonymous ID to the API host (P-2815)', async t => {
  browser('https://example.com/');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return { ...response(200), text: async () => '{"linked":true,"provider":"steam"}' }; });
  const sdk = make({ publishableKey: 'mana_pk_link', endpoint: 'https://events.manalens.dev' });
  try {
    const result = await sdk.link({ provider: 'steam', ticket: linkTicket });
    assert.deepEqual(result, { linked: true, status: 200 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.manalens.dev/v0/link');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.headers['x-publishable-key'], 'mana_pk_link');
    assert.deepEqual(JSON.parse(calls[0].init.body), { provider: 'steam', ticket: linkTicket, anonymous_id: sdk.getAnonymousId() });
    // A proxy or a local collector serves both paths; apiEndpoint wins.
    for (const [options, url] of [[{ endpoint: 'http://localhost:3001/' }, 'http://localhost:3001/v0/link'], [{ endpoint: 'https://events.manalens.dev', apiEndpoint: 'https://example.com/mana/' }, 'https://example.com/mana/v0/link']]) {
      const other = make({ publishableKey: 'mana_pk_link', ...options });
      await other.link({ provider: 'steam', ticket: linkTicket });
      other.destroy();
      assert.equal(calls.at(-1).url, url);
    }
  } finally { sdk.destroy(); }
});

test('link(): a 4xx is not sent again; a 429 with Retry-After is tried once more; a network error returns', async t => {
  browser('https://example.com/');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const statuses = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    const next = statuses.shift();
    if (next === 'offline') throw new TypeError('Failed to fetch');
    const [status, code, headers] = next;
    return { ...response(status, headers), text: async () => JSON.stringify({ error: { code, message: 'no' } }) };
  });
  const sdk = make({ publishableKey: 'mana_pk_link' });
  try {
    for (const [status, code] of [[400, 'STEAM_TICKET_INVALID'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [409, 'STEAM_NOT_CONNECTED'], [502, 'STEAM_UNAVAILABLE'], [503, 'NOT_CONFIGURED']]) {
      calls = 0; statuses.push([status, code]);
      assert.deepEqual(await sdk.link({ provider: 'steam', ticket: linkTicket }), { linked: false, status, code });
      assert.equal(calls, 1, `${status} is not sent again`);
    }
    calls = 0; statuses.push([429, 'RATE_LIMITED', { 'retry-after': '2' }], [429, 'RATE_LIMITED', { 'retry-after': '2' }]);
    const limited = sdk.link({ provider: 'steam', ticket: linkTicket });
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(2000);
    assert.deepEqual(await limited, { linked: false, status: 429, code: 'RATE_LIMITED' });
    assert.equal(calls, 2, 'one more try after Retry-After, then no loop');
    calls = 0; statuses.push([429, 'RATE_LIMITED', { 'retry-after': '600' }]);
    assert.deepEqual(await sdk.link({ provider: 'steam', ticket: linkTicket }), { linked: false, status: 429, code: 'RATE_LIMITED' });
    assert.equal(calls, 1, 'a Retry-After over 60 s is not waited for');
    calls = 0; statuses.push('offline');
    assert.deepEqual(await sdk.link({ provider: 'steam', ticket: linkTicket }), { linked: false, status: 0, code: 'NETWORK_ERROR' });
    assert.equal(calls, 1);
  } finally { sdk.destroy(); }
});

test('link(): bad input throws; nothing is sent before consent, when disabled, or after optOut()', async t => {
  browser('https://example.com/');
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return response(200); });
  const consent = make({ publishableKey: 'mana_pk_link', requireConsent: true });
  const disabled = make({ publishableKey: 'mana_pk_link', disabled: true });
  const opted = make({ publishableKey: 'mana_pk_link' });
  try {
    await assert.rejects(consent.link({ provider: 'epic', ticket: linkTicket }), /provider must be 'steam'/);
    await assert.rejects(consent.link({ provider: 'steam', ticket: 'abc' }), /ticket must be hex/);
    await assert.rejects(consent.link({ provider: 'steam', ticket: `${linkTicket}a` }), /ticket must be hex/, 'odd length');
    await assert.rejects(consent.link({ provider: 'steam', ticket: 'zz'.repeat(20) }), /ticket must be hex/);
    await assert.rejects(consent.link({ provider: 'steam', ticket: 'ab'.repeat(2049) }), /ticket must be hex/, 'over 4096');
    assert.deepEqual(await consent.link({ provider: 'steam', ticket: linkTicket.toUpperCase() }), { linked: false, status: 0, code: 'CONSENT_REQUIRED' });
    assert.deepEqual(await disabled.link({ provider: 'steam', ticket: linkTicket }), { linked: false, status: 0, code: 'DISABLED' });
    opted.optOut();
    assert.deepEqual(await opted.link({ provider: 'steam', ticket: linkTicket }), { linked: false, status: 0, code: 'DISABLED' });
    assert.equal(calls, 0);
  } finally { consent.destroy(); disabled.destroy(); opted.destroy(); opted.optIn(); }
});

test('link(): consent withdrawn, reset(), optOut() or an excluded page during the Retry-After wait stops the second try', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cases = [
    ['setConsent(false)', sdk => sdk.setConsent(false), 'CONSENT_REQUIRED'],
    ['reset()', sdk => sdk.reset(), 'IDENTITY_CHANGED'],
    ['optOut()', sdk => sdk.optOut(), 'DISABLED'],
    ['excluded page', () => { globalThis.location = new URL('https://example.com/admin'); }, 'EXCLUDED'],
  ];
  for (const [name, change, code] of cases) {
    browser('https://example.com/');
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return { ...response(429, { 'retry-after': '2' }), text: async () => '{"error":{"code":"RATE_LIMITED"}}' }; });
    const sdk = make({ publishableKey: 'mana_pk_link', tracking: { excludePaths: ['/admin'] } });
    try {
      const pending = sdk.link({ provider: 'steam', ticket: linkTicket });
      await new Promise(resolve => setImmediate(resolve));
      change(sdk);
      t.mock.timers.tick(2000);
      assert.deepEqual(await pending, { linked: false, status: 0, code }, name);
      assert.equal(calls, 1, `${name}: no second request`);
    } finally { sdk.destroy(); sdk.optIn(); }
  }
});

// P-2800: game mode (game_open, sessions, errors) and trackError().
// G-2526: the persistent queue (IndexedDB, else localStorage).
const gameOptions = (extra = {}) => ({ publishableKey: 'mana_pk_game', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, app: gameApp, game: true, ...extra });
const named = (events, name) => events.filter(event => event.event === name);
const tracked = events => events.map(event => event.event ?? event.type);
const settle = sdk => sdk.persist?.settled() ?? Promise.resolve();
const hex16 = /^[0-9a-f]{16}$/;
const windowError = (fields) => Object.assign(new Event('error'), fields);
const rejection = reason => Object.assign(new Event('unhandledrejection'), { reason });

/** A small IndexedDB stand-in: one object store per database, keyPath `id`, put / delete / clear / getAll. */
function fakeIndexedDB() {
  const dbs = new Map();
  const transaction = store => {
    const tx = { objectStore: () => ({
      put: value => { store.set(value.id, structuredClone(value)); },
      delete: id => { store.delete(id); },
      clear: () => { store.clear(); },
      getAll: () => { const req = {}; queueMicrotask(() => { req.result = [...store.values()].map(value => structuredClone(value)); req.onsuccess?.(); }); return req; },
    }) };
    queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
    return tx;
  };
  return {
    dbs,
    open(name) {
      const req = {};
      queueMicrotask(() => {
        let stores = dbs.get(name); const fresh = !stores;
        if (!stores) { stores = new Map(); dbs.set(name, stores); }
        req.result = { objectStoreNames: { contains: n => stores.has(n) }, createObjectStore: n => { stores.set(n, new Map()); }, transaction: n => transaction(stores.get(n)) };
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

test('game mode: session_start and game_open on each start; the first open is kept in the SDK storage', async t => {
  const jar = cookieJar(); const local = memoryStorage();
  browser('https://game.example/play', { jar, local });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    await sdk.flush();
    const [start, open] = eventsOf(sent);
    assert.deepEqual(tracked(eventsOf(sent)), ['session_start', 'game_open']);
    assert.deepEqual(start.properties, {});
    assert.equal(open.properties.is_first_open, true);
    assert.equal(new Date(open.properties.first_open_at).toISOString(), open.properties.first_open_at);
    assert.equal(start.session_id, open.session_id); assert.match(open.session_id, uuid);
    assert.deepEqual(open.context.app, gameApp); assert.equal(open.channel, 'web');
    assert.ok(start.original_timestamp <= open.original_timestamp);
    const key = [...local.stored.keys()].find(name => name.endsWith('_first-open'));
    assert.ok(key?.startsWith('mana_'), 'stored under the SDK key');
    assert.equal(local.stored.get(key), open.properties.first_open_at);

    // pagehide ends the session.
    globalThis.window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 0));
    const [end] = named(eventsOf(sent), 'session_end');
    assert.equal(end.session_id, open.session_id);
    assert.equal(typeof end.properties.duration_s, 'number'); assert.ok(end.properties.duration_s >= 0);
    assert.equal(end.properties.errors_dropped, undefined);
    sdk.destroy();

    // The next start: not the first open, the same first_open_at, a new session.
    sent.length = 0;
    const again = new Analytics(gameOptions({ persistQueue: false }));
    await again.flush();
    const reopened = named(eventsOf(sent), 'game_open')[0];
    assert.equal(reopened.properties.is_first_open, false);
    assert.equal(reopened.properties.first_open_at, open.properties.first_open_at);
    assert.notEqual(reopened.session_id, open.session_id, 'each start is a new session');
    assert.equal(reopened.anonymous_id, open.anonymous_id);
    again.destroy();
  } finally { sdk.destroy(); }
});

test('game mode: a player with the first_open_at key of the old setup snippet is not counted as new', async t => {
  const local = memoryStorage(new Map([['first_open_at', '2026-10-01T12:00:00.000Z']]));
  browser('https://game.example/', { local });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    await sdk.flush();
    assert.deepEqual(named(eventsOf(sent), 'game_open')[0].properties, { is_first_open: false, first_open_at: '2026-10-01T12:00:00.000Z' });
  } finally { sdk.destroy(); }
});

test('game and persistQueue need a valid app option: without one they are off, with a console warning', async t => {
  const { local } = browser('https://example.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const warnings = []; t.mock.method(console, 'warn', message => warnings.push(message));
  const sdk = new Analytics({ publishableKey: 'mana_pk_web', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, game: true, persistQueue: true });
  try {
    sdk.track('clicked'); await sdk.flush();
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /game option needs a valid app option/);
    assert.match(warnings[1], /persistQueue option needs a valid app option/);
    assert.ok(![...local.stored.keys()].some(key => key.endsWith('_queue') || key.endsWith('_first-open')), 'nothing stored');
    globalThis.window.dispatchEvent(windowError({ message: 'boom', error: new Error('boom') }));
    t.mock.method(globalThis, 'fetch', collector(sent));
    await sdk.flush();
    assert.deepEqual(tracked(eventsOf(sent)), ['clicked'], 'no game events, no captured errors');
  } finally { sdk.destroy(); }
  // An invalid app object turns game mode off too.
  const invalid = new Analytics({ ...gameOptions(), app: { platform: 'playstation' } });
  try { await invalid.flush(); assert.equal(named(eventsOf(sent), 'game_open').length, 0); } finally { invalid.destroy(); }
});

test('game mode: 30 minutes idle ends the session at its last activity; the next event starts a new one', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    t.mock.timers.tick(10 * 60000); sdk.track('level_start');
    t.mock.timers.tick(31 * 60000); sdk.track('level_start');
    await sdk.flush();
    const events = eventsOf(sent);
    assert.deepEqual(tracked(events), ['session_start', 'game_open', 'level_start', 'session_end', 'session_start', 'level_start']);
    const [first, , active, end, next, later] = events;
    assert.equal(end.session_id, first.session_id);
    assert.equal(end.original_timestamp, active.original_timestamp, 'ended at the last activity');
    assert.equal(end.properties.duration_s, 600);
    assert.notEqual(next.session_id, first.session_id);
    assert.equal(later.session_id, next.session_id);
    assert.equal(next.original_timestamp, '2026-01-01T10:41:00.000Z');
  } finally { sdk.destroy(); }
});

test('game mode: the flush timer keeps a visible, focused game session alive, and only then', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const { document } = browser('https://game.example/');
  let focused = true;
  document.visibilityState = 'visible'; document.hasFocus = () => focused;
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    for (let i = 0; i < 40; i++) t.mock.timers.tick(60000);
    sdk.track('still_playing');
    await sdk.flush();
    assert.equal(named(eventsOf(sent), 'session_end').length, 0, 'the player was active: one session');
    focused = false;
    for (let i = 0; i < 40; i++) t.mock.timers.tick(60000);
    sdk.track('back');
    await sdk.flush();
    const [end] = named(eventsOf(sent), 'session_end');
    assert.equal(end.properties.duration_s, 40 * 60, 'ended at the last activity: the event after 40 minutes');
    assert.equal(named(eventsOf(sent), 'session_start').length, 2);
  } finally { sdk.destroy(); }
});

test('game mode: uncaught errors and unhandled rejections become error events without personal data', async t => {
  const { window } = browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    const error = new TypeError('Cannot load https://cdn.example.com/save.json?token=abc for anna@example.com');
    error.stack = `TypeError: ${error.message}\n    at Player.jump (https://game.example/assets/index.js?v=2:10:5)\n    at https://game.example/assets/index.js:3:1\n${'    at loop (https://game.example/a.js:1:1)\n'.repeat(40)}`;
    window.dispatchEvent(windowError({ message: `Uncaught ${error}`, filename: 'https://game.example/assets/index.js?v=2', lineno: 10, colno: 5, error }));
    window.dispatchEvent(rejection('Save failed for slot "three" 42'));
    const crossOrigin = windowError({ message: 'Script error.', filename: '', lineno: 0 });
    window.dispatchEvent(crossOrigin);
    await sdk.flush();
    const [uncaught, rejected, script] = named(eventsOf(sent), 'error');
    assert.deepEqual(Object.keys(uncaught.properties), ['severity', 'message', 'handled', 'source', 'fingerprint', 'error_type', 'file', 'line', 'function', 'stack', 'breadcrumbs']);
    assert.equal(uncaught.properties.breadcrumbs, 'session_start,game_open');
    assert.equal(uncaught.properties.severity, 'error');
    assert.equal(uncaught.properties.message, 'Cannot load https://cdn.example.com/save.json for [email]');
    assert.equal(uncaught.properties.error_type, 'TypeError');
    assert.equal(uncaught.properties.handled, false);
    assert.equal(uncaught.properties.source, 'auto');
    assert.equal(uncaught.properties.file, '/assets/index.js');
    assert.equal(uncaught.properties.line, 10);
    assert.equal(uncaught.properties.function, 'Player.jump');
    assert.equal(uncaught.properties.fingerprint, errorFingerprint('TypeError', '', '/assets/index.js', 'Player.jump'));
    assert.ok(uncaught.properties.stack.length <= 1024);
    assert.ok(!JSON.stringify(uncaught).includes('anna') && !JSON.stringify(uncaught).includes('token=abc') && !uncaught.properties.stack.includes('?v=2'));
    assert.match(uncaught.session_id, uuid);
    assert.equal(rejected.properties.error_type, 'unhandledrejection');
    assert.equal(rejected.properties.source, 'auto');
    assert.equal(rejected.properties.handled, false);
    assert.equal(rejected.properties.message, 'Save failed for slot "three" 42');
    assert.equal(rejected.properties.file, undefined);
    assert.equal(rejected.properties.fingerprint, errorFingerprint('unhandledrejection', 'Save failed for slot "x" 7', '', ''), 'grouped by the message without numbers and quoted text');
    assert.match(rejected.properties.fingerprint, hex16);
    assert.equal(script.properties.message, 'Script error.');
    assert.equal(script.properties.error_type, 'uncaught');
  } finally { sdk.destroy(); }
  // destroy() removes the listeners.
  sent.length = 0;
  window.dispatchEvent(windowError({ message: 'late', error: new Error('late') }));
  assert.equal(sent.length, 0);
});

test('the fingerprint is the one of the game SDKs (Unity request fixtures)', () => {
  assert.equal(errorFingerprint('SaveFailed', 'Save failed for slot 3', '', ''), '38d0e3d0139dea87');
  assert.equal(errorFingerprint('NullReferenceException', 'NullReferenceException: Object reference not set to an instance of an object', 'Assets/Scripts/Player.cs', 'Game.Player.Jump'), 'c2eb323ad8048b1a');
  assert.equal(errorFingerprint('SaveFailed', 'Save failed for slot 4', '', ''), errorFingerprint('SaveFailed', 'Save failed for slot 3', '', ''));
  assert.equal(errorFingerprint('E', "Item 'sword' 0xFF missing", '', ''), errorFingerprint('E', "Item 'axe' 0x1 missing", '', ''));
  assert.notEqual(errorFingerprint('A', 'x', 'f.js', 'run'), errorFingerprint('B', 'x', 'f.js', 'run'));
});

test('error limits: the same fingerprint once a second, 20 errors in 10 s, 50 automatic errors in a session; drops go to errors_dropped', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const { window } = browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false, batchSize: 50 }));
  // Errors without a stack group by the message.
  const fire = message => window.dispatchEvent(windowError({ message, error: Object.assign(new Error(message), { stack: '' }) }));
  try {
    for (let i = 0; i < 5; i++) fire('same in a frame loop');
    t.mock.timers.tick(1000); fire('same in a frame loop');
    let errors = () => named(eventsOf(sent), 'error');
    await sdk.flush(); await sdk.flush();
    assert.equal(errors().length, 2, 'once a second: 4 dropped');
    t.mock.timers.tick(10_000);
    for (let i = 0; i < 25; i++) fire(`distinct ${'x'.repeat(i)}`);
    await sdk.flush();
    assert.equal(errors().length, 22, '20 in 10 s: 5 dropped');
    for (let w = 0; w < 3; w++) { t.mock.timers.tick(10_000); for (let i = 0; i < 20; i++) fire(`window ${w} ${'y'.repeat(i)}`); await sdk.flush(); }
    assert.equal(errors().length, 50, '50 automatic errors in one session');
    // Manual errors skip only the session cap.
    t.mock.timers.tick(10_000);
    sdk.trackError('Manual after the cap', { errorType: 'SaveFailed' });
    await sdk.flush();
    assert.equal(errors().length, 51);
    window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 0));
    const [end] = named(eventsOf(sent), 'session_end');
    assert.equal(end.properties.errors_dropped, 4 + 5 + (60 - 28), 'dedupe, window, then the session cap');
  } finally { sdk.destroy(); }
});

test('trackError(): handled errors with source manual; an Error gives type, stack and place; options win', async t => {
  browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    sdk.trackError('Save failed for slot 3', { errorType: 'SaveFailed', severity: 'critical', handled: false, properties: { slot: 3, severity: 'ignored' } });
    const error = new RangeError('Bad level');
    error.stack = 'loadLevel@https://game.example/js/game.js?build=9:77:3\n@https://game.example/js/game.js:1:1';
    sdk.trackError(error);
    sdk.trackError(new Error('custom'), { fingerprint: 'my-group', file: 'src/save.ts', line: 12, function: 'save' });
    const big = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, 'v'.repeat(200)]));
    sdk.trackError('Too many properties', { properties: big });
    await sdk.flush();
    const [manual, fromError, custom, limited] = named(eventsOf(sent), 'error');
    assert.deepEqual(manual.properties, { severity: 'critical', message: 'Save failed for slot 3', handled: false, source: 'manual', fingerprint: '38d0e3d0139dea87', error_type: 'SaveFailed', breadcrumbs: 'session_start,game_open', slot: 3 });
    assert.equal(fromError.properties.handled, true, 'trackError() defaults to handled: true');
    assert.equal(fromError.properties.error_type, 'RangeError');
    assert.equal(fromError.properties.file, '/js/game.js');
    assert.equal(fromError.properties.line, 77);
    assert.equal(fromError.properties.function, 'loadLevel');
    assert.ok(!fromError.properties.stack.includes('build=9'));
    assert.equal(custom.properties.fingerprint, 'my-group');
    assert.deepEqual([custom.properties.file, custom.properties.line, custom.properties.function], ['src/save.ts', 12, 'save']);
    assert.ok(Object.keys(limited.properties).length <= 50);
    assert.ok(new TextEncoder().encode(JSON.stringify(limited.properties)).byteLength <= 8192);
    assert.equal(limited.properties.message, 'Too many properties', 'the error keys are kept first');
  } finally { sdk.destroy(); }
});

test('trackError() works without game mode and sends nothing after optOut()', async t => {
  browser('https://example.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_web', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false });
  try {
    sdk.trackError(new Error('Checkout failed'));
    await sdk.flush();
    assert.deepEqual(tracked(eventsOf(sent)), ['error']);
    assert.equal(eventsOf(sent)[0].properties.source, 'manual');
    sdk.optOut(); sdk.trackError('after'); await sdk.flush();
    assert.equal(eventsOf(sent).length, 1);
  } finally { sdk.destroy(); }
});

test('game mode with consent: nothing stored and no game events before consent; withdrawal deletes the first open', async t => {
  const jar = cookieJar(); const local = memoryStorage();
  browser('https://game.example/', { jar, local });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ requireConsent: true }));
  try {
    sdk.track('menu');
    await sdk.flush();
    assert.deepEqual(tracked(eventsOf(sent)), ['menu']);
    assert.equal(eventsOf(sent)[0].session_id, undefined);
    assert.equal(local.stored.size, 0, 'no localStorage before consent'); assert.equal(jar.find('mana_').length, 0, 'no cookie before consent');
    sdk.setConsent(true);
    await sdk.flush();
    assert.deepEqual(tracked(eventsOf(sent)), ['menu', 'session_start', 'game_open']);
    assert.equal(named(eventsOf(sent), 'game_open')[0].properties.is_first_open, true);
    assert.ok([...local.stored.keys()].some(key => key.endsWith('_first-open')));
    sdk.setConsent(false);
    await settle(sdk);
    assert.ok(![...local.stored.keys()].some(key => key.endsWith('_first-open') || key.endsWith('_queue')), 'first open and stored events deleted');
    sdk.setConsent(true);
    await sdk.flush();
    assert.equal(named(eventsOf(sent), 'game_open').length, 2, 'a new identity opens the game again');
    assert.equal(named(eventsOf(sent), 'game_open')[1].properties.is_first_open, true);
  } finally { sdk.destroy(); }
});

test('game mode: reset() ends the session with the old identity; the next event starts a new session', async t => {
  browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    await sdk.identify('player_1');
    sdk.reset();
    sdk.track('after_reset');
    await sdk.flush();
    const events = eventsOf(sent);
    assert.deepEqual(tracked(events), ['session_start', 'game_open', 'identify', 'session_end', 'session_start', 'after_reset']);
    const [start, , identify, end, next, after] = events;
    assert.equal(end.session_id, start.session_id); assert.equal(end.anonymous_id, start.anonymous_id); assert.equal(end.user_id, 'player_1');
    assert.equal(identify.user_id, 'player_1');
    assert.notEqual(next.anonymous_id, start.anonymous_id); assert.equal(next.user_id, undefined);
    assert.equal(after.session_id, next.session_id);
  } finally { sdk.destroy(); }
});

// P-2835: game_crash at the next load and breadcrumbs, as in the game SDKs.
const gameStateKey = local => [...local.stored.keys()].find(name => name.endsWith('_game-state'));
const gameState = local => { const key = gameStateKey(local); return key ? JSON.parse(local.stored.get(key)) : {}; };
/** A tab that crashes: its storage stays as it was, with no pagehide. */
const crash = (sdk, local) => { const snapshot = new Map(local.stored); sdk.destroy(); local.stored.clear(); for (const [key, value] of snapshot) local.stored.set(key, value); };

test('game mode: a tab that crashed with focus sends game_crash at the next load; a normal close does not (P-2835)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const local = memoryStorage();
  const { document } = browser('https://game.example/', { local });
  document.visibilityState = 'visible'; document.hasFocus = () => true;
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const first = new Analytics(gameOptions({ persistQueue: false }));
  await first.flush();
  const [open] = named(eventsOf(sent), 'game_open');
  const entries = Object.values(gameState(local));
  assert.equal(entries.length, 1, 'one entry for the open game session');
  assert.deepEqual(entries[0], { session_id: open.session_id, anonymous_id: open.anonymous_id, at: Date.parse('2026-01-01T10:00:00Z'), focused: true, build: '571', app_version: '1.4.0' });
  // The tab crashes (out of memory): no pagehide. The player opens the game again.
  t.mock.timers.tick(60_000);
  crash(first, local);
  sent.length = 0;
  const second = new Analytics(gameOptions({ persistQueue: false }));
  try {
    await second.flush();
    const events = eventsOf(sent);
    assert.deepEqual(tracked(events), ['game_crash', 'session_start', 'game_open']);
    const [gameCrash, start] = events;
    assert.deepEqual(gameCrash.properties, { previous_session_id: open.session_id, previous_build: '571', previous_app_version: '1.4.0' });
    assert.equal(gameCrash.session_id, open.session_id, 'sent in the session that crashed');
    assert.equal(gameCrash.anonymous_id, open.anonymous_id);
    assert.equal(gameCrash.user_id, undefined, 'the user ID of that session (none)');
    assert.equal(gameCrash.original_timestamp, '2026-01-01T10:00:00.000Z', 'at the last saved time');
    assert.notEqual(start.session_id, open.session_id);
    assert.deepEqual(Object.values(gameState(local)).map(entry => entry.session_id), [start.session_id], 'the old entry is gone');
    // A normal close (pagehide) removes the entry: the next load sends no game_crash.
    globalThis.window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(gameStateKey(local), undefined);
  } finally { second.destroy(); }
  sent.length = 0;
  t.mock.timers.tick(60_000);
  const third = new Analytics(gameOptions({ persistQueue: false }));
  try { await third.flush(); assert.deepEqual(tracked(eventsOf(sent)), ['session_start', 'game_open']); } finally { third.destroy(); }
});

test('game mode: no game_crash after shutdown() or destroy(), or when the tab was hidden or had no focus', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const cases = [
    ['hidden', document => { document.visibilityState = 'hidden'; }, sdk => sdk],
    ['no focus', document => { document.hasFocus = () => false; }, sdk => sdk],
    ['blur after the start', document => { let focused = true; document.hasFocus = () => focused; return () => { focused = false; globalThis.window.dispatchEvent(new Event('blur')); }; }, sdk => sdk],
    ['shutdown()', () => {}, sdk => sdk, true],
  ];
  for (const [name, setup, , quit] of cases) {
    const local = memoryStorage();
    const { document } = browser('https://game.example/', { local });
    document.visibilityState = 'visible'; document.hasFocus = () => true;
    const after = setup(document);
    const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
    const first = new Analytics(gameOptions({ persistQueue: false }));
    await first.flush();
    if (typeof after === 'function') after();
    t.mock.timers.tick(60_000);
    if (quit) { await first.shutdown(); assert.equal(gameStateKey(local), undefined, `${name}: entry removed`); } else crash(first, local);
    sent.length = 0;
    document.visibilityState = 'visible'; document.hasFocus = () => true;
    const next = new Analytics(gameOptions({ persistQueue: false }));
    try { await next.flush(); assert.equal(named(eventsOf(sent), 'game_crash').length, 0, name); } finally { next.destroy(); }
  }
  // destroy() is a stop by the game too.
  const local = memoryStorage();
  browser('https://game.example/', { local });
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  await sdk.flush();
  assert.ok(gameStateKey(local));
  sdk.destroy();
  assert.equal(gameStateKey(local), undefined);
});

test('game mode: a focused entry newer than 20 s can be an open tab: game_crash only when it is not written again', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const local = memoryStorage();
  const { document } = browser('https://game.example/', { local });
  document.visibilityState = 'visible'; document.hasFocus = () => true;
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  // The player reloads 5 s after a crash.
  const crashed = new Analytics(gameOptions({ persistQueue: false }));
  crashed.track('level_start');
  const crashedSession = crashed.getSessionId();
  t.mock.timers.tick(5000);
  crash(crashed, local);
  const reloaded = new Analytics(gameOptions({ persistQueue: false }));
  try {
    assert.equal(named(reloaded.pending, 'game_crash').length, 0, 'not yet: the tab could still be open');
    t.mock.timers.tick(20_000);
    const [gameCrash] = named(reloaded.pending, 'game_crash');
    assert.equal(gameCrash?.properties.previous_session_id, crashedSession);
  } finally { reloaded.destroy(); }

  // reset() before the second look: the old session's crash is not linked to the new identity.
  local.stored.clear();
  const crashedAgain = new Analytics(gameOptions({ persistQueue: false }));
  t.mock.timers.tick(5000);
  crash(crashedAgain, local);
  const afterReset = new Analytics(gameOptions({ persistQueue: false }));
  try {
    afterReset.reset();
    t.mock.timers.tick(25_000);
    assert.equal(named(afterReset.pending, 'game_crash').length, 0, 'no game_crash after reset()');
  } finally { afterReset.destroy(); }

  // An entry of another anonymous ID (the identity changed since): dropped, no game_crash.
  local.stored.clear();
  const otherIdentity = new Analytics(gameOptions({ persistQueue: false }));
  await otherIdentity.identify('player_old');
  t.mock.timers.tick(5000);
  crash(otherIdentity, local);
  const entry = Object.values(gameState(local))[0];
  assert.equal(entry.user_id, 'player_old');
  t.mock.timers.tick(30_000);
  const savedKey = gameStateKey(local);
  const saved = local.stored.get(savedKey);
  local.stored.set(savedKey, saved.replace(entry.anonymous_id, '00000000-0000-4000-8000-000000000000'));
  const newIdentity = new Analytics(gameOptions({ persistQueue: false }));
  try {
    assert.equal(named(newIdentity.pending, 'game_crash').length, 0, 'not sent for another anonymous ID');
    assert.equal(gameStateKey(local) && Object.values(gameState(local)).some(item => item.session_id === entry.session_id), false, 'the entry is removed');
  } finally { newIdentity.destroy(); }

  // A second tab opens in the background while the first one is open and focused: no game_crash.
  local.stored.clear();
  const playing = new Analytics(gameOptions({ persistQueue: false }));
  t.mock.timers.tick(2000);
  const background = new Analytics(gameOptions({ persistQueue: false }));
  try {
    for (let i = 0; i < 12; i++) t.mock.timers.tick(5000);
    assert.equal(named(background.pending, 'game_crash').length, 0);
    assert.equal(Object.keys(gameState(local)).length, 2, 'one entry per tab');
  } finally { playing.destroy(); background.destroy(); }
});

test('game mode: nothing saved for crashes before consent; consent withdrawal and optOut() delete it; websites save nothing', async t => {
  const local = memoryStorage();
  browser('https://game.example/', { local });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ requireConsent: true, persistQueue: false }));
  try {
    sdk.track('menu');
    assert.equal(gameStateKey(local), undefined, 'nothing before consent');
    sdk.setConsent(true);
    assert.ok(gameStateKey(local));
    sdk.setConsent(false);
    assert.equal(gameStateKey(local), undefined, 'deleted on withdrawal');
    sdk.setConsent(true);
    assert.ok(gameStateKey(local));
    sdk.optOut();
    assert.equal(gameStateKey(local), undefined, 'deleted on optOut()');
  } finally { sdk.destroy(); sdk.optIn(); }
  // Website mode (no game option), also with an app option: no saved state and no breadcrumbs.
  const web = new Analytics({ publishableKey: 'mana_pk_game', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, app: gameApp });
  try {
    web.track('clicked');
    web.trackError('boom');
    await web.flush();
    assert.equal(gameStateKey(local), undefined);
    const [error] = named(eventsOf(sent), 'error');
    assert.equal(error.properties.breadcrumbs, undefined);
  } finally { web.destroy(); }
});

test('breadcrumbs: the last 20 track event names (not errors, not page views), at most 1024 characters, the end kept', async t => {
  browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false, batchSize: 50 }));
  try {
    sdk.page();
    for (let i = 1; i <= 25; i++) sdk.track(`step_${i}`);
    sdk.trackError('first');
    sdk.trackError('second', { properties: { breadcrumbs: 'mine' } });
    await sdk.flush();
    const [first, second] = named(eventsOf(sent), 'error');
    const expected = Array.from({ length: 20 }, (_, i) => `step_${i + 6}`).join(',');
    assert.equal(first.properties.breadcrumbs, expected, 'session_start, game_open and step_1 to step_5 dropped out');
    assert.equal(second.properties.breadcrumbs, expected, 'errors are not breadcrumbs; the SDK value wins over a custom one');
    // Long names: the string is cut to 1024 characters and keeps the newest names.
    for (let i = 0; i < 20; i++) sdk.track(`${String(i).padStart(2, '0')}_${'n'.repeat(120)}`);
    sdk.trackError('long');
    await sdk.flush();
    const long = named(eventsOf(sent), 'error')[2].properties.breadcrumbs;
    assert.equal(long.length, 1024);
    assert.ok(long.endsWith(`19_${'n'.repeat(120)}`));
  } finally { sdk.destroy(); }
});

test('breadcrumbs: nothing before consent reaches a later error', async t => {
  browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false, requireConsent: true }));
  try {
    sdk.track('menu_before_consent');
    sdk.trackError('before consent');
    sdk.setConsent(true);
    sdk.trackError('after consent');
    await sdk.flush();
    const [before, after] = named(eventsOf(sent), 'error');
    assert.equal(before.properties.breadcrumbs, undefined);
    assert.equal(after.properties.breadcrumbs, 'session_start,game_open');
  } finally { sdk.destroy(); }
});

test('breadcrumbs: reset() and setConsent(false) clear them, as in the game SDKs', async t => {
  browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    sdk.track('old_player_event');
    sdk.reset();
    sdk.trackError('after reset');
    sdk.setConsent(false);
    sdk.trackError('no consent');
    sdk.setConsent(true);
    sdk.trackError('after consent');
    await sdk.flush();
    const [afterReset, noConsent, afterConsent] = named(eventsOf(sent), 'error');
    assert.equal(afterReset.properties.breadcrumbs, 'session_start', 'the old names are gone; the new session is in');
    assert.equal(noConsent.properties.breadcrumbs, undefined);
    assert.equal(afterConsent.properties.breadcrumbs, 'session_start,game_open');
  } finally { sdk.destroy(); }
});

// P-2833: hang detection. Node has no longtask or long-animation-frame entries, so these tests use the timer fallback,
// except the last one, which gives the SDK a PerformanceObserver stand-in.
/** A page with visibility events, a mocked clock (Date and timers) and performance.now() that follows it, less `asleep`. */
function hangPage(t, url = 'https://game.example/') {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const page = browser(url, { local: memoryStorage() });
  const events = new EventTarget();
  Object.assign(page.document, { visibilityState: 'visible', hasFocus: () => true, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
  const base = Date.now();
  const clock = { asleep: 0 };
  t.mock.method(performance, 'now', () => Date.now() - base - clock.asleep);
  /** The main thread is blocked for `ms`: the clocks move, no timer runs; then the next tick runs. */
  const block = ms => { t.mock.timers.setTime(Date.now() + ms); t.mock.timers.tick(500); };
  const run = ms => { for (let i = 0; i < ms / 500; i++) t.mock.timers.tick(500); };
  const show = state => { page.document.visibilityState = state; page.document.dispatchEvent(new Event('visibilitychange')); };
  return { ...page, clock, block, run, show };
}
const hangs = events => named(events, 'error').filter(event => event.properties.error_type === 'game_hang');

test('hang detection: a main thread blocked for 5 s or more sends an game_hang error when it runs again (P-2833)', async t => {
  const { block, run } = hangPage(t);
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    run(3000);
    block(3000);
    sdk.track('level_start');
    block(6000);
    await sdk.flush();
    const [hang, ...more] = hangs(eventsOf(sent));
    assert.equal(more.length, 0, 'the 3 s block is under the limit');
    assert.deepEqual(hang.properties, {
      severity: 'error', message: 'The main thread was blocked for 6.0 s', handled: false, source: 'auto',
      fingerprint: errorFingerprint('game_hang', 'The main thread was blocked for 9.9 s', '', ''), error_type: 'game_hang',
      breadcrumbs: 'session_start,game_open,level_start', hang_duration_s: 6,
    });
    assert.equal(hang.original_timestamp, new Date(Date.now()).toISOString(), 'sent when the thread runs again');
  } finally { sdk.destroy(); }
});

test('hang detection: never while the page is hidden or just visible again, and not for a sleep of the computer', async t => {
  const { block, run, show, clock } = hangPage(t);
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    show('hidden');
    run(2000);
    block(60_000); // a background tab: timers throttled
    show('visible');
    block(8000); // the first late tick just after the page is visible
    run(2000);
    // A sleep: the wall clock moves, the monotonic clock stops.
    clock.asleep += 30_000; block(30_000);
    run(2000);
    // A sleep where the monotonic clock moves too: longer than 10 minutes.
    block(11 * 60_000);
    run(2000);
    await sdk.flush();
    assert.equal(hangs(eventsOf(sent)).length, 0);
    block(5000);
    await sdk.flush();
    assert.equal(hangs(eventsOf(sent)).length, 1, 'a hang on a visible page is still found after all that');
  } finally { sdk.destroy(); }
});

test('hang detection: hangThresholdMs changes the limit, 0 turns it off; websites have none', async t => {
  const { block, run } = hangPage(t);
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const off = new Analytics(gameOptions({ persistQueue: false, hangThresholdMs: 0 }));
  try { run(1000); block(20_000); await off.flush(); assert.equal(hangs(eventsOf(sent)).length, 0, 'off'); } finally { off.destroy(); }
  const web = new Analytics({ publishableKey: 'mana_pk_web', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, app: gameApp });
  try { run(1000); block(20_000); await web.flush(); assert.equal(hangs(eventsOf(sent)).length, 0, 'website mode'); } finally { web.destroy(); }
  const low = new Analytics(gameOptions({ persistQueue: false, hangThresholdMs: 2000 }));
  try {
    run(1000); block(1800);
    run(1000); block(2500);
    await low.flush();
    assert.deepEqual(hangs(eventsOf(sent)).map(event => event.properties.hang_duration_s), [2.5]);
  } finally { low.destroy(); }
});

test('hang detection: an game_crash after a hang has its message_id in hang_message_id', async t => {
  const { block, run, local } = hangPage(t);
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const first = new Analytics(gameOptions({ persistQueue: false }));
  run(1000); block(7000);
  await first.flush();
  const [hang] = hangs(eventsOf(sent));
  assert.equal(Object.values(gameState(local))[0].hang_message_id, hang.message_id, 'saved at once');
  run(1000);
  crash(first, local);
  t.mock.timers.tick(60_000);
  sent.length = 0;
  const next = new Analytics(gameOptions({ persistQueue: false }));
  try {
    await next.flush();
    const [gameCrash] = named(eventsOf(sent), 'game_crash');
    assert.equal(gameCrash.properties.hang_message_id, hang.message_id);
    assert.equal(gameCrash.properties.previous_session_id, hang.session_id);
    // The new session has no hang: a crash of it would carry none.
    assert.equal(Object.values(gameState(local))[0].hang_message_id, undefined);
  } finally { next.destroy(); }
});

test('hang detection: with long-animation-frame entries, the script that ran longest gives the place and the stack', async t => {
  const { show } = hangPage(t);
  const original = globalThis.PerformanceObserver;
  const observers = [];
  globalThis.PerformanceObserver = class {
    static supportedEntryTypes = ['longtask', 'long-animation-frame'];
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(options) { this.options = options; }
    disconnect() { this.disconnected = true; }
    emit(entry) { this.callback({ getEntries: () => [entry] }); }
  };
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    const [observer] = observers;
    assert.equal(observer.options.type, 'long-animation-frame');
    t.mock.timers.tick(5000);
    observer.emit({ startTime: 4000, duration: 4000, scripts: [] }); // under the limit
    observer.emit({ startTime: 4500, duration: 7000, scripts: [
      { duration: 40, invoker: 'https://game.example/x.js?token=abc', sourceURL: 'https://game.example/x.js?token=abc', sourceFunctionName: '' },
      { duration: 6900, invoker: 'FrameRequestCallback', sourceURL: 'https://game.example/assets/game.js?v=3', sourceFunctionName: 'updatePhysics' },
    ] });
    show('hidden'); show('visible');
    observer.emit({ startTime: performance.now() - 200, duration: 9000, scripts: [] }); // just visible again
    await sdk.flush();
    const [hang, ...more] = hangs(eventsOf(sent));
    assert.equal(more.length, 0);
    assert.equal(hang.properties.hang_duration_s, 7);
    assert.equal(hang.properties.file, '/assets/game.js');
    assert.equal(hang.properties.function, 'updatePhysics');
    assert.equal(hang.properties.fingerprint, errorFingerprint('game_hang', '', '/assets/game.js', 'updatePhysics'));
    assert.equal(hang.properties.stack, 'at updatePhysics (/assets/game.js)\n    at https://game.example/x.js (/x.js)');
    assert.ok(!JSON.stringify(hang).includes('token'));
  } finally { sdk.destroy(); globalThis.PerformanceObserver = original; }
  assert.ok(observers[0].disconnected, 'destroy() stops the observer');
});

test('snippet: data-hang-threshold-ms sets the limit', async t => {
  const { window, document, block, run } = hangPage(t);
  document.currentScript = { dataset: { publishableKey: 'mana_pk_snippet', endpoint: 'https://collector.example', appPlatform: 'web', game: 'true', persistQueue: 'false', autoPageviews: 'false', hangThresholdMs: '0' } };
  const sent = [];
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, TextEncoder, performance, Date, setInterval, clearInterval, setTimeout, clearTimeout, fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  try {
    run(1000); block(20_000);
    await window.manalens.flush();
    assert.ok(named(eventsOf(sent.map(body => ({ body }))), 'game_open').length === 1);
    assert.equal(hangs(eventsOf(sent.map(body => ({ body })))).length, 0);
  } finally { window.manalens.destroy(); }
});

test('snippet: data-game and data-app-platform turn on game mode', async () => {
  const { window, document } = browser('https://game.example/');
  document.currentScript = { dataset: { publishableKey: 'mana_pk_snippet', endpoint: 'https://collector.example', appPlatform: 'web', game: 'true', persistQueue: 'false', autoPageviews: 'false' } };
  const sent = [];
  const code = await readFile(new URL('../dist/snippet.global.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window, document, location: globalThis.location, navigator: globalThis.navigator, crypto: webcrypto, URL, TextEncoder, setInterval: () => 1, clearInterval: () => {}, fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  await window.manalens.flush();
  assert.deepEqual(sent[0].events.map(event => event.event), ['session_start', 'game_open']);
  assert.equal(window.manalens.persist, undefined, 'data-persist-queue="false"');
  window.manalens.destroy();
});

for (const backend of ['localStorage', 'IndexedDB']) test(`persistQueue (${backend}): unsent events survive a reload and go first, in order, with the same message_id`, async t => {
  const jar = cookieJar(); const local = memoryStorage();
  const idb = backend === 'IndexedDB' ? fakeIndexedDB() : undefined;
  if (idb) globalThis.indexedDB = idb;
  try {
    browser('https://game.example/', { jar, local });
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
    const first = new Analytics(gameOptions());
    first.track('level_start', { level: 1 });
    first.track('level_complete', { level: 1 });
    await first.flush();
    await settle(first);
    const queued = first.pending.map(event => event.message_id);
    assert.equal(queued.length, 4);
    if (idb) {
      const [stores] = [...idb.dbs.values()];
      assert.equal(stores.get('events').size, 4, 'in IndexedDB');
      assert.ok(![...local.stored.keys()].some(key => key.endsWith('_queue')), 'not in localStorage');
    } else assert.equal(JSON.parse([...local.stored.entries()].find(([key]) => key.endsWith('_queue'))[1]).length, 4);
    first.destroy(); // the tab closes offline

    const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
    const second = new Analytics(gameOptions({ batchSize: 50 }));
    second.track('level_start', { level: 2 });
    await second.flush();
    const events = eventsOf(sent);
    assert.deepEqual(events.slice(0, 4).map(event => event.message_id), queued, 'replayed first, in order, same message_id');
    assert.deepEqual(tracked(events), ['session_start', 'game_open', 'level_start', 'level_complete', 'session_start', 'game_open', 'level_start']);
    await settle(second);
    if (idb) assert.equal([...idb.dbs.values()][0].get('events').size, 0, 'removed after the collector accepted the batch');
    else assert.ok(![...local.stored.keys()].some(key => key.endsWith('_queue')));
    second.destroy();
  } finally { delete globalThis.indexedDB; }
});

test('persistQueue: a stored event goes only after acceptance; a 5xx keeps it, a 400 drops it', async t => {
  const local = memoryStorage();
  browser('https://game.example/', { local });
  let status = 503;
  t.mock.method(globalThis, 'fetch', async () => response(status));
  const sdk = new Analytics(gameOptions({ autoPageviews: false, game: false, persistQueue: true }));
  const stored = () => JSON.parse([...local.stored.entries()].find(([key]) => key.endsWith('_queue'))?.[1] ?? '[]').map(entry => entry.event.event);
  try {
    sdk.track('a'); await settle(sdk);
    await sdk.flush(); await settle(sdk);
    assert.deepEqual(stored(), ['a'], 'a server error keeps the stored copy');
    status = 202; await sdk.flush(); await settle(sdk);
    assert.deepEqual(stored(), []);
    status = 400; sdk.track('b'); await sdk.flush(); await settle(sdk);
    assert.deepEqual(stored(), [], 'refused for good: dropped');
  } finally { sdk.destroy(); }
});

test('persistQueue: at most 1000 stored events, none older than 7 days; off by default outside game mode', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-10T00:00:00Z').getTime() });
  const local = memoryStorage();
  browser('https://game.example/', { local });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const probe = new Analytics(gameOptions({ game: false, persistQueue: true }));
  const key = probe.keys.firstOpen.replace(/first-open$/, 'queue');
  probe.destroy();
  const entry = (i, at) => ({ id: `id-${i}`, seq: i, event: { type: 'track', event: `e${i}`, message_id: `id-${i}`, channel: 'web', version: '0.1.0', original_timestamp: at, context: {}, properties: {} } });
  const old = Array.from({ length: 10 }, (_, i) => entry(i, '2026-01-02T00:00:00.000Z'));
  const recent = Array.from({ length: 1005 }, (_, i) => entry(100 + i, '2026-01-09T00:00:00.000Z'));
  local.setItem(key, JSON.stringify([...recent, ...old]));
  const sdk = new Analytics(gameOptions({ game: false, persistQueue: true, maxQueueSize: 512000 }));
  try {
    await sdk.flush(); await settle(sdk);
    const kept = JSON.parse(local.getItem(key));
    assert.equal(kept.length, 1000);
    assert.equal(kept[0].id, 'id-105', 'the oldest beyond 1000 are dropped');
    assert.ok(kept.every(item => item.event.original_timestamp === '2026-01-09T00:00:00.000Z'), 'events older than 7 days are dropped');
  } finally { sdk.destroy(); }

  // Without the option, and outside game mode, nothing is stored.
  const plain = new Analytics({ ...gameOptions({ game: false }) });
  plain.track('x'); await plain.flush();
  assert.equal(plain.persist, undefined);
  plain.destroy();
  const off = new Analytics(gameOptions({ persistQueue: false }));
  assert.equal(off.persist, undefined, 'persistQueue: false in game mode');
  off.destroy();
});

test('persistQueue respects consent and optOut(): nothing written without consent; stored events deleted', async t => {
  const jar = cookieJar(); const local = memoryStorage();
  browser('https://game.example/', { jar, local });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const hasQueue = () => [...local.stored.keys()].some(key => key.endsWith('_queue'));
  const sdk = new Analytics(gameOptions({ requireConsent: true }));
  try {
    sdk.track('before_consent'); await sdk.flush(); await settle(sdk);
    assert.equal(local.stored.size, 0, 'nothing written before consent');
    sdk.setConsent(true); sdk.track('after_consent'); await sdk.flush(); await settle(sdk);
    assert.ok(hasQueue());
    const stored = JSON.parse([...local.stored.entries()].find(([key]) => key.endsWith('_queue'))[1]).map(entry => entry.event.event);
    assert.ok(!stored.includes('before_consent'), 'events from before consent are not stored');
    sdk.optOut(); await settle(sdk);
    assert.ok(!hasQueue(), 'optOut() deletes the stored events');
    sdk.track('opted_out'); await settle(sdk);
    assert.ok(!hasQueue(), 'and nothing is written after it');
  } finally { sdk.destroy(); }
  // A reload while opted out reads and writes no queue.
  const reloaded = new Analytics(gameOptions());
  try { reloaded.track('x'); await reloaded.flush(); await settle(reloaded); assert.ok(!hasQueue()); } finally { reloaded.destroy(); }
});

test('errors: a 1 MB message and a 1 MB stack are cut before cleaning and parsing, and finish fast', async t => {
  const { window } = browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  const MB = 1024 * 1024;
  // Inputs that make an unbounded pattern scan the rest of the string from each position.
  const inputs = [
    'a'.repeat(MB),
    'a.'.repeat(MB / 2),
    'token="'.repeat(MB / 7),
    'eyJ'.repeat(MB / 3),
    'x'.repeat(MB - 3) + '://',
    `at ${'f ('.repeat(MB / 3)}`,
    `${'a'.repeat(MB)}@${'b'.repeat(MB)}`,
  ];
  try {
    const started = performance.now();
    for (const [i, text] of inputs.entries()) {
      const error = new Error(text);
      error.stack = `${text}\n${text}\n    at run (https://game.example/a.js:1:1)`;
      window.dispatchEvent(windowError({ message: text, filename: `https://game.example/${text}`, lineno: 1, error }));
      window.dispatchEvent(rejection(Object.assign(new Error(`r${i}${text}`), { stack: text })));
      sdk.trackError(`${i}${text}`, { errorType: `Big${i}` });
      sdk.trackError(Object.assign(new Error(`m${i}`), { stack: text }), { errorType: `Stack${i}` });
    }
    assert.ok(errorFingerprint('E', 'a'.repeat(MB), '', '').length === 16);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
    await sdk.flush(); await sdk.flush(); await sdk.flush();
    const errors = named(eventsOf(sent), 'error');
    assert.ok(errors.length > 0);
    for (const event of errors) {
      assert.ok(event.properties.message.length <= 1024);
      assert.ok((event.properties.stack ?? '').length <= 1024);
      assert.ok((event.properties.file ?? '').length <= 256);
      assert.ok(new TextEncoder().encode(JSON.stringify(event.properties)).byteLength <= 8192);
    }
  } finally { sdk.destroy(); }
});

test('errors: key and token values are redacted across a newline and up to the closing quote, also when long', async t => {
  const { window } = browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  // Spaces stop the long-token rule, so only the key-value rule can redact this.
  const secret = 'pass word '.repeat(300);
  assert.equal(secret.length, 3000);
  try {
    window.dispatchEvent(rejection('Login failed token:\n abc123'));
    window.dispatchEvent(rejection(`Bad config secret="${secret}" end`));
    window.dispatchEvent(rejection(`Unclosed password='${secret}`));
    await sdk.flush();
    const [newline, quoted, unclosed] = named(eventsOf(sent), 'error').map(event => event.properties.message);
    assert.equal(newline, 'Login failed token:\n [redacted]');
    assert.equal(quoted, 'Bad config secret="[redacted]" end');
    assert.equal(unclosed, "Unclosed password='[redacted]");
    for (const message of [quoted, unclosed]) assert.ok(!message.includes('pass word') && !message.includes('word '), 'no part of the secret is left');
  } finally { sdk.destroy(); }
});

const utf8 = text => new TextEncoder().encode(text).byteLength;
/** A fetch that records each request (exact body bytes, keepalive) and answers only when released. */
function heldFetch() {
  const requests = []; const waiting = [];
  const fetch = async (_url, init) => {
    requests.push({ bytes: utf8(init.body), keepalive: init.keepalive === true, events: JSON.parse(init.body).events });
    return new Promise(resolve => waiting.push(() => resolve(response(202))));
  };
  return { requests, fetch, release() { for (const done of waiting.splice(0)) done(); } };
}
const keepaliveBytes = requests => requests.filter(request => request.keepalive).reduce((sum, request) => sum + request.bytes, 0);
const pad = 'x'.repeat(4000);

test('keepalive size: 30 events of about 4 KB on pagehide go in bodies of at most 60000 bytes together; the rest stay queued and stored', async t => {
  const local = memoryStorage();
  const { window } = browser('https://game.example/', { local });
  const held = heldFetch(); t.mock.method(globalThis, 'fetch', held.fetch);
  // batchSize 50: the 30th event must not start a normal full-batch send before pagehide.
  const sdk = new Analytics(gameOptions({ game: false, persistQueue: true, batchSize: 50 }));
  const stored = () => JSON.parse([...local.stored.entries()].find(([key]) => key.endsWith('_queue'))?.[1] ?? '[]').map(entry => entry.event.message_id);
  try {
    for (let i = 0; i < 30; i++) sdk.track(`e${i}`, { pad });
    const all = sdk.pending.map(event => event.message_id);
    window.dispatchEvent(new Event('pagehide')); await tick();
    assert.ok(held.requests.length >= 1);
    for (const request of held.requests) { assert.equal(request.keepalive, true); assert.ok(request.bytes <= 60000, `body of ${request.bytes} bytes`); }
    assert.ok(keepaliveBytes(held.requests) <= 60000, `total ${keepaliveBytes(held.requests)} bytes`);
    const sentIds = held.requests.flatMap(request => request.events.map(event => event.message_id));
    assert.ok(sentIds.length > 0 && sentIds.length < 30, `${sentIds.length} sent`);
    assert.deepEqual(sentIds, all.slice(0, sentIds.length), 'the oldest go first, in order');
    assert.deepEqual(sdk.pending.map(event => event.message_id), all.slice(sentIds.length), 'the rest stay queued, in order');
    await settle(sdk);
    assert.deepEqual(stored(), all, 'all still stored: nothing is accepted yet');

    // The collector accepts: the sent events leave the stored queue; the rest stay stored.
    held.release(); await tick(); await settle(sdk);
    assert.deepEqual(stored(), all.slice(sentIds.length));
    // The next normal send takes the rest (not keepalive, so not limited to 64 KiB).
    const next = sdk.flush(); await tick(); held.release(); await next;
    const last = held.requests.at(-1);
    assert.equal(last.keepalive, false);
    assert.deepEqual(last.events.map(event => event.message_id), all.slice(sentIds.length));
  } finally { sdk.destroy(); }
});

test('keepalive size: visibilitychange then pagehide share the 60000 bytes in flight; a free budget sends more', async t => {
  const { window } = browser('https://example.com/');
  const held = heldFetch(); t.mock.method(globalThis, 'fetch', held.fetch);
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, batchSize: 50 });
  try {
    for (let i = 0; i < 30; i++) sdk.track(`e${i}`, { pad });
    void sdk.flush(true); await tick(); // the send of visibilitychange to hidden (the test document has no listeners)
    const first = held.requests.length;
    window.dispatchEvent(new Event('pagehide')); await tick();
    assert.equal(held.requests.length, first, 'no budget left while the first requests are in flight');
    assert.ok(keepaliveBytes(held.requests) <= 60000);
    held.release(); await tick();
    const before = sdk.pending.length;
    window.dispatchEvent(new Event('pagehide')); await tick();
    assert.ok(held.requests.length > first, 'sent once the budget is free');
    assert.ok(keepaliveBytes(held.requests.slice(first)) <= 60000);
    assert.ok(sdk.pending.length < before);
  } finally { held.release(); sdk.destroy(); }
});

test('keepalive size: one event over 60000 bytes is sent alone without keepalive; the others still go with keepalive', async t => {
  const { window } = browser('https://example.com/');
  const held = heldFetch(); t.mock.method(globalThis, 'fetch', held.fetch);
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false });
  try {
    sdk.track('big', { pad: 'y'.repeat(70000) });
    sdk.track('small');
    window.dispatchEvent(new Event('pagehide')); await tick();
    assert.equal(held.requests.length, 2);
    assert.deepEqual(held.requests.map(request => [request.events.map(event => event.event), request.keepalive]), [[['big'], false], [['small'], true]]);
    assert.ok(held.requests[0].bytes > 60000);
    assert.equal(sdk.pending.length, 0);
  } finally { held.release(); sdk.destroy(); }
});

test('shutdown(): game mode queues session_end with duration_s and sends it with a normal request, then stops', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  browser('https://game.example/');
  const sent = []; t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push({ body: JSON.parse(init.body), init }); return response(202); });
  const sdk = new Analytics(gameOptions({ persistQueue: false }));
  try {
    t.mock.timers.tick(90_000); sdk.track('level_start');
    t.mock.timers.tick(30_000);
    await sdk.shutdown();
    const events = eventsOf(sent);
    assert.deepEqual(tracked(events), ['session_start', 'game_open', 'level_start', 'session_end']);
    const end = named(events, 'session_end')[0];
    assert.equal(end.properties.duration_s, 120);
    assert.equal(end.session_id, events[0].session_id);
    assert.ok(sent.every(item => item.init.keepalive === false), 'not keepalive');
    // Stopped, like the Node SDK: later calls send nothing.
    sdk.track('after_shutdown'); await sdk.flush(); await sdk.shutdown();
    globalThis.window.dispatchEvent(new Event('pagehide')); await tick();
    assert.equal(eventsOf(sent).length, 4);
  } finally { sdk.destroy(); }
});

test('shutdown(): resolves within timeoutMs when the network hangs; the unsent events stay stored', async t => {
  const local = memoryStorage();
  browser('https://game.example/', { local });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => { requests++; return new Promise(() => {}); });
  const sdk = new Analytics(gameOptions());
  const stored = () => JSON.parse([...local.stored.entries()].find(([key]) => key.endsWith('_queue'))?.[1] ?? '[]').map(entry => entry.event.event);
  const started = Date.now();
  await sdk.shutdown(150);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 140 && elapsed < 1000, `resolved after ${elapsed} ms`);
  assert.equal(requests, 1);
  await settle(sdk);
  assert.deepEqual(stored(), ['session_start', 'game_open', 'session_end'], 'sent on the next start');
});

test('shutdown(): without game mode it only sends the queue (several batches), and the snippet instance has it', async t => {
  browser('https://example.com/');
  const sent = []; t.mock.method(globalThis, 'fetch', async (_url, init) => { sent.push({ body: JSON.parse(init.body), init }); return response(202); });
  const sdk = new Analytics({ publishableKey: 'mana_pk_key', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, batchSize: 2 });
  sdk.track('a'); sdk.track('b'); sdk.track('c');
  await sdk.shutdown();
  assert.deepEqual(sent.map(item => item.body.events.map(event => event.event)), [['a', 'b'], ['c']]);
  assert.ok(sent.every(item => item.init.keepalive === false));
  const { window, sent: snippetSent } = await runSnippet({ autoPageviews: 'false' });
  window.manalens.track('from_snippet');
  await window.manalens.shutdown();
  assert.deepEqual(eventsOf(snippetSent).map(event => event.event), ['from_snippet']);
});

// Installed-app pages (Electron app://, file://, Tauri, Capacitor): with the app
// option the SDK sends app events. The collector refuses a page URL that is not on
// the project domain, and accepts an app event (channel app, context.app, no page).
const electronApp = { platform: 'windows', storefront: 'steam', app_version: '1.4.0', build: '571', engine: 'other' };
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('app:// page with the app option: app events (channel app, context.app, no context.page) and sent_at in the body', async t => {
  const { window, jar, local } = browser('app://game/index.html?utm_source=Newsletter&email=private%40example.com');
  const session = memoryStorage();
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: session });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const warn = t.mock.method(console, 'warn', () => {});
  const sdk = new Analytics({ publishableKey: 'mana_pk_desktop', endpoint: 'https://collector.example', flushIntervalMs: 60000, app: electronApp });
  try {
    sdk.track('level_start', { level: 3 });
    await sdk.identify('player-1', { plan: 'free' });
    sdk.traits({ difficulty: 'hard' });
    await sdk.flush();
    const events = eventsOf(sent);
    // autoPageviews is on by default, but app events have no page views.
    assert.deepEqual(events.map(event => event.type), ['track', 'identify', 'traits']);
    for (const event of events) {
      assert.equal(event.channel, 'app');
      assert.deepEqual(event.context.app, electronApp);
      assert.equal(event.context.page, undefined);
      assert.equal(event.context.referrer, undefined);
      assert.equal(event.context.utm_source, undefined);
      assert.deepEqual(Object.keys(event.context).sort(), ['app', 'library_name', 'library_version', 'locale', 'utc_offset']);
      assert.equal(event.context.locale, 'en-US');
      assert.equal(event.context.library_name, 'Manalens Web SDK');
      assert.match(event.anonymous_id, uuid);
      assert.match(event.session_id, uuid);
      assert.notEqual(event.session_id, event.anonymous_id);
    }
    assert.equal(events[0].anonymous_id, events[2].anonymous_id);
    for (const item of sent) {
      assert.deepEqual(Object.keys(item.body), ['events', 'sent_at']);
      assert.match(item.body.sent_at, isoTime);
    }
    assert.ok(!JSON.stringify(sent).includes('private'));
    // No cookies on a custom scheme: identity is in localStorage, the user ID in sessionStorage.
    assert.equal(jar.writes.length, 0, 'no cookie is read or written');
    const anonymousKey = [...local.stored.keys()].find(key => key.endsWith('_anonymous-id'));
    assert.equal(local.stored.get(anonymousKey), events[0].anonymous_id);
    assert.ok([...local.stored.keys()].some(key => key.endsWith('_session-id')));
    assert.equal([...session.stored.entries()].find(([key]) => key.endsWith('_user-id'))?.[1], 'player-1');
    // The next load (a new instance) keeps the anonymous ID, the session and the user ID.
    sdk.destroy(); sent.length = 0;
    const again = new Analytics({ publishableKey: 'mana_pk_desktop', endpoint: 'https://collector.example', flushIntervalMs: 60000, app: electronApp });
    again.track('menu_open');
    await again.flush();
    const [next] = eventsOf(sent);
    assert.equal(next.anonymous_id, events[0].anonymous_id);
    assert.equal(next.session_id, events[0].session_id);
    assert.equal(next.user_id, 'player-1');
    // reset() clears the user ID from sessionStorage.
    again.reset();
    assert.equal([...session.stored.keys()].find(key => key.endsWith('_user-id')), undefined);
    again.destroy();
    assert.equal(warn.mock.callCount(), 0, 'no warning with a valid app option');
  } finally { sdk.destroy(); }
});

test('app:// page: page() sends nothing and warns once; history changes send no page views', async t => {
  browser('app://game/index.html');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const warn = t.mock.method(console, 'warn', () => {});
  const pushState = t.mock.fn();
  globalThis.history = { state: null, pushState, replaceState: t.mock.fn() };
  const sdk = new Analytics({ publishableKey: 'mana_pk_desktop', endpoint: 'https://collector.example', flushIntervalMs: 60000, app: electronApp });
  try {
    sdk.page();
    sdk.page({ screen: 'menu' });
    globalThis.window.dispatchEvent(new Event('popstate'));
    globalThis.window.dispatchEvent(new Event('manalens:navigate'));
    await new Promise(resolve => setTimeout(resolve, 20));
    sdk.track('screen_view', { screen: 'menu' });
    await sdk.flush();
    assert.deepEqual(eventsOf(sent).map(event => event.type), ['track']);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /page\(\) sends nothing on an installed-app page/);
    assert.equal(globalThis.history.pushState, pushState, 'history is not wrapped');
  } finally { sdk.destroy(); delete globalThis.history; }
});

test('file:// page with the app option: app events too, also in the pagehide keepalive send', async t => {
  const { jar } = browser('file:///C:/Games/A%20Short%20Sail/resources/app/index.html');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const sdk = new Analytics({ publishableKey: 'mana_pk_desktop', endpoint: 'https://collector.example', flushIntervalMs: 60000, app: electronApp });
  try {
    sdk.track('game_started');
    // The pagehide send (keepalive) has sent_at too.
    globalThis.window.dispatchEvent(new Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 0));
    const [event] = eventsOf(sent);
    assert.equal(event.channel, 'app');
    assert.equal(event.context.page, undefined);
    assert.ok(!JSON.stringify(sent).includes('Games'), 'no file path is sent');
    assert.match(sent[0].body.sent_at, isoTime);
    assert.equal(jar.writes.length, 0);
  } finally { sdk.destroy(); }
});

test('app:// page, game mode: session_start, game_open, error with breadcrumbs, session_end and shutdown() as app events', async t => {
  const local = memoryStorage();
  browser('app://game/index.html', { local });
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const warn = t.mock.method(console, 'warn', () => {});
  const sdk = new Analytics(gameOptions({ app: electronApp, autoPageviews: true, persistQueue: false }));
  try {
    sdk.track('level_start', { level: 1 });
    globalThis.window.dispatchEvent(windowError({ message: 'boom', error: new Error('boom') }));
    sdk.trackError('save failed');
    await sdk.flush();
    const events = eventsOf(sent);
    assert.deepEqual(tracked(events), ['session_start', 'game_open', 'level_start', 'error', 'error']);
    assert.ok(events.every(event => event.channel === 'app' && event.context.page === undefined));
    assert.ok(events.every(event => event.session_id === events[0].session_id));
    assert.equal(events[1].properties.is_first_open, true);
    assert.equal(events[3].properties.source, 'auto');
    assert.equal(events[3].properties.breadcrumbs, 'session_start,game_open,level_start');
    assert.equal(events[4].properties.source, 'manual');
    assert.match(sent[0].body.sent_at, isoTime);
    // shutdown(): session_end, sent with sent_at, as an app event.
    await sdk.shutdown();
    const [end] = named(eventsOf(sent), 'session_end');
    assert.equal(end.channel, 'app');
    assert.equal(end.session_id, events[0].session_id);
    assert.equal(typeof end.properties.duration_s, 'number');
    assert.ok(sent.every(item => isoTime.test(item.body.sent_at)));
    assert.equal(warn.mock.callCount(), 0);
    // The first open is in localStorage: the next start is not a first open.
    sent.length = 0;
    const again = new Analytics(gameOptions({ app: electronApp, persistQueue: false }));
    await again.flush();
    assert.equal(named(eventsOf(sent), 'game_open')[0].properties.is_first_open, false);
    assert.equal(named(eventsOf(sent), 'game_open')[0].channel, 'app');
    again.destroy();
  } finally { sdk.destroy(); }
});

test('app:// page, game mode: game_crash at the next load and game_hang go as app events', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T10:00:00Z').getTime() });
  const local = memoryStorage();
  const { document } = browser('app://game/index.html', { local });
  document.visibilityState = 'visible'; document.hasFocus = () => true;
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const first = new Analytics(gameOptions({ app: electronApp, persistQueue: false, hangThresholdMs: 0 }));
  await first.flush();
  const [open] = named(eventsOf(sent), 'game_open');
  assert.equal(Object.values(gameState(local)).length, 1, 'the session state is in localStorage');
  // The app is killed: no pagehide, no shutdown().
  t.mock.timers.tick(60_000);
  crash(first, local);
  sent.length = 0;
  const second = new Analytics(gameOptions({ app: electronApp, persistQueue: false, hangThresholdMs: 0 }));
  try {
    await second.flush();
    assert.deepEqual(tracked(eventsOf(sent)), ['game_crash', 'session_start', 'game_open']);
    const [gameCrash] = eventsOf(sent);
    assert.equal(gameCrash.channel, 'app');
    assert.equal(gameCrash.context.page, undefined);
    assert.equal(gameCrash.session_id, open.session_id);
    assert.equal(gameCrash.properties.previous_build, '571');
    // A hang: the same error event as on an http page, as an app event.
    second.recordHang({ durationMs: 6200, scripts: [] });
    await second.flush();
    const [hang] = hangs(eventsOf(sent));
    assert.equal(hang.channel, 'app');
    assert.equal(hang.properties.hang_duration_s, 6.2);
  } finally { second.destroy(); }
});

test('a page that is not http or https without a valid app option: one warning, and the events are sent as before', async t => {
  browser('app://game/index.html');
  const sent = []; t.mock.method(globalThis, 'fetch', collector(sent));
  const warn = t.mock.method(console, 'warn', () => {});
  const sdk = new Analytics({ publishableKey: 'mana_pk_desktop', endpoint: 'https://collector.example', flushIntervalMs: 60000 });
  try {
    sdk.track('level_start');
    await sdk.flush();
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /not http or https \(app:\).*set a valid app option/);
    const events = eventsOf(sent);
    assert.deepEqual(events.map(event => event.type), ['page', 'track']);
    assert.ok(events.every(event => event.channel === 'web' && event.context.page));
    assert.deepEqual(Object.keys(sent[0].body), ['events']);
  } finally { sdk.destroy(); }
  // An invalid app object: the app warning and the page warning.
  const invalidWarn = t.mock.method(console, 'warn', () => {});
  const invalid = new Analytics({ publishableKey: 'mana_pk_desktop', endpoint: 'https://collector.example', flushIntervalMs: 60000, autoPageviews: false, app: { platform: 'nintendo' } });
  try {
    assert.equal(invalidWarn.mock.callCount(), 2);
    assert.match(invalidWarn.mock.calls[0].arguments[0], /app option is ignored/);
    assert.match(invalidWarn.mock.calls[1].arguments[0], /not http or https/);
  } finally { invalid.destroy(); }
});

test('http and https pages are unchanged after an app page: channel web, context.page, page views, cookies, no sent_at', async t => {
  for (const url of ['https://game.example/play', 'http://localhost:5173/play']) {
    const { jar } = browser(url);
    const sent = []; const fetchMock = t.mock.method(globalThis, 'fetch', collector(sent));
    const warn = t.mock.method(console, 'warn', () => {});
    const sdk = new Analytics({ publishableKey: 'mana_pk_desktop', endpoint: 'https://collector.example', flushIntervalMs: 60000, app: electronApp });
    try {
      sdk.track('level_start');
      await sdk.flush();
      const events = eventsOf(sent);
      assert.deepEqual(events.map(event => event.type), ['page', 'track']);
      assert.ok(events.every(event => event.channel === 'web' && event.context.page.path === '/play'));
      assert.deepEqual(Object.keys(sent[0].body), ['events']);
      assert.ok(jar.find('mana_').some(cookie => cookie.name.endsWith('_anonymous-id')), 'the anonymous ID is in a cookie');
      assert.equal(warn.mock.callCount(), 0);
    } finally { sdk.destroy(); warn.mock.restore(); fetchMock.mock.restore(); }
  }
});
