import test from 'node:test';
import assert from 'node:assert/strict';
import { handler, publicIP, resetOpenSkyAuthForTest, upstreamHeadersForTest } from '../netlify/functions/api.mjs';

test('relay rejects private and special network ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.2', '192.168.1.1',
    '169.254.169.254', '100.64.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1']) {
    assert.equal(publicIP(ip), false, ip);
  }
  assert.equal(publicIP('8.8.8.8'), true);
  assert.equal(publicIP('2606:4700:4700::1111'), true);
});

test('relay rejects direct private targets before fetching', async () => {
  const event = { httpMethod: 'GET', headers: {}, path: '/api/proxy',
    queryStringParameters: { url: 'http://127.0.0.1/latest/meta-data' } };
  assert.equal((await handler(event)).statusCode, 400);
});

test('relay preserves failed source status and blocks a redirect into a private network', async () => {
  const originalFetch = globalThis.fetch;
  const event = { httpMethod: 'GET', headers: {}, path: '/api/proxy',
    queryStringParameters: { url: 'https://8.8.8.8/camera.m3u8' } };
  try {
    globalThis.fetch = async () => new Response('missing', { status: 404 });
    assert.equal((await handler(event)).statusCode, 404);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
    };
    assert.equal((await handler(event)).statusCode, 400);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});


test('OpenSky OAuth credentials stay in the Function and are attached only to OpenSky', async () => {
  const originalFetch = globalThis.fetch;
  const oldId = process.env.OPENSKY_CLIENT_ID;
  const oldSecret = process.env.OPENSKY_CLIENT_SECRET;
  const calls = [];
  try {
    process.env.OPENSKY_CLIENT_ID = 'client-id';
    process.env.OPENSKY_CLIENT_SECRET = 'client-secret';
    resetOpenSkyAuthForTest();
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ access_token: 'private-token', expires_in: 300 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const openSky = await upstreamHeadersForTest('https://opensky-network.org/api/states/all');
    const other = await upstreamHeadersForTest('https://api-v3.mbta.com/vehicles');
    assert.equal(openSky.Authorization, 'Bearer private-token');
    assert.equal(other.Authorization, undefined, 'credentials must never leak to another operator');
    assert.equal(calls.length, 1, 'one cached OAuth token backs the request');
    assert.match(calls[0].url, /auth\.opensky-network\.org/);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldId === undefined) delete process.env.OPENSKY_CLIENT_ID; else process.env.OPENSKY_CLIENT_ID = oldId;
    if (oldSecret === undefined) delete process.env.OPENSKY_CLIENT_SECRET; else process.env.OPENSKY_CLIENT_SECRET = oldSecret;
    resetOpenSkyAuthForTest();
  }
});
