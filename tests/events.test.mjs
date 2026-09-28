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

const FIRMS_CSV = [
  'lat,lon,brightness,temp,scan,track,acq_date,acq_time,confidence,sourcedata,ch_name,bright_t35,version',
  '37.1200,-121.9800,78.4,-12.3,0,1,2026-09-26,14:32:11,91,VIIRS,3I,287.4,2.0',
  '-33.4500,151.2600,55.1,-5.2,1,1,2026-09-26,15:01:44,64,VIIRS,3I,290.1,2.0',
  '64.1300,-21.8200,12.9,-18.0,0,1,2026-09-26,16:12:09,22,VIIRS,3I,271.9,2.0',
  '95.0,10.0,99,-10,0,1,2026-09-26,16:00:00,50,VIIRS,3I,300.0,2.0',   // out of range -> dropped
  '1.0,2.0,not-a-number,0,0,1,2026-09-26,16:00:00,50,VIIRS,3I,300.0,2.0', // bad row -> dropped
].join('\n');

test('parseFirmsCsv decodes valid rows and drops invalid ones', () => {
  const rows = Events.parseFirmsCsv(FIRMS_CSV);
  assert.equal(rows.length, 3);
  assert.deepEqual(inRealm(rows[0]), { lon: -121.98, lat: 37.12, bright: 78.4, conf: 91, date: '2026-09-26' });
  assert.equal(rows[1].lat, -33.45);
  assert.equal(rows[2].bright, 12.9);
});

test('parseFirmsCsv rejects non-FIRMS payloads and returns empty for empty input', () => {
  assert.throws(() => Events.parseFirmsCsv('a,b,c\n1,2,3'));
  assert.deepEqual(inRealm(Events.parseFirmsCsv('')), []);
  assert.deepEqual(inRealm(Events.parseFirmsCsv(null)), []);
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


test('real VIIRS schema preserves categorical confidence and rejects empty coordinates', () => {
  const rows = Events.parseFirmsCsv('latitude,longitude,bright_ti4,confidence,acq_date\n13.1,80.2,330.4,n,2026-09-28\n,80.2,340,h,2026-09-28\n12,81,331,l,2026-09-28');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].conf, 'nominal');
  assert.equal(rows[1].conf, 'low');
  assert.equal(rows[0].lat, 13.1);
});

test('MODIS schema preserves numeric confidence', () => {
  const rows = Events.parseFirmsCsv('latitude,longitude,brightness,confidence\n13,80,320,87');
  assert.equal(rows[0].conf, 87);
});
