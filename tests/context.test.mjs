/* POINT CONTEXT: the panel may only show what the public feeds reported.
 * These tests pin the distance contract, radius filtering, the honest empty
 * states and the shell wiring, without a browser or a network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/context.js', import.meta.url), 'utf8');
const Context = runInNewContext(source + '\nContext;', {});
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const intel = readFileSync(new URL('../js/intel.js', import.meta.url), 'utf8');

const inRealm = (value) => JSON.parse(JSON.stringify(value));

test('distance is geodesic and refuses missing coordinates', () => {
  // London Heathrow to Paris CDG is about 348 km great-circle.
  const km = Context.haversineKm(51.47, -0.45, 49.01, 2.55);
  assert.ok(km > 330 && km < 360, `expected ~348 km, got ${km}`);
  assert.equal(Context.haversineKm(10, 10, 10, 10), 0);
  assert.equal(Context.haversineKm(NaN, 10, 10, 10), Infinity);
  assert.equal(Context.fmtKm(0.42), '420 m');
  assert.equal(Context.fmtKm(4.24), '4.2 km');
  assert.equal(Context.fmtKm(42.4), '42 km');
  assert.equal(Context.fmtKm(Infinity), '?');
});

test('nearby filters by radius, sorts by distance, ignores bad rows', () => {
  const rows = [
    { label: 'far', lat: 0, lon: 0.6 },
    { label: 'near', lat: 0, lon: 0.1 },
    { label: 'bad', lat: 'x', lon: 0 },
    { label: 'outside', lat: 0, lon: 9 },
    { label: 'middle', lat: 0, lon: 0.4 },
  ];
  const out = inRealm(Context.nearby(rows, 0, 0, 100));
  assert.deepEqual(out.map((r) => r.label), ['near', 'middle', 'far']);
  assert.ok(out[0].km < out[1].km && out[1].km < out[2].km);
  assert.equal(Context.nearby(rows, 0, 0, 100, 2).length, 2);
  assert.equal(Context.countInside(rows, 0, 0, 100), 3);
  // A zero radius keeps only an exact hit, not the nearest row.
  assert.deepEqual(inRealm(Context.nearby(rows, 0, 0, 0)), []);
});

test('scan groups every source and reports honest totals', () => {
  const groups = inRealm(Context.scan(0, 0, 100, {
    cameras: [{ label: 'cam A', lat: 0.1, lon: 0 }, { label: 'cam B', lat: 5, lon: 0 }],
    hazards: [{ label: 'flood', lat: 0.2, lon: 0 }],
    aircraft: [{ label: 'ABC123', lat: 0.3, lon: 0 }],
    layers: { air: true, hazards: true },
    airport: { code: 'XXX', name: 'Test Field', km: 12 },
  }));
  assert.deepEqual(groups.cameras.map((c) => c.label), ['cam A']);
  assert.equal(groups.camerasTotal, 1);
  assert.equal(groups.hazards.length, 1);
  assert.equal(groups.aircraft.length, 1);
  assert.equal(groups.vessels.length, 0);
  assert.deepEqual(groups.layers, { air: true, hazards: true });
  assert.equal(groups.airport.code, 'XXX');
});

test('the plain-text brief names its sources and degrades honestly', () => {
  const groups = inRealm(Context.scan(28.6, 77.2, 25, {
    cameras: [{ id: 'c1', label: 'Ring Road', detail: 'Delhi · IN', lat: 28.61, lon: 77.21 }],
    layers: { air: false, ships: false },
  }));
  const text = Context.plainText(groups, 28.6, 77.2, 25, Date.UTC(2026, 9, 26, 12, 0, 0));
  assert.match(text, /GOD'S EYE . AREA CONTEXT/);
  assert.match(text, /28\.6000, 77\.2000 . radius 25 km/);
  assert.match(text, /PUBLIC CAMERAS \(1\)/);
  assert.match(text, /Ring Road/);
  assert.match(text, /generated 2026-10-26T12:00:00Z/);
  assert.match(text, /not necessarily aimed at this point/);
  assert.doesNotMatch(text, /undefined/);
  // A brief with no events does not invent a section.
  assert.doesNotMatch(text, /ACTIVE HAZARDS/);
});

test('the context button escapes publisher text and rejects bad points', () => {
  const htmlOut = Context.buttonHTML(12.5, -1.25, 'A "quoted" <name>');
  assert.match(htmlOut, /data-ctx-lat="12\.5"/);
  assert.match(htmlOut, /data-ctx-lon="-1\.25"/);
  assert.match(htmlOut, /&quot;quoted&quot;/);
  assert.match(htmlOut, /&lt;name&gt;/);
  assert.equal(Context.buttonHTML(NaN, 1, 'x'), '');
  assert.deepEqual(inRealm(Context.RADII), [25, 100, 250]);
  assert.equal(Context.DEFAULT_RADIUS, 100);
});

test('the shell loads the panel and every report card can open it', () => {
  assert.match(html, /id="context-modal"/);
  assert.match(html, /id="context-body"/);
  assert.match(html, /data-ctx-radius="25"/);
  assert.match(html, /id="btn-context-scan"/);
  assert.match(html, /js\/context\.js/);
  assert.match(app, /Context\.init\(map\)/);
  for (const file of ['hazards.js', 'events.js', 'conflict.js', 'news.js']) {
    const card = readFileSync(new URL('../js/' + file, import.meta.url), 'utf8');
    assert.match(card, /Context\.buttonHTML\(/, file + ' must offer area context');
  }
  assert.match(intel, /Context\.buttonHTML\(/);
  assert.match(intel, /state\.quakeFeatures = data\.features/);
});
