import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const src = readFileSync(new URL('../js/conflict.js', import.meta.url), 'utf8');
const Conflict = runInNewContext(src + '\nConflict;', {});

const ev = (date, lon, lat, country, region, type, kills, place) =>
  [date, lon, lat, country, region, type, kills, place];

test('kindOf maps UCDP conflict types without editorialising', () => {
  assert.equal(Conflict.kindOf(ev('2026-09-01', 0, 0, 'T', '', '1', 0, '')), 'political violence');
  assert.equal(Conflict.kindOf(ev('2026-09-01', 0, 0, 'T', '', '2', 0, '')), 'terrorism');
  assert.equal(Conflict.kindOf(ev('2026-09-01', 0, 0, 'T', '', '3', 0, '')), 'war');
});

test('colorFor is a transparent death-count scale', () => {
  assert.equal(Conflict.colorFor(ev('2026-09-01', 0, 0, 'T', '', '3', 30, '')), '#ff667d');
  assert.equal(Conflict.colorFor(ev('2026-09-01', 0, 0, 'T', '', '3', 7, '')), '#ff9dab');
  assert.equal(Conflict.colorFor(ev('2026-09-01', 0, 0, 'T', '', '3', 2, '')), '#ffb454');
  assert.equal(Conflict.colorFor(ev('2026-09-01', 0, 0, 'T', '', '3', 0, '')), '#e07a5f');
});

test('card escapes content and cites the dataset', () => {
  const html = Conflict.card(ev('2026-09-01', 1.5, 41.0, '<b>Land</b>', 'Region', '3', 12, 'The "site"'));
  assert.ok(!html.includes('<b>Land</b>'));
  assert.ok(html.includes('&lt;b&gt;Land&lt;/b&gt;'));
  assert.ok(html.includes('12 reported killed'));
  assert.ok(html.includes('UCDP/PRIO GED'));
});

test('features() emits points at the event coordinates', () => {
  const s = Conflict._state;
  s.events = [ev('2026-09-01', 1.5, 41.0, 'Land', 'R', '1', 0, 'P')];
  const feats = Conflict.features();
  assert.equal(feats.length, 1);
  assert.equal(feats[0].geometry.coordinates[0], 1.5);
  assert.equal(feats[0].geometry.coordinates[1], 41.0);
  s.events = [];
});

test('the CONFLICT control, chip and scripts exist in the UI', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="btn-conflict"/);
  assert.match(html, /id="conflict-chip"/);
  assert.match(html, /data-do="#btn-conflict"/);
  assert.match(html, /js\/conflict\.js/);
});
