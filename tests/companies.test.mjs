import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const src = readFileSync(new URL('../js/companies.js', import.meta.url), 'utf8');
const Companies = runInNewContext(src + '\nCompanies;', {});

test('quoteUrl links out to a price search, never a guessed deep link', () => {
  assert.equal(Companies.quoteUrl('AAPL'), 'https://www.google.com/search?q=AAPL%20stock%20price');
  assert.equal(Companies.quoteUrl('BRK.B'), 'https://www.google.com/search?q=BRK.B%20stock%20price');
  assert.ok(!Companies.quoteUrl('AAPL').includes('stooq'));
});

test('card escapes, shows ticker + HQ, and keeps the provenance note', () => {
  const html = Companies.card({ name: '<x>Co', ticker: 'X', city: 'Some&City' });
  assert.ok(!html.includes('<x>Co'));
  assert.ok(html.includes('X · HQ Some&amp;City'));
  assert.ok(html.includes('live quote search'));
  assert.ok(html.includes('no live prices fetched'));
});

test('features() emits points at HQ coordinates', () => {
  const s = Companies._state;
  s.companies = [{ name: 'A', ticker: 'AAA', city: 'C', lon: -1.5, lat: 41.0 }];
  const feats = Companies.features();
  assert.equal(feats.length, 1);
  assert.equal(feats[0].geometry.coordinates[0], -1.5);
  assert.equal(feats[0].geometry.coordinates[1], 41.0);
  s.companies = [];
});

test('the COMPANIES control, chip, seed and scripts exist in the UI', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="btn-companies"/);
  assert.match(html, /id="companies-chip"/);
  assert.match(html, /data-do="#btn-companies"/);
  assert.match(html, /js\/companies\.js/);
  const seed = JSON.parse(readFileSync(new URL('../data/companies-seed.json', import.meta.url), 'utf8'));
  assert.ok(seed.companies.length >= 60, 'curated sample should be substantial');
  const tickers = new Set();
  for (const c of seed.companies) {
    assert.ok(c.name && c.ticker && c.q, 'seed row incomplete: ' + JSON.stringify(c));
    assert.ok(!tickers.has(c.ticker), 'duplicate ticker: ' + c.ticker);
    tickers.add(c.ticker);
  }
});
