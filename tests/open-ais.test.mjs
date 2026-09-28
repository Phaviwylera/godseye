/* The keyless AIS fallback in the ships layer. The corridor collector needs a provider key
 * configured on the server; when it is not — and always under `python3 server.py` — the layer
 * falls back to Digitraffic's open feed instead of showing an empty ocean.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const Vessels = runInNewContext(
  readFileSync(new URL('../js/vessels.js', import.meta.url), 'utf8') + '\nVessels;', {});

test('the open AIS shapes actually published are all readable', () => {
  const array = [
    { time: '2026-09-28T11:59:00Z', mmsi: 230123456, lat: 60.15, lon: 24.94,
      name: 'FINNLADY', sog: 14.2, cog: 271.5 },
    { time: '2026-09-28T11:58:00Z', mmsi: '276789000', lat: 60.2, lon: 25.1,
      shipName: 'VIIKINGI', speed: 0, heading: 90 },
  ];
  const wrapped = { locations: array };
  const geojson = { features: [
    { geometry: { type: 'Point', coordinates: [24.94, 60.15] },
      properties: { mmsi: 230123456, name: 'FINNLADY', sog: 14.2, cog: 271.5, timestamp: '2026-09-28T11:59:00Z' } },
  ] };
  for (const payload of [array, wrapped, geojson]) {
    const out = Vessels.parseOpenAis(payload);
    assert.equal(out.length, payload === geojson ? 1 : 2, JSON.stringify(payload).slice(0, 40));
    assert.equal(out[0].mmsi, '230123456');
    assert.equal(out[0].name, 'FINNLADY');
    assert.equal(out[0].lat, 60.15);
    assert.equal(out[0].lon, 24.94, 'x is longitude in a GeoJSON coordinate pair');
    assert.equal(out[0].speed, 14.2);
    assert.equal(out[0].course, 271.5);
    assert.ok(Number.isFinite(Date.parse(out[0].received)));
    assert.equal(out[0].track.length, 0, 'the open feed publishes no trail, so none is claimed');
  }
});

test('an unusable observation is refused rather than plotted somewhere invented', () => {
  const out = Vessels.parseOpenAis([
    { mmsi: '230123456', lat: 60.1, lon: 24.9 },                     // kept
    { mmsi: '23012345', lat: 60.1, lon: 24.9 },                     // 8-digit MMSI
    { mmsi: 'abc', lat: 60.1, lon: 24.9 },
    { mmsi: '230999999', lat: 0, lon: 0 },                          // null island
    { mmsi: '230888888', lat: 91, lon: 24.9 },                      // off the map
    { mmsi: '230777777', lat: 'not a number', lon: 24.9 },
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].mmsi, '230123456');
  assert.equal(out[0].name, 'MMSI 230123456', 'a vessel with no published name is labelled by its MMSI');
  assert.equal(Vessels.parseOpenAis(null).length, 0);
  assert.equal(Vessels.parseOpenAis({}).length, 0);
});

test('a name that would flood the popup is trimmed and the payload shape cannot break it', () => {
  const long = 'X'.repeat(200);
  const out = Vessels.parseOpenAis([{ mmsi: '230123456', lat: 60.1, lon: 24.9, name: long }]);
  assert.equal(out[0].name.length, 70);
  assert.equal(Vessels.parseOpenAis({ locations: 'not an array' }).length, 0);
});
