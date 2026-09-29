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

for (const [key, network] of [['gclid','google'],['gbraid','google'],['wbraid','google'],['fbclid','meta'],['msclkid','microsoft'],['ttclid','tiktok'],['twclid','twitter'],['li_fat_id','linkedin'],['rdt_cid','reddit'],['ScCid','snapchat']]) test(`captures ${key} and carries it across route changes without storage`, async t => {
  const {window}=browser(`https://example.com/?${key}=ad-token&utm_source=${network}&utm_campaign=launch`); const sent=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true};});
  const sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',flushIntervalMs:60000});
  try { globalThis.location=new URL('https://example.com/checkout?email=private');window.dispatchEvent(new Event('popstate'));sdk.track('purchase',{revenue:120});await sdk.identify('customer');await sdk.flush();
    const events=sent.flatMap(x=>x.events||[]); assert.equal(events.length,3);
    for(const event of events){assert.equal(event.context[key],'ad-token');assert.equal(event.context.click_id,'ad-token');assert.equal(event.context.paid_source,network);assert.equal(event.context.utm_campaign,'launch');assert.ok(!JSON.stringify(event.context).includes('private'));}
    assert.equal(sent.find(x=>x.user_id)?.context[key],'ad-token');
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

function identityStorage(window, stored = new Map()) {
  const calls = [];
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem(key) { calls.push('read'); return stored.get(key) || null; },
    setItem(key, value) { calls.push('write'); stored.set(key,value); },
    removeItem(key) { calls.push('remove'); stored.delete(key); },
  } });
  return { stored, calls };
}
for (const [consent,project] of [[false,true],[true,false]]) test(`persistent storage requires consent=${consent} and project=${project}`,async t=>{
  const {window}=browser('https://example.com/');const storage=identityStorage(window),sent=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>url.endsWith('/config')?{ok:true,json:async()=>({attribution_enabled:project})}:(sent.push(JSON.parse(init.body)),{ok:true}));
  const sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',attribution:{consent:()=>consent},flushIntervalMs:60000});
  try{await sdk.ready;await sdk.flush();assert.equal(storage.calls.length,0);assert.equal(sent[0].events[0].anonymous_id,undefined);}finally{sdk.destroy();}
});
test('consented browser identity survives reload, is key scoped, and expires',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2025-06-01').getTime()});const stored=new Map(),sent=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>url.endsWith('/config')?{ok:true,json:async()=>({attribution_enabled:true})}:(sent.push(JSON.parse(init.body)),{ok:true}));
  const make=async(key='key')=>{const {window}=browser('https://example.com/');identityStorage(window,stored);const sdk=new Analytics({writeKey:key,endpoint:'https://collector.example',attribution:{consent:()=>true},flushIntervalMs:60000});await sdk.ready;await sdk.flush();return sdk;};
  let sdk=await make();const first=sent.at(-1).events[0].anonymous_id;assert.match(first,/^[a-f0-9-]{36}$/);sdk.destroy();
  sdk=await make();assert.equal(sent.at(-1).events[0].anonymous_id,first);sdk.destroy();sdk=await make('other');assert.notEqual(sent.at(-1).events[0].anonymous_id,first);sdk.destroy();
  t.mock.timers.tick(91*86400000);sdk=await make();assert.notEqual(sent.at(-1).events[0].anonymous_id,first);sdk.destroy();
});
test('consent revocation removes storage and queued identity, without silently restoring it',async t=>{
  const {window}=browser('https://example.com/');const storage=identityStorage(window),sent=[];let consent=true;
  t.mock.method(globalThis,'fetch',async(url,init)=>url.endsWith('/config')?{ok:true,json:async()=>({attribution_enabled:true})}:(sent.push(JSON.parse(init.body)),{ok:true}));
  const sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',attribution:{consent:()=>consent},flushIntervalMs:60000});
  try{await sdk.ready;sdk.track('signup');consent=false;await sdk.flush();assert.equal(storage.stored.size,0);assert.ok(sent[0].events.every(event=>!event.anonymous_id));assert.ok(sent[0].events.every(event=>event.attribution_consent===undefined));sdk.track('next');await sdk.flush();assert.equal(sent[1].events[0].anonymous_id,undefined);}finally{sdk.destroy();}
});
test('explicit identify carries consented anonymous ID and logout rotates it',async t=>{
  const {window}=browser('https://example.com/');identityStorage(window);const sent=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>url.endsWith('/config')?{ok:true,json:async()=>({attribution_enabled:true})}:(sent.push({url,body:JSON.parse(init.body)}),{ok:true}));
  const sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',attribution:{consent:()=>true},flushIntervalMs:60000});
  try{await sdk.ready;await sdk.identify('alice',{email:'alice@acme.com'});const first=sent.find(x=>x.url.endsWith('/identify')).body;assert.ok(first.anonymous_id);assert.equal(first.attribution_consent,true);sdk.clearUserId();await sdk.setConsent(true);sdk.track('after_logout');await sdk.flush();const after=sent.at(-1).body.events[0];assert.notEqual(after.anonymous_id,first.anonymous_id);assert.equal(after.user_id,undefined);}finally{sdk.destroy();}
});
test('blocked storage falls back to daily identity without breaking collection',async t=>{
  const {window}=browser('https://example.com/');Object.defineProperty(window,'localStorage',{get(){throw Error('blocked');}});const sent=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>url.endsWith('/config')?{ok:true,json:async()=>({attribution_enabled:true})}:(sent.push(JSON.parse(init.body)),{ok:true}));
  const sdk=new Analytics({writeKey:'key',endpoint:'https://collector.example',attribution:{consent:()=>true},flushIntervalMs:60000});try{await sdk.ready;await sdk.flush();assert.equal(sent[0].events[0].anonymous_id,undefined);}finally{sdk.destroy();}
});
