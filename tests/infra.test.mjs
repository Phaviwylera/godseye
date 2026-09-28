import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const infraSrc = readFileSync(new URL('../js/infra.js', import.meta.url), 'utf8');
const Infra = runInNewContext(infraSrc + '\nInfra;', {});

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const straits = JSON.parse(readFileSync(new URL('../data/straits.json', import.meta.url), 'utf8'));

test('powerFeatures keeps valid rows and drops malformed ones', () => {
  const feats = Infra.powerFeatures([
    [13.4, 48.2, 'Solar Plant A', 'solar'],
    ['x', 1, 'Bad', 'gas'],
    [0, 95, 'Out of range', 'gas'],
    [1, 2, 'No kind', ''],
  ]);
  assert.equal(feats.length, 2);
  assert.equal(feats[0].properties.kind, 'solar');
  assert.equal(feats[1].properties.kind, 'other');
  // Element-wise: deepEqual on vm-context arrays fails on prototype identity.
  assert.equal(feats[0].geometry.coordinates[0], 13.4);
  assert.equal(feats[0].geometry.coordinates[1], 48.2);
});

test('portFeatures keeps valid rows and drops malformed ones', () => {
  const feats = Infra.portFeatures([
    [-0.1, 51.5, 'Test Harbour'],
    [-0.2, 'bad'],
  ]);
  assert.equal(feats.length, 1);
  assert.equal(feats[0].properties.name, 'Test Harbour');
});

test('fmtCount renders human counts', () => {
  assert.equal(Infra.fmtCount(426), '426');
  assert.equal(Infra.fmtCount(3400), '3.4k');
  assert.equal(Infra.fmtCount(34936), '35k');
});

test('chipText reports pending datasets honestly', () => {
  const s = Infra._state;
  s.power = Array(3400); s.ports = Array(1081); s.cables = Array(426);
  s.pending = { power: false, ports: false, cables: false };
  assert.equal(Infra.chipText(), '⬡ 3.4k PWR · 1.1k PORTS · 426 CABLES');
  s.pending.cables = true; s.cables = [];
  assert.equal(Infra.chipText(), '⬡ 3.4k PWR · 1.1k PORTS · CABLES · PENDING');
  s.pending = { power: false, ports: false, cables: false };
});

test('cards escape names and cite the source with its vintage', () => {
  assert.ok(!Infra.powerCard({ name: '<img>', kind: 'solar' }).includes('<img>'));
  assert.ok(Infra.cableCard({ properties: { name: 'Atlantic-1', length: '6,500 km', rfs: '2019' } })
    .includes('2019 vintage'));
  assert.ok(Infra.portCard({ name: 'Test Harbour' }).includes('OpenStreetMap'));
});

test('the INFRA control, chip, scripts and straits data exist in the UI', () => {
  assert.match(html, /id="btn-infra"/);
  assert.match(html, /id="infra-chip"/);
  assert.match(html, /js\/infra\.js/);
  assert.match(html, /js\/ofac\.js/);
  assert.match(html, /data-do="#btn-infra"/);
  assert.ok(Array.isArray(straits.waterways) && straits.waterways.length >= 8);
  for (const w of straits.waterways) {
    assert.ok(w.name && Number.isFinite(w.lon) && Number.isFinite(w.lat));
    assert.ok(Math.abs(w.lon) <= 180 && Math.abs(w.lat) <= 90);
  }
  const names = straits.waterways.map(w => w.name.toLowerCase());
  for (const expected of ['strait of malacca', 'strait of hormuz', 'suez canal', 'panama canal', 'strait of gibraltar']) {
    assert.ok(names.includes(expected), 'missing strait: ' + expected);
  }
});
