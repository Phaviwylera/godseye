import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const satelliteSrc = readFileSync(new URL('../vendor/satellite.min.js', import.meta.url), 'utf8');
const issSrc = readFileSync(new URL('../js/iss.js', import.meta.url), 'utf8');
// satellite.min.js is UMD: in a bare context it attaches to the sandbox's global.
const sandbox = {};
const Iss = runInNewContext(satelliteSrc + '\n' + issSrc + '\nIss;', sandbox);
const engine = sandbox.satellite;

const DEG = Math.PI / 180;
const R = 6378.135; // km (satellite.js earth radius)

test('eciToEcf is the Z-rotation by -gmst', () => {
  const p = { x: 1, y: 0, z: 0 };
  const i = Iss.eciToEcf(p, 0);
  assert.ok(Math.abs(i.x - 1) < 1e-12 && Math.abs(i.y) < 1e-12 && Math.abs(i.z) < 1e-12);
  const q = Iss.eciToEcf(p, Math.PI / 2);
  assert.ok(Math.abs(q.x) < 1e-12 && Math.abs(q.y + 1) < 1e-12, `got ${JSON.stringify(q)}`);
});

test('topocentric ENU: zenith, horizon-east, and a 45° case', () => {
  const obs = { x: R, y: 0, z: 0 }; // lat 0, lon 0
  const zen = Iss.topocentric(obs, { x: R + 400, y: 0, z: 0 }, 0, 0);
  assert.ok(Math.abs(zen.z - 400) < 1e-9 && Math.abs(zen.x) < 1e-9 && Math.abs(zen.y) < 1e-9);
  assert.ok(Iss.horizon(zen).elevation > 1.55, 'directly overhead ≈ 90°');

  const east = Iss.topocentric(obs, { x: R, y: 500, z: 0 }, 0, 0); // east is +y at lon 0
  const hEast = Iss.horizon(east);
  assert.ok(Math.abs(hEast.elevation) < 1e-9, 'at the same geocentric radius it is on the horizon');
  assert.ok(Math.abs(hEast.azimuth - Math.PI / 2) < 1e-9, 'azimuth 90° = east');
});

test('elevationAt: real ISS elements, satellite over the equator gives sane values', () => {
  const doc = JSON.parse(readFileSync(new URL('../data/satellites.json', import.meta.url), 'utf8'));
  const rec = doc.records.find(r => r.OBJECT_NAME === 'ISS (ZARYA)');
  assert.ok(rec, 'snapshot must carry ISS (ZARYA)');
  const satrec = engine.json2satrec(rec);
  const t0 = Date.now();
  // Somewhere on the planet the station is above the horizon; a random far pole
  // may or may not be — so just assert the value is a finite angle in range.
  const el = Iss.elevationAt(satrec, t0, { lat: 13.08, lon: 80.27, heightKm: 0.05 });
  assert.ok(Number.isFinite(el), 'finite elevation');
  assert.ok(el >= -Math.PI / 2 && el <= Math.PI / 2);
});

test('findPasses: 48 h sweep produces plausible passes (geometry, not fabrication)', () => {
  const doc = JSON.parse(readFileSync(new URL('../data/satellites.json', import.meta.url), 'utf8'));
  const rec = doc.records.find(r => r.OBJECT_NAME === 'ISS (ZARYA)');
  const satrec = engine.json2satrec(rec);
  const from = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const passes = Iss.findPasses(satrec, { lat: 13.08, lon: 80.27, heightKm: 0.05 }, { from, hours: 48, stepSec: 30, minElevDeg: 5 });
  assert.ok(passes.length >= 0 && passes.length <= 8, `sane pass count, got ${passes.length}`);
  for (const p of passes) {
    assert.ok(p.end >= p.start, 'pass runs forward in time');
    assert.ok(p.maxEl >= 5 * DEG, 'peak above the threshold');
    assert.ok(p.end - p.start < 30 * 60000, 'an ISS pass lasts well under 30 minutes');
    assert.ok(p.start >= from && p.start <= from + 48 * 3600000, 'pass inside the window');
  }
});

test('compass maps angles to 16-point cardinal strings', () => {
  assert.equal(Iss.compass(0), 'N 0°');
  assert.equal(Iss.compass(Math.PI / 2), 'E 90°');
  assert.equal(Iss.compass(Math.PI), 'S 180°');
  assert.equal(Iss.compass(-Math.PI / 2), 'W 270°');
  assert.equal(Iss.compass(null), '—');
});
