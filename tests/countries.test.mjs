import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const src = readFileSync(new URL('../js/countries.js', import.meta.url), 'utf8');
const Countries = runInNewContext(src + '\nCountries;', {});

test('fmtValue keeps figures honest and compact', () => {
  assert.equal(Countries.fmtValue(3956067115771), '3.96 T');
  assert.equal(Countries.fmtValue(1430000000), '1.4 B');
  assert.equal(Countries.fmtValue(8234567), '8.2 M');
  assert.equal(Countries.fmtValue(12345), '12.3 k');
  assert.equal(Countries.fmtValue(4.567), '4.57');
  assert.equal(Countries.fmtValue(null), 'no data');
  assert.equal(Countries.fmtValue(NaN), 'no data');
});

test('featureCollection maps the build output to GeoJSON features', () => {
  const fc = Countries.featureCollection({ countries: [
    { name: 'Testland', iso2: 'TT', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    { name: 'NoISO', iso2: null, geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } },
  ] });
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 2);
  assert.equal(fc.features[0].properties.iso2, 'TT');
  assert.equal(fc.features[1].properties.iso2, '');
  assert.deepEqual(fc.features[0].geometry.type, 'Polygon');
});

test('indicatorRows exposes name/value/date per indicator', () => {
  const rows = Countries.indicatorRows({
    indicators: [
      { id: 'SP.POP.TOTL', name: 'Population', value: 1430000000, date: '2024' },
      { id: 'X.Y', value: null },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].value, 1430000000);
  assert.equal(rows[1].value, null);
});

test('relay routes + UI wiring exist in both runtimes', () => {
  const server = readFileSync(new URL('../server.py', import.meta.url), 'utf8');
  assert.match(server, /path == "\/api\/worldbank"/);
  assert.match(server, /def do_worldbank/);
  const fn = readFileSync(new URL('../netlify/functions/api.mjs', import.meta.url), 'utf8');
  assert.match(fn, /path\.includes\('\/worldbank'\)/);
  assert.match(fn, /async function worldbankRoute/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="btn-countries"/);
  assert.match(html, /id="countries-modal"/);
  assert.match(html, /data-do="#btn-countries"/);
  assert.match(html, /js\/countries\.js/);
});
