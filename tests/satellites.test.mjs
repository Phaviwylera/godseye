import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const engine = require('../vendor/satellite.min.js');
const source = readFileSync(new URL('../js/satellites.js', import.meta.url), 'utf8');
const Satellites = runInNewContext(source + '\nSatellites;', { satellite: engine, Date });

test('OMM catalog produces plausible predicted positions without a live network call', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/satellites.json', import.meta.url)));
  const items = Satellites.parseCatalog(catalog);
  assert.ok(items.length >= 20);
  const features = Satellites.positionsAt(items).features;
  assert.ok(features.length >= 20);
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    assert.ok(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90);
    assert.ok(feature.properties.altitude > 100 && feature.properties.altitude < 40000);
  }
  const iss = features.find(f => f.properties.id === '25544');
  assert.ok(iss && iss.properties.altitude > 300 && iss.properties.altitude < 500);
});
