/* NOAA SWPC is the source of truth for both the aurora grid and the Kp index.
 * These tests pin the sampling (real grid nodes only), the publication
 * ordering of Kp rows, and the storm-scale labels.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/spacewx.js', import.meta.url), 'utf8');
const SpaceWx = runInNewContext(source + '\nSpaceWx;', {});
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

const inRealm = (value) => JSON.parse(JSON.stringify(value));

test('OVATION sampling keeps publisher values at real grid nodes', () => {
  const doc = {
    'Observation Time': '2026-10-26T08:54:00Z',
    'Forecast Time': '2026-10-26T10:17:00Z',
    coordinates: [
      [0, 60, 12],       // kept
      [2, 60, 30],       // kept
      [1, 60, 99],       // off the 2-degree grid
      [270, 70, 44],     // kept, converted to -90
      [0, 60, 0],        // zero is not aurora
      [0, 60, 101],      // outside the probability scale
      [0, 91, 20],       // outside latitude
      [-1, 60, 20],      // outside longitude
      [null, 60, 20],    // Number(null) must not become 0
      [4, 60, 20],
    ],
  };
  const points = SpaceWx.sampleOvation(doc, 2);
  assert.deepEqual(inRealm(points), [
    { lon: 0, lat: 60, value: 12 },
    { lon: 2, lat: 60, value: 30 },
    { lon: -90, lat: 70, value: 44 },
    { lon: 4, lat: 60, value: 20 },
  ]);
});

test('OVATION sampling tolerates empty and malformed documents', () => {
  assert.deepEqual(inRealm(SpaceWx.sampleOvation(null)), []);
  assert.deepEqual(inRealm(SpaceWx.sampleOvation({})), []);
  assert.deepEqual(inRealm(SpaceWx.sampleOvation({ coordinates: [null, [], ['x', 'y', 'z']] })), []);
});

test('Kp rows resolve to the latest publication, not the last in the array', () => {
  const latest = SpaceWx.normalizeKp([
    { time_tag: '2026-10-26T06:00:00', Kp: 2.33, a_running: 7, station_count: 8 },
    { time_tag: '2026-10-26T09:00:00', Kp: 5.67, a_running: 48, station_count: 8 },
    { time_tag: '2026-10-26T03:00:00', Kp: 1.00, a_running: 3, station_count: 8 },
  ]);
  assert.equal(latest.time, '2026-10-26T09:00:00');
  assert.equal(latest.kp, 5.67);
  assert.equal(latest.aRunning, 48);
  assert.equal(latest.stations, 8);
  assert.equal(SpaceWx.normalizeKp([]), null);
  assert.equal(SpaceWx.normalizeKp(null), null);
  // Invalid rows are skipped instead of becoming a fake storm.
  assert.equal(SpaceWx.normalizeKp([{ time_tag: 'x', Kp: 99 }]), null);
  assert.equal(SpaceWx.normalizeKp([{ time_tag: 'x', Kp: null }]), null);
});

test('the G-scale labels start at Kp 5 and never overstate a quiet field', () => {
  assert.equal(SpaceWx.geomagneticLevel(2.3).code, 'QUIET');
  assert.equal(SpaceWx.geomagneticLevel(4.1).code, 'ACTIVE');
  assert.equal(SpaceWx.geomagneticLevel(5).code, 'G1');
  assert.equal(SpaceWx.geomagneticLevel(6.2).code, 'G2');
  assert.equal(SpaceWx.geomagneticLevel(7.5).code, 'G3');
  assert.equal(SpaceWx.geomagneticLevel(8.1).code, 'G4');
  assert.equal(SpaceWx.geomagneticLevel(9).code, 'G5');
  assert.equal(SpaceWx.geomagneticLevel(null).code, '—');
});

test('peak and GeoJSON features use real sampled cells only', () => {
  const points = [
    { lon: 10, lat: 60, value: 12 },
    { lon: 20, lat: 70, value: 81 },
    { lon: -30, lat: 65, value: 44 },
  ];
  assert.equal(SpaceWx.peak(points).value, 81);
  assert.equal(SpaceWx.peak([]), null);
  const features = SpaceWx.features(points);
  assert.equal(features.length, 3);
  assert.deepEqual(inRealm(features[1].geometry.coordinates), [20, 70]);
  assert.equal(features[1].properties.value, 81);
});

test('the aurora layer is wired into the tools, chip and service worker', () => {
  assert.match(html, /id="btn-aurora"/);
  assert.match(html, /id="aurora-chip"/);
  assert.match(html, /js\/spacewx\.js/);
  assert.ok(app.includes('SpaceWx.init(map)'));
  assert.ok(app.includes('SpaceWx.restore()'));
  assert.ok(app.includes('SpaceWx.toggle()'));
  assert.ok(app.includes('SpaceWx.openList()'));
  assert.ok(sw.includes('./js/spacewx.js'));
  assert.ok(sw.includes('./js/layers.js'));
  // The source is named in the layer itself, not only in documentation.
  assert.ok(source.includes('services.swpc.noaa.gov/json/ovation_aurora_latest.json'));
  assert.ok(source.includes('services.swpc.noaa.gov/products/noaa-planetary-k-index.json'));
});
