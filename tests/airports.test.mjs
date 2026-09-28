/* AIRPORTS layer — UI contract and tier filtering.
 *
 * The layer's honest contract: every aerodrome type is drawn, tiered in by zoom (never
 * sampled away), static data is labelled as static, and the registry module can parse the
 * compact positional format tools/build_airports.py writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const doc = JSON.parse(readFileSync(new URL('../data/airports.json', import.meta.url), 'utf8'));

const stub = {
  generated: 'test', count: 4,
  records: [
    [-73.7781, 40.6413, 'l', 'JFK', 'John F Kennedy International', 'New York', 'US'],
    [9.9882, 53.6304, 'm', 'HAM', 'Hamburg Helmut Schmidt', 'Hamburg', 'DE'],
    [77.0417, 28.5685, 's', 'SAF', 'Safdarjung Airport', 'New Delhi', 'IN'],
    [13.4, 52.5, 'h', 'HELI', 'Rooftop Helipad', 'Berlin', 'DE'],
  ],
};
const Airports = runInNewContext(
  readFileSync(new URL('../js/airports.js', import.meta.url), 'utf8') + '\nAirports;',
  { fetch: async () => ({ ok: true, json: async () => stub }), document: { getElementById: () => null }, console });

test('the AIRPORTS control, chip and module are wired into the app shell', () => {
  assert.match(html, /id="btn-airports"/);
  assert.match(html, /id="airport-chip"/);
  assert.match(html, /js\/airports\.js/);
  assert.match(html, /data-do="#btn-airports"/, 'the FAB sheet must reach it on mobile too');
  assert.match(appJs, /Airports\.init\(map\)/);
  assert.match(appJs, /Airports\.restore\(\)/);
  assert.match(appJs, /\$\("#btn-airports"\)\.onclick/);
  assert.match(appJs, /\$\("#airport-chip"\)\.onclick/);
});

test('the bundled registry is substantial, typed and positional', () => {
  assert.ok(doc.count >= 60000, `the registry must be the whole world, not a sample: ${doc.count}`);
  assert.equal(doc.count, doc.records.length);
  assert.deepEqual(doc.skipped.bad, 0, 'upstream coordinate errors must not reach the client');
  assert.equal(doc.source.license, 'public domain');
  for (const kind of Object.keys(doc.types)) assert.match(kind, /^[lmshwb]$/);
  for (const r of doc.records.slice(0, 500)) {
    assert.ok(Math.abs(r[0]) <= 180 && Math.abs(r[1]) <= 90, `out of range: ${r}`);
    assert.ok(r[3] || r[4], 'a point needs a code or a name');
  }
  const large = doc.records.filter((r) => r[2] === 'l');
  assert.ok(large.length >= 1000, 'large aerodromes are the backbone tier');
  assert.ok(doc.records.findIndex((r) => r[2] === 'l') < doc.records.findIndex((r) => r[2] === 's'),
    'large airports sort ahead of small ones');
  assert.ok(!doc.records.some((r) => r[2] === 'closed'), 'closed airfields never map');
});

test('tier filtering keeps every type but reveals them at their own zoom', async () => {
  const loaded = await Airports.load();
  assert.equal(loaded.count, 4);
  assert.equal(Airports.featuresFor(['l', 'm']).features.length, 2);
  assert.equal(Airports.featuresFor(['s']).features.length, 1);
  assert.equal(Airports.featuresFor(['h', 'w', 'b']).features.length, 1);
  const zooms = Airports.TIERS.map((t) => t.minzoom);
  assert.ok(zooms[0] === 0 && zooms[1] > zooms[0] && zooms[2] > zooms[1],
    'large first, small at regional zoom, helipads last');
  const jfk = Airports.featuresFor(['l']).features[0];
  assert.equal(jfk.properties.code, 'JFK');
  assert.equal(jfk.properties.type, 'large airport');
});

test('the builder and the layer agree on the compact record layout', () => {
  assert.equal(doc.records[0].length, 7, '[lon, lat, type, code, name, municipality, country]');
  for (const tier of Airports.TIERS) {
    for (const kind of tier.kinds) assert.ok(Object.prototype.hasOwnProperty.call(doc.types, kind), `unknown tier kind ${kind}`);
  }
});
