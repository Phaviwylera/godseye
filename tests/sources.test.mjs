import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('Singapore current frames resolve for bundled and synced camera IDs', async () => {
  const payload = { items: [{ cameras: [
    { camera_id: '2704', image: 'https://images.data.gov.sg/current-2704.jpg' },
  ] }] };
  const context = { fetch: async () => ({ ok: true, json: async () => payload }) };
  const source = readFileSync(new URL('../js/sources.js', import.meta.url), 'utf8');
  const Sources = runInNewContext(source + '\nSources;', context);
  assert.equal(await Sources.singaporeFrame('sg-singapore-traffic-camera-2704-816783'), payload.items[0].cameras[0].image);
  assert.equal(await Sources.singaporeFrame('sg-2704'), payload.items[0].cameras[0].image);
  assert.equal(await Sources.singaporeFrame('sg-9999'), null);
});
