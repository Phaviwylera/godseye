import test from 'node:test';
import assert from 'node:assert/strict';
import { handler, publicIP } from '../netlify/functions/api.mjs';

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
