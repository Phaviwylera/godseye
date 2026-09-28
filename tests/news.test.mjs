import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const src = readFileSync(new URL('../js/news.js', import.meta.url), 'utf8');
const News = runInNewContext(src + '\nNews;', {});

const doc = {
  type: 'FeatureCollection',
  features: [
    { geometry: { type: 'Point', coordinates: [12.5, 41.9] }, properties: { title: 'Protesters clash with police', url: 'https://example.com/1', date: '2026-09-28T05:00:00Z' } },
    { geometry: { type: 'Point', coordinates: [-3.7, 40.4] }, properties: { title: 'Building collapsed, victims killed', url: 'https://example.com/2', date: '2026-09-28T06:30:00Z' } },
    { geometry: { type: 'Point', coordinates: [91.1, 29.9] }, properties: { name: 'Headless fallback', url: 'https://example.com/3', date: '2026-09-28T04:10:00Z' } },
    { geometry: { type: 'Point', coordinates: [200, 10] }, properties: { title: 'Out of range' } },
    { geometry: { type: 'Point', coordinates: 'bad' }, properties: { title: 'Broken geometry' } },
  ],
};

test('severity buckets: blunt, labelled, first-match-wins', () => {
  assert.equal(News.severity('Soldiers killed in airstrike').level, 9);
  assert.equal(News.severity('Soldiers killed in airstrike').label, 'CASUALTIES');
  assert.equal(News.severity('Missile launched over region').level, 7);
  assert.equal(News.severity('Protesters arrested after riot').level, 5);
  assert.equal(News.severity('Earthquake strikes coast; rescue teams deployed').level, 4);
  assert.equal(News.severity('Market opens for spring trading').level, 2);
  assert.equal(News.severity('').label, 'GENERAL');
});

test('normalize keeps valid geocoded articles, drops the rest, sorts by severity', () => {
  const items = News.normalize(doc, Date.parse('2026-09-28T07:00:00Z'));
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Building collapsed, victims killed');
  assert.equal(items[0].severity.level, 9);
  assert.equal(items[2].title, 'Headless fallback'); // `name` fallback
  for (const i of items) {
    assert.ok(i.lon >= -180 && i.lon <= 180 && i.lat >= -90 && i.lat <= 90);
  }
});

test('normalize tolerates a missing or non-FeatureCollection document', () => {
  assert.equal(News.normalize(null, Date.now()).length, 0);
  assert.equal(News.normalize({ features: 'nope' }, Date.now()).length, 0);
  assert.equal(News.normalize({ features: [] }, Date.now()).length, 0);
});

test('ageLabel renders minutes, hours, days', () => {
  const now = Date.parse('2026-09-28T07:00:00Z');
  assert.equal(News.ageLabel('2026-09-28T06:30:00Z', now), '30 min ago');
  assert.equal(News.ageLabel('2026-09-28T01:00:00Z', now), '6 h ago');
  assert.equal(News.ageLabel('2026-09-25T07:00:00Z', now), '3 d ago');
  assert.equal(News.ageLabel('not-a-date', now), '');
});

test('relay routes exist in both runtimes (server.py locally, api.mjs on Netlify)', () => {
  const server = readFileSync(new URL('../server.py', import.meta.url), 'utf8');
  assert.match(server, /path == "\/api\/gdelt"/);
  assert.match(server, /GDELT_QUERY/);
  const fn = readFileSync(new URL('../netlify/functions/api.mjs', import.meta.url), 'utf8');
  assert.match(fn, /path\.includes\('\/gdelt'\)/);
  assert.match(fn, /async function gdeltRoute/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="btn-news"/);
  assert.match(html, /id="news-chip"/);
  assert.match(html, /data-do="#btn-news"/);
  assert.match(html, /js\/news\.js/);
});
