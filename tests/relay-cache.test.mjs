/* The shared upstream cache in the relay. This is what turns "every visitor polls the
 * operator" into "every visitor shares one answer per window", so its rules are the point:
 * only an HTTP-200 JSON body under 512 KB is stored, never a playlist, never an operator's
 * error envelope, never a relay-level failure, and concurrent identical URLs share one fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handler, resetRelayCacheForTest, setRelayBlobStoreForTest } from '../netlify/functions/api.mjs';

// Unit requests use deterministic upstream stubs, never a real Netlify Blob context.
setRelayBlobStoreForTest(null);
resetRelayCacheForTest();

const event = (path, params) => ({ httpMethod: 'GET', headers: {}, path, queryStringParameters: params });
const fetchEvent = (url, extra) => event('/api/fetch', { url, ...extra });

/* An IP host, so the address check never needs DNS and the suite runs offline. */
const target = (name) => `https://8.8.8.8/${name}`;

function stubFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return impl(String(url), calls.length); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (body, init) => new Response(JSON.stringify(body),
  { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

test('without a window the relay fetches every time, exactly as it always did', async () => {
  const stub = stubFetch(async () => json({ ok: 1 }));
  try {
    const url = target('no-window.json');
    const a = await handler(fetchEvent(url));
    const b = await handler(fetchEvent(url));
    assert.equal(stub.calls.length, 2);
    assert.equal(a.headers['X-Cache'], 'SKIP');
    assert.equal(b.headers['X-Cache'], 'SKIP');
    assert.equal(JSON.parse(a.body).ok, 1);
  } finally { stub.restore(); }
});

test('with a window the second visitor is served the first one’s answer', async () => {
  const stub = stubFetch(async () => json({ trains: 77 }));
  try {
    const url = target('windowed.json');
    const a = await handler(fetchEvent(url, { window: '600' }));
    const b = await handler(fetchEvent(url, { window: '600' }));
    assert.equal(stub.calls.length, 1, 'one upstream request for two visitors');
    assert.equal(a.headers['X-Cache'], 'MISS');
    assert.equal(b.headers['X-Cache'], 'HIT');
    assert.equal(b.body, a.body);
    assert.equal(JSON.parse(b.body).trains, 77);
  } finally { stub.restore(); }
});

test('a window shorter than the cached age goes upstream again', async () => {
  const stub = stubFetch(async () => json({ n: 1 }));
  try {
    const url = target('short-window.json');
    await handler(fetchEvent(url, { window: '600' }));
    // A caller that only tolerates a 0-second-old answer must not be handed a cached one,
    // and window=0 means "no caching at all".
    const fresh = await handler(fetchEvent(url, { window: '0' }));
    assert.equal(fresh.headers['X-Cache'], 'SKIP');
    assert.equal(stub.calls.length, 2);
  } finally { stub.restore(); }
});

test('concurrent identical requests share one upstream fetch', async () => {
  let resolveUpstream;
  const stub = stubFetch(() => new Promise((resolve) => { resolveUpstream = resolve; }));
  try {
    const url = target('single-flight.json');
    const pending = Promise.all([
      handler(fetchEvent(url, { window: '600' })),
      handler(fetchEvent(url, { window: '600' })),
      handler(fetchEvent(url, { window: '600' })),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(stub.calls.length, 1, 'three tabs, one request');
    resolveUpstream(json({ shared: true }));
    const results = await pending;
    assert.ok(results.every((r) => JSON.parse(r.body).shared === true));
  } finally { stub.restore(); }
});

test('an operator’s error envelope is never pinned for the whole window', async () => {
  let n = 0;
  const stub = stubFetch(async () => {
    n++;
    return n === 1 ? json({ errorMessage: { code: 'INFO-300', message: 'limit' } }) : json({ trains: 77 });
  });
  try {
    const url = target('capped-key.json');
    const capped = await handler(fetchEvent(url, { window: '600' }));
    assert.match(capped.body, /INFO-300/);
    // The key is shared and resets on its own schedule: the next visitor must get a fresh
    // attempt rather than the cached refusal.
    const recovered = await handler(fetchEvent(url, { window: '600' }));
    assert.equal(stub.calls.length, 2, 'the refusal was not cached');
    assert.equal(JSON.parse(recovered.body).trains, 77);
  } finally { stub.restore(); }
});

test('a relay-level failure and a non-JSON body are never cached', async () => {
  let n = 0;
  const stub = stubFetch(async () => {
    n++;
    if (n === 1) return new Response('{"error":"source returned HTTP 502"}', { status: 502,
      headers: { 'Content-Type': 'application/json' } });
    return json({ ok: true });
  });
  try {
    const url = target('failing.json');
    const failed = await handler(fetchEvent(url, { window: '600' }));
    assert.equal(failed.statusCode, 502);
    const retried = await handler(fetchEvent(url, { window: '600' }));
    assert.equal(stub.calls.length, 2, 'a failure is not an answer');
    assert.equal(JSON.parse(retried.body).ok, true);
  } finally { stub.restore(); }

  const bin = stubFetch(async () => new Response(Buffer.from([1, 2, 3]),
    { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
  try {
    const url = target('binary.bin');
    const a = await handler(fetchEvent(url, { window: '600' }));
    await handler(fetchEvent(url, { window: '600' }));
    assert.equal(bin.calls.length, 2, 'only JSON is cached');
    assert.equal(a.headers['X-Cache'], 'MISS');
  } finally { bin.restore(); }
});

test('a playlist is rewritten, never cached, and a huge body is refused entry to the cache', async () => {
  const playlist = stubFetch(async () => new Response('#EXTM3U\n#EXTINF:2,\nseg-1.ts\n',
    { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
  try {
    const url = target('stream.m3u8');
    const a = await handler(fetchEvent(url, { window: '600' }));
    await handler(fetchEvent(url, { window: '600' }));
    assert.equal(playlist.calls.length, 2);
    assert.match(a.body, /\/api\/proxy\?url=/);
    assert.equal(a.headers['X-Cache'], 'SKIP');
  } finally { playlist.restore(); }

  const huge = stubFetch(async () => new Response(JSON.stringify({ blob: 'x'.repeat(600 * 1024) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }));
  try {
    const url = target('huge.json');
    await handler(fetchEvent(url, { window: '600' }));
    await handler(fetchEvent(url, { window: '600' }));
    assert.equal(huge.calls.length, 2, 'a 600 KB body stays out of a 512 KB cache');
  } finally { huge.restore(); }
});

test('a binary feed is returned base64 so a protobuf survives the trip', async () => {
  const stub = stubFetch(async () => new Response(Buffer.from([0x0a, 0x02, 0x08, 0x01]),
    { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } }));
  try {
    const url = target('vehiclepositions.pb');
    const r = await handler(fetchEvent(url, { encoding: 'base64' }));
    assert.equal(r.statusCode, 200);
    assert.equal(r.isBase64Encoded, true);
    assert.equal(r.body, Buffer.from([0x0a, 0x02, 0x08, 0x01]).toString('base64'));
    assert.equal(stub.calls.length, 1);
    // binary responses are not cached: the point of the cache is shared JSON answers
    await handler(fetchEvent(url, { encoding: 'base64', window: '600' }));
    assert.equal(stub.calls.length, 2);
  } finally { stub.restore(); }
});

test('the window is clamped and a bad url is still refused before anything is fetched', async () => {
  const stub = stubFetch(async () => json({ ok: 1 }));
  try {
    const url = target('clamped.json');
    await handler(fetchEvent(url, { window: '999999' }));
    assert.equal(stub.calls.length, 1);
    // 15 minutes is the longest anybody can pin an answer for
    const again = await handler(fetchEvent(url, { window: '900' }));
    assert.equal(again.headers['X-Cache'], 'HIT');
  } finally { stub.restore(); }

  const bad = await handler(fetchEvent('http://127.0.0.1/latest/meta-data', { window: '600' }));
  assert.equal(bad.statusCode, 400);
  const missing = await handler(fetchEvent('', { window: '600' }));
  assert.equal(JSON.parse(missing.body).relay, true);
});


test('a verified operator JSON answer survives an instance reset through the Blob tier', async () => {
  const entries = new Map();
  const store = {
    reads: 0, writes: 0,
    async get(key) { this.reads++; return entries.get(key) || null; },
    async setJSON(key, value) { this.writes++; entries.set(key, value); },
  };
  const stub = stubFetch(async () => json({ trains: 77 }));
  try {
    setRelayBlobStoreForTest(store);
    resetRelayCacheForTest();
    const url = 'https://api-v3.mbta.com/vehicles?page[limit]=1';
    const first = await handler(fetchEvent(url, { window: '600' }));
    assert.equal(first.headers['X-Cache'], 'MISS');
    assert.equal(store.writes, 1, 'only a verified JSON body reaches Blob storage');

    // Simulate the next request landing in another cold Netlify instance.
    resetRelayCacheForTest();
    const second = await handler(fetchEvent(url, { window: '600' }));
    assert.equal(stub.calls.length, 1, 'the cold instance did not spend the operator again');
    assert.equal(second.headers['X-Cache'], 'HIT');
    assert.equal(second.headers['X-Cache-Tier'], 'blob');
    assert.equal(JSON.parse(second.body).trains, 77);
  } finally {
    stub.restore();
    setRelayBlobStoreForTest(null);
    resetRelayCacheForTest();
  }
});

test('Blob outages and bad cached envelopes fail open to the upstream, never become an answer', async () => {
  const url = 'https://api-v3.mbta.com/vehicles?page[limit]=bad-cache';
  const badStore = {
    async get() { return { at: Date.now(), body: JSON.stringify({ errorMessage: { code: 'INFO-300' } }), ctype: 'application/json' }; },
    async setJSON() { throw new Error('blob unavailable'); },
  };
  const stub = stubFetch(async () => json({ recovered: true }));
  try {
    setRelayBlobStoreForTest(badStore);
    resetRelayCacheForTest();
    const response = await handler(fetchEvent(url, { window: '600' }));
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['X-Cache'], 'MISS');
    assert.equal(JSON.parse(response.body).recovered, true);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
    setRelayBlobStoreForTest(null);
    resetRelayCacheForTest();
  }
});
