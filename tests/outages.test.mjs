import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/outages.js', import.meta.url), 'utf8');
const Outages = runInNewContext(source + '\nOutages;', {});
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const inRealm = (x) => JSON.parse(JSON.stringify(x));

const alert = (code, level, time, extra = {}) => Object.assign({
  entity: { code, name: 'Country ' + code, type: 'country' },
  level, time, condition: '< 0.8', value: 100, historyValue: 150,
  datasource: 'bgp', method: 'median',
}, extra);

test('normalizeIoda keeps only non-normal alerts, latest per country', () => {
  const rows = Outages.normalizeIoda({ data: [
    alert('US', 'normal', 500),
    alert('US', 'warning', 100),
    alert('US', 'critical', 200),          // newer + stronger: wins
    alert('IN', 'warning', 300),
    alert('IN', 'warning', 400),           // newer: wins
    alert('ZZ', 'critical', 100, { entity: { code: 'ZZ', name: 'Test' } }),
    alert('', 'critical', 100, { entity: { code: '', name: 'No code' } }),
    alert('BR', 'critical', null),         // no usable timestamp
    alert('CA', 'warning', 100, { value: null, historyValue: null }),  // missing numbers stay null
  ] });
  assert.equal(rows.length, 4);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(byCode.US.level, 'critical');
  assert.equal(byCode.US.time, 200);
  assert.equal(byCode.IN.time, 400);
  assert.equal(byCode.ZZ.rank, 2);
  assert.equal(byCode.CA.value, null);
  assert.equal(byCode.CA.history, null);
  assert.equal(rows[0].rank, 2, 'critical alerts sort first');
});

test('normalizeIoda tolerates empty and malformed documents', () => {
  assert.deepEqual(inRealm(Outages.normalizeIoda(null)), []);
  assert.deepEqual(inRealm(Outages.normalizeIoda({})), []);
  assert.deepEqual(inRealm(Outages.normalizeIoda({ data: [null, {}] })), []);
});

test('placeAlerts uses the country centre and counts unmapped rows', () => {
  const alerts = Outages.normalizeIoda({ data: [alert('US', 'critical', 200), alert('XX', 'warning', 300)] });
  const placed = Outages.placeAlerts(alerts, { US: { name: 'United States', lat: 38, lon: -97 } });
  assert.equal(placed.rows.length, 1);
  assert.equal(placed.rows[0].code, 'US');
  assert.equal(placed.rows[0].lat, 38);
  assert.equal(placed.rows[0].lon, -97);
  assert.equal(placed.rows[0].place, 'United States');
  assert.equal(placed.unmapped, 1);
});

test('level labels and colours come from IODA levels', () => {
  assert.equal(Outages.levelLabel('critical'), 'CRITICAL');
  assert.equal(Outages.levelLabel('warning'), 'WARNING');
  assert.equal(Outages.levelColor(2), '#ff4d5e');
  assert.equal(Outages.levelColor(1), '#ffb454');
  assert.equal(Outages.datasourceLabel('ping-slash24'), 'active probing');
});

test('card escapes feed text and labels the country centroid', () => {
  const card = Outages.card({
    place: '<b>Land</b>', name: 'L', level: 'critical', rank: 2,
    datasource: 'bgp', value: 100, history: 150, condition: '< 0.8',
    time: 1792996494, method: 'median',
  });
  assert.ok(!card.includes('<b>Land</b>'));
  assert.ok(card.includes('&lt;b&gt;Land&lt;/b&gt;'));
  assert.ok(card.includes('approximate centre'));
  assert.ok(card.includes('not confirmation of an outage'));
});

test('the OUTAGES control, chip and script exist in the UI', () => {
  assert.match(html, /id="btn-outages"/);
  assert.match(html, /id="outages-chip"/);
  assert.match(html, /js\/outages\.js/);
  assert.match(html, /data-do="#btn-outages"/);
});
