/* The registry is the product: ~30k public feeds. These tests pin the rules
 * that make it usable — what a filter means, how each order behaves, how much
 * is revealed at once, and how a shared link is encoded and validated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/registry.js', import.meta.url), 'utf8');
const Registry = runInNewContext(source + '\nRegistry;', {});
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const palette = readFileSync(new URL('../js/palette.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');

const inRealm = (value) => JSON.parse(JSON.stringify(value));
const ids = (rows) => rows.map((row) => row.id);

const cam = (over) => ({
  id: 'a', name: 'I-10 McDonald Rd', place: 'Phoenix', region: 'AZ',
  country: 'US', stype: 'm3u8', status: 'live', ...over,
});

test('filters are parsed defensively and only valid values survive', () => {
  const f = Registry.parse('?q=new%20york&type=image&country=US&live=live&sort=status');
  assert.deepEqual(inRealm(f), {
    q: 'new york', type: 'image', country: 'US', live: 'live', sort: 'status',
  });
  // Unknown enum values fall back to the honest default rather than filtering to nothing.
  const junk = Registry.parse('?type=evil&live=nope&sort=chaos&country=&q=' + 'x'.repeat(400));
  assert.equal(junk.type, 'all');
  assert.equal(junk.live, 'all');
  assert.equal(junk.sort, 'registry');
  assert.equal(junk.country, 'all');
  assert.equal(junk.q.length, 120);
  // Malformed escapes must not throw the page away.
  assert.equal(Registry.parse('?q=%E0%A4%A').q, '');
  assert.equal(Registry.parse('?q=a+b').q, 'a b');
  assert.equal(Registry.parse('').sort, 'registry');
});

test('a filter query round-trips and omits defaults', () => {
  const filters = { q: 'new york', type: 'image', country: 'US', live: 'live', sort: 'status' };
  assert.equal(Registry.query(filters), 'q=new%20york&type=image&country=US&live=live&sort=status');
  assert.deepEqual(inRealm(Registry.parse('?' + Registry.query(filters))), filters);
  assert.equal(Registry.query({ q: '', type: 'all', country: 'all', live: 'all', sort: 'registry' }), '');
  assert.equal(Registry.hasFilters({ q: '', sort: 'name' }), false);
  assert.equal(Registry.hasFilters({ live: 'live' }), true);
  assert.equal(Registry.hasFilters({ q: 'x' }), true);
});

test('matching keeps the published semantics and adds country search', () => {
  const row = cam();
  assert.ok(Registry.matches(row, { q: '', type: 'all', country: 'all', live: 'all' }));
  assert.ok(Registry.matches(row, { q: 'phoenix' }));
  assert.ok(Registry.matches(row, { q: 'us' }));
  assert.ok(!Registry.matches(row, { q: 'berlin' }));
  assert.ok(!Registry.matches(row, { country: 'CA' }));
  assert.ok(!Registry.matches(row, { type: 'embed' }));
  // Snapshot filter deliberately includes the dynamic snapshot type.
  assert.ok(Registry.matches(cam({ stype: 'dynamic' }), { type: 'image' }));
  assert.ok(Registry.matches(row, { live: 'down' }, { statusOf: () => 'down' }));
  assert.ok(!Registry.matches(row, { live: 'down' }, { statusOf: () => 'live' }));
  assert.ok(!Registry.matches(row, { live: 'live' }, { statusOf: () => 'down' }));
  assert.ok(Registry.matches(row, { live: 'live' }, { statusOf: () => 'live' }));
  assert.ok(!Registry.matches(row, {}, { favsOnly: true, favs: new Set() }));
  assert.ok(Registry.matches(row, {}, { favsOnly: true, favs: new Set(['a']) }));
});

test('each sort is deterministic and registry order is left alone', () => {
  const rows = [
    cam({ id: 'b', name: 'Beta', country: 'DE', status: 'down' }),
    cam({ id: 'a', name: 'Alpha', country: 'US', status: 'live' }),
    cam({ id: 'c', name: 'Gamma', country: 'US', status: 'unknown' }),
  ];
  assert.deepEqual(ids(Registry.sortCams(rows, 'registry')), ['b', 'a', 'c']);
  assert.deepEqual(ids(Registry.sortCams(rows, 'name')), ['a', 'b', 'c']);
  assert.deepEqual(ids(Registry.sortCams(rows, 'country')), ['b', 'a', 'c']);
  assert.deepEqual(ids(Registry.sortCams(rows, 'status', (row) => row.status)), ['a', 'c', 'b']);
  assert.deepEqual(ids(Registry.sortCams(rows, 'nonsense')), ['b', 'a', 'c']);
  // Sorting copies: the source array is never mutated in place.
  assert.deepEqual(ids(rows), ['b', 'a', 'c']);
});

test('paging reveals a bounded slice, including an explicit zero', () => {
  assert.equal(Registry.page(Array.from({ length: 700 }, (_, i) => i), Registry.PAGE).length, 300);
  assert.equal(Registry.page([1, 2, 3], Registry.PAGE).length, 3);
  assert.equal(Registry.page([1, 2, 3], 0).length, 0);
  assert.equal(Registry.page([1, 2, 3], undefined).length, 3);
  assert.equal(Registry.PAGE, 300);
});

test('the registry surfaces are wired into the shell', () => {
  assert.match(html, /id="f-sort"/);
  assert.match(html, /id="list-count" aria-live="polite"/);
  assert.match(html, /js\/registry\.js/);
  assert.match(html, /id="sync-msg" role="status" aria-live="polite"/);
  assert.ok(app.includes('Registry.matches(c, f, ctx)'));
  assert.ok(app.includes('function syncFiltersToURL('));
  assert.ok(app.includes('function applyFiltersFromURL('));
  assert.ok(app.includes('function clearFilters('));
  assert.ok(app.includes('id="list-more"'));
  assert.ok(app.includes('id="list-clear"'));
  assert.ok(app.includes('localStorage.getItem("ge_sort")'));
  // Sorting is remembered locally; filters are shareable.
  assert.ok(app.includes('localStorage.setItem("ge_sort"'));
  assert.match(css, /#cam-list li\.list-more/);
  assert.match(css, /#cam-list li\.list-empty/);
  assert.match(css, /\.filters \{ display: grid/);
});

test('palette remembers recently run commands without recording feeds', () => {
  assert.ok(palette.includes('ge_palette_recent'));
  assert.ok(palette.includes('function loadRecent()'));
  assert.ok(palette.includes('function remember(row)'));
  assert.ok(palette.includes('row.id.startsWith("btn:")'));
  assert.ok(palette.includes('hint: "RECENT"'));
  // Only command ids are stored, so a camera or coordinate is never a memory.
  const remember = palette.slice(palette.indexOf('function remember(row)'), palette.indexOf('function select(next)'));
  assert.ok(remember.includes('startsWith("btn:")') && remember.includes('startsWith("static:")'));
  assert.doesNotMatch(remember, /label|place|country/);
});
