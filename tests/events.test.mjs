import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/events.js', import.meta.url), 'utf8');
const Events = runInNewContext(source + '\nEvents;', {});

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* Values built inside the vm context carry the context's prototypes, so
 * normalise them into this realm before deepEqual (same trick as JSON round-trip). */
const inRealm = (x) => JSON.parse(JSON.stringify(x));

/* Realistic FIRMS payloads: the exact header the area API answers for each
 * product, with real row shapes — VIIRS brightness (Kelvin) in bright_ti4 and
 * letter confidence, MODIS brightness with a 0-100 confidence, the 0,0
 * null-island artefact, one out-of-range row and one unparsable row. */
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const FIRMS_VIIRS = fixture('firms-viirs-noaa21.csv');
const FIRMS_MODIS = fixture('firms-modis-nrt.csv');
const FIRMS_ERROR = fixture('firms-invalid-key.txt');

test('parseFirmsCsv reads the real VIIRS area-CSV header', () => {
  const rows = Events.parseFirmsCsv(FIRMS_VIIRS);
  // 9 data lines: 6 real detections; 0,0 artefact, out-of-range lon and a
  // non-numeric brightness are all dropped rather than coerced.
  assert.equal(rows.length, 6);
  const first = rows[0];
  assert.equal(first.lat, 66.42133);
  assert.equal(first.lon, 58.04745);
  assert.equal(first.bright, 326.84);          // bright_ti4, Kelvin
  assert.equal(first.conf, null);              // VIIRS confidence is a letter…
  assert.equal(first.confLabel, 'nominal');    // …and 'n' means nominal
  assert.equal(first.frp, 2.74);
  assert.equal(first.date, '2026-09-27');
  assert.equal(first.time, '0001');            // acq_time is HHMM UTC
  assert.equal(first.at, '2026-09-27T00:01:00Z');
  assert.equal(first.daynight, 'N');
  assert.equal(first.instrument, 'VIIRS');
  assert.deepEqual(inRealm(rows.map((r) => r.lon)), [58.04745, -74.22502, 102.5581, -121.30419, 151.261, -21.82]);
  assert.equal(rows[1].confLabel, 'nominal');  // 'nominal' spelled out
  assert.equal(rows[2].confLabel, 'high');
  assert.equal(rows[3].time, '1834');
  assert.equal(rows[5].confLabel, 'low');
  assert.ok(rows.every((r) => r.conf === null), 'no VIIRS row may carry a fabricated percentage');
});

test('parseFirmsCsv reads the MODIS variant, where confidence is numeric', () => {
  const rows = Events.parseFirmsCsv(FIRMS_MODIS);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].bright, 312.4);
  assert.equal(rows[0].conf, 87);
  assert.equal(rows[0].confLabel, null);
  assert.equal(rows[0].time, '0145');
  assert.equal(rows[2].conf, 23);
});

test('parseFirmsCsv returns nothing for a header-only sweep, and refuses prose', () => {
  assert.deepEqual(inRealm(Events.parseFirmsCsv(fixture('firms-header-only.csv'))), []);
  assert.deepEqual(inRealm(Events.parseFirmsCsv('')), []);
  assert.deepEqual(inRealm(Events.parseFirmsCsv(null)), []);
  // FIRMS signals a bad MAP_KEY with HTTP 200 and a line of prose: refused, never
  // read as a world with no fires.
  assert.throws(() => Events.parseFirmsCsv(FIRMS_ERROR), /firms:/);
  assert.throws(() => Events.parseFirmsCsv('a,b,c\n1,2,3'));
  assert.equal(Events.isFirmsCsv(FIRMS_VIIRS), true);
  assert.equal(Events.isFirmsCsv(FIRMS_MODIS), true);
  assert.equal(Events.isFirmsCsv(FIRMS_ERROR), false);
  assert.equal(Events.isFirmsCsv('<html><body>404</body></html>'), false);
});

test('firmsStamp pads and rejects malformed acquisition times', () => {
  assert.deepEqual(inRealm(Events.firmsStamp('2026-09-27', '3')), { date: '2026-09-27', time: '0003', at: '2026-09-27T00:03:00Z' });
  assert.deepEqual(inRealm(Events.firmsStamp('2026-09-27', '1834')), { date: '2026-09-27', time: '1834', at: '2026-09-27T18:34:00Z' });
  assert.deepEqual(inRealm(Events.firmsStamp('', '1834')), { date: '', time: '', at: '' });
  assert.deepEqual(inRealm(Events.firmsStamp('2026-09-27', '9999')), { date: '2026-09-27', time: '', at: '' });
});

test('fire cards state the feed\'s own units and confidence', () => {
  const fire = Events.parseFirmsCsv(FIRMS_VIIRS)[2];
  const html = Events.fireCard(fire);
  assert.match(html, /340\.1 K/);              // brightness temperature, Kelvin
  assert.match(html, /confidence high/);
  assert.match(html, /FRP 18\.6 MW/);
  assert.match(html, /2026-09-27 06:07 UTC/);
  assert.match(html, /daytime/);
  const modis = Events.fireCard(Events.parseFirmsCsv(FIRMS_MODIS)[0]);
  assert.match(modis, /confidence 87%/);
  assert.match(Events.fireLabel(fire), /340 K · HIGH/);
});

test('ringCenter averages the first ring (closed ring), never the duplicate vertex', () => {
  const poly = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
  assert.deepEqual(inRealm(Events.ringCenter(poly)), [1, 1]);
  const multi = { type: 'MultiPolygon', coordinates: [[ [ [10, 10], [12, 10], [12, 12], [10, 12], [10, 10] ] ]] };
  assert.deepEqual(inRealm(Events.ringCenter(multi)), [11, 11]);
  assert.equal(Events.ringCenter(null), null);
  assert.equal(Events.ringCenter({ type: 'Point', coordinates: [1, 2] }), null);
  assert.equal(Events.ringCenter({ type: 'Polygon', coordinates: [[[999, 0], [0, 0], [0, 1], [999, 0]]] }), null);
});

const NWS_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { event: 'Tornado Warning', severity: 'Extreme',
        headline: 'The following areas are under a Tornado Warning until 4:00 PM CDT. Leon County, OK.',
        issueDate: '2026-09-28T18:30:00Z' },
      geometry: { type: 'Polygon', coordinates: [[[-97.0, 35.0], [-96.0, 35.0], [-96.0, 35.5], [-97.0, 35.5], [-97.0, 35.0]]] },
    },
    {
      type: 'Feature',
      properties: { event: 'Severe Thunderstorm Warning', severity: 'Severe',
        headline: 'Large hail and damaging winds.', issueDate: '2026-09-28T17:00:00Z' },
      geometry: { type: 'MultiPolygon', coordinates: [[ [ [-95.0, 34.0], [-94.0, 34.0], [-94.0, 34.4], [-95.0, 34.4], [-95.0, 34.0] ] ] ] },
    },
    {
      type: 'Feature',
      properties: { event: 'Flash Flood Watch', severity: 'Moderate', headline: 'moderate', issueDate: '' },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    },
    {
      type: 'Feature',
      properties: { event: 'Flood Warning', severity: 'Severe', headline: 'rising river', issueDate: '2026-09-28T09:00:00Z' },
      geometry: { type: 'Polygon', coordinates: [[[-80, 40], [-79, 40], [-80, 41], [-79, 41], [-80, 40]]] },
    },
    {
      type: 'Feature',
      properties: { event: 'High Wind Advisory', severity: 'Extreme', headline: 'windy', issueDate: '' },
      geometry: { type: 'Polygon', coordinates: [] }, // no geometry -> dropped
    },
  ],
};

test('normalizeNws keeps Severe/Extreme storm events only, ranked Extreme first', () => {
  const rows = Events.normalizeNws(NWS_FIXTURE);
  assert.deepEqual(inRealm(rows.map((r) => r.event)), ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flood Warning']);
  assert.equal(rows[0].lon, -96.5);
  assert.equal(rows[0].lat, 35.25);
  assert.ok(rows[0].headline.includes('Tornado Warning until'));
  assert.equal(rows[0].severity, 'Extreme');
});

test('normalizeNws tolerates empty documents', () => {
  assert.deepEqual(inRealm(Events.normalizeNws(null)), []);
  assert.deepEqual(inRealm(Events.normalizeNws({})), []);
});

test('the EVENTS control, chip and script exist in the UI', () => {
  assert.match(html, /id="btn-events"/);
  assert.match(html, /id="events-chip"/);
  assert.match(html, /js\/events\.js/);
  assert.match(html, /data-do="#btn-events"/);
});

test('fmtAge renders sweep ages honestly', () => {
  assert.match(Events.fmtAge(0), /—/);
  assert.equal(Events.fmtAge(Date.now() - 20000), 'just now');
  assert.equal(Events.fmtAge(Date.now() - 5 * 60000), '5 min ago');
  assert.equal(Events.fmtAge(Date.now() - 2 * 3600000), '2 h ago');
});
