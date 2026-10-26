import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/hazards.js', import.meta.url), 'utf8');
const Hazards = runInNewContext(source + '\nHazards;', {});
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const inRealm = (x) => JSON.parse(JSON.stringify(x));

const feat = (id, type, level, lon, lat, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: Object.assign({
    eventtype: type, eventid: id, episodeid: 1, eventname: 'E' + id,
    name: 'Event ' + id, alertlevel: level, country: 'Testland', iso3: 'TSL',
    fromdate: '2026-10-20T00:00:00', todate: '2026-10-25T00:00:00',
    iscurrent: true, description: 'A reported event',
    severitydata: { severitytext: 'Severe' },
    url: { report: 'https://www.gdacs.org/report.aspx?eventid=' + id },
  }, extra),
});

test('normalizeGdacs keeps real coordinates and publisher alert levels', () => {
  const rows = Hazards.normalizeGdacs({ features: [
    feat(1, 'EQ', 'Red', 10, 20),
    feat(2, 'TC', 'Orange', 30, -5),
    feat(3, 'FL', 'Green', 40, 5),
    feat(4, 'EQ', 'Red', 181, 0),          // out of range
    feat(5, 'XX', 'Red', 1, 1),            // unknown type
    feat(6, 'EQ', 'Red', 0, 0),            // null island
    feat(7, 'WF', '', 2, 2),               // no alert level
    feat(8, 'EQ', 'Red', null, 12),        // Number(null) must not become 0
  ] });
  assert.equal(rows.length, 3);
  assert.deepEqual(inRealm(rows.map((r) => r.alert)), ['Red', 'Orange', 'Green']);
  assert.equal(rows[0].typeLabel, 'Earthquake');
  assert.equal(rows[0].severity, 'Severe');
  assert.equal(rows[0].report, 'https://www.gdacs.org/report.aspx?eventid=1');
});

test('normalizeGdacs tolerates empty and malformed documents', () => {
  assert.deepEqual(inRealm(Hazards.normalizeGdacs(null)), []);
  assert.deepEqual(inRealm(Hazards.normalizeGdacs({})), []);
  assert.deepEqual(inRealm(Hazards.normalizeGdacs({ features: [null, {}] })), []);
});

test('alert rank and colour are a fixed publisher scale', () => {
  assert.equal(Hazards.alertRank('Red'), 3);
  assert.equal(Hazards.alertRank('Orange'), 2);
  assert.equal(Hazards.alertRank('Green'), 1);
  assert.equal(Hazards.alertRank(''), 0);
  assert.equal(Hazards.alertColor(3), '#ff4d5e');
  assert.equal(Hazards.alertColor(2), '#ffb454');
  assert.equal(Hazards.alertColor(1), '#8fe3a8');
});

test('GDACS report links allow only http(s)', () => {
  assert.equal(Hazards.safeLink('https://www.gdacs.org/x'), 'https://www.gdacs.org/x');
  assert.equal(Hazards.safeLink('javascript:alert(1)'), '');
  assert.equal(Hazards.safeLink('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(Hazards.safeLink('not a url'), '');
});

test('card escapes feed text', () => {
  const htmlCard = Hazards.card({
    icon: '⚠', name: '<script>x</script>', alert: 'Red', typeLabel: 'Flood',
    country: '<b>Land</b>', severity: '', from: '2026-10-20', to: '2026-10-21',
    current: true, description: '<img src=x onerror=alert(1)>', report: 'javascript:alert(1)',
  });
  assert.ok(!htmlCard.includes('<script>x</script>'));
  assert.ok(htmlCard.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(!htmlCard.includes('javascript:'));
});

test('features() emit points at the reported coordinates', () => {
  const state = Hazards._state;
  state.events = Hazards.normalizeGdacs({ features: [feat(9, 'TC', 'Red', 12.5, -3.5)] });
  const feats = Hazards.features();
  assert.equal(feats.length, 1);
  assert.equal(feats[0].geometry.coordinates[0], 12.5);
  assert.equal(feats[0].properties.h.color, '#ff4d5e');
  state.events = [];
});

test('the HAZARDS control, chip and script exist in the UI', () => {
  assert.match(html, /id="btn-hazards"/);
  assert.match(html, /id="hazards-chip"/);
  assert.match(html, /js\/hazards\.js/);
  assert.match(html, /data-do="#btn-hazards"/);
});
