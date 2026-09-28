import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/markets.js', import.meta.url), 'utf8');
const Markets = runInNewContext(source + '\nMarkets;', {});

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const geoDoc = JSON.parse(readFileSync(new URL('../data/markets-geo.json', import.meta.url), 'utf8'));

const gammaFixtures = [
  {
    id: '101', question: 'Will the UK pass a climate law before 2027?', slug: 'uk-climate-2027',
    active: true, closed: false,
    outcomes: '["Yes", "No"]', outcomePrices: '["0.42", "0.58"]',
    volume24hr: 2100000, liquidityNum: 340000, oneWeekPriceChange: 0.08,
    endDateIso: '2027-01-01', image: 'https://img.example/x.png', questionID: 'q-101',
  },
  {
    id: '102', question: 'GDP growth above 2%?', slug: 'gdp-2',
    active: true, closed: false,
    outcomes: '["Yes", "No"]', outcomePrices: '["0.9", "0.1"]',
    volume24hr: 500, liquidityNum: 9000, oneWeekPriceChange: 0.02,
    endDateIso: '2026-12-31',
  },
  { id: '103', question: 'closed market', active: false, closed: true,
    outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', volume24hr: 9e9 },
  { id: '104', question: 'no yes outcome', active: true, closed: false,
    outcomes: '["A","B"]', outcomePrices: '["1","0"]', volume24hr: 9e9 },
];

test('normalize keeps valid active markets, drops the rest, sorts by 24h volume', () => {
  const rows = Markets.normalize(gammaFixtures);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '101');          // 2.1M volume first
  assert.equal(rows[1].id, '102');
  assert.equal(rows[0].yes, 0.42);
  assert.equal(rows[0].vol24, 2100000);
  assert.equal(rows[0].delta, 0.08);
  assert.equal(rows[0].url, 'https://polymarket.com/market/q-101');
  assert.ok(rows[0].question.startsWith('Will the UK'));
});

test('normalize accepts array-form outcomes/prices and tolerates missing fields', () => {
  const rows = Markets.normalize([{
    id: 'x', question: 'Q?', active: true, closed: false,
    outcomes: ['Yes', 'No'], outcomePrices: ['0.5', '0.5'],
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].yes, 0.5);
  assert.equal(rows[0].delta, null);
  assert.equal(rows[0].ends, '');
});

test('signalFor flags fast movers and stays quiet on drift', () => {
  assert.equal(Markets.signalFor({ delta: 0.08, vol24: 2000000 }).hot, true);
  assert.equal(Markets.signalFor({ delta: -0.06, vol24: 150000 }).hot, true);
  assert.equal(Markets.signalFor({ delta: 0.02, vol24: 5000000 }).hot, false);
  assert.equal(Markets.signalFor({ delta: 0.09, vol24: 90000 }).hot, false);
  assert.equal(Markets.signalFor({ delta: null, vol24: 900000 }).hot, false);
  assert.equal(Markets.signalFor({ delta: 0.08, vol24: 2000000 }).dir, 'up');
});

test('geoMatch resolves recurring topics and leaves global markets unplaced', () => {
  const table = geoDoc.table;
  assert.ok(Markets.geoMatch('Will the UK pass a climate law before 2027?', table)?.name === 'London');
  assert.ok(Markets.geoMatch('Ukraine: ceasefire before summer?', table)?.name === 'Kyiv');
  assert.ok(Markets.geoMatch('US presidential election: who wins?', table)?.name === 'Washington, D.C.');
  assert.equal(Markets.geoMatch('Bitcoin above $200k in 2027?', table), null);
  assert.equal(Markets.geoMatch('', table), null);
});

test('cardHTML escapes untrusted question text', () => {
  const html = Markets.cardHTML({
    question: '<script>alert(1)</script>', yes: 0.5, delta: 0.1, vol24: 500000,
    ends: '2027-01-01', url: 'https://polymarket.com/market/x',
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('50.0%'));
});

test('fmtVol formats human volumes', () => {
  assert.equal(Markets.fmtVol(2100000), '$2.1M');
  assert.equal(Markets.fmtVol(45000), '$45k');
  assert.equal(Markets.fmtVol(900), '$900');
});

test('the MARKETS control, chip and script exist in the UI', () => {
  assert.match(html, /id="btn-markets"/);
  assert.match(html, /id="markets-chip"/);
  assert.match(html, /js\/markets\.js/);
  assert.match(html, /data-do="#btn-markets"/);
});

test('markets geo table is a valid, ordered, range-checked curation', () => {
  assert.ok(Array.isArray(geoDoc.table) && geoDoc.table.length >= 25);
  const seen = new Set();
  for (const row of geoDoc.table) {
    assert.ok(typeof row.re === 'string' && row.re.length > 0, 'entry needs re');
    assert.ok(row.name, 'entry needs name');
    new RegExp(row.re, 'i'); // must compile
    assert.ok(Math.abs(row.lon) <= 180 && Math.abs(row.lat) <= 90, 'coords in range');
    assert.ok(row.zoom >= 3 && row.zoom <= 16, 'zoom sane');
    assert.ok(!seen.has(row.name), 'duplicate place ' + row.name);
    seen.add(row.name);
  }
});
