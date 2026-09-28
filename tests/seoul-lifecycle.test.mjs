/* Headless lifecycle harness for the quota-limited Seoul feed.
 *
 * The real module runs against a stubbed fetch, the real data/transit.json (filtered to the
 * Seoul feed), the real bundled station table and an advancable clock, so the whole story is
 * exercised rather than re-implemented: first sweep, budgeted silence, the operator's daily
 * cap, an hour of failures, expiry, recovery, and teardown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const registryFile = JSON.parse(readFileSync(new URL('../data/transit.json', import.meta.url), 'utf8'));
const stationFile = JSON.parse(readFileSync(new URL('../data/kr-stations.json', import.meta.url), 'utf8'));
const seoul = registryFile.feeds.find((f) => f.id === 'seoul-metro');
const LINES = seoul.lines.map((l) => String(l.id));

/* Real, unambiguous stations straight out of the bundled table, so nothing is resolved by guess. */
const STATIONS = Object.keys(stationFile.stations)
  .filter((name) => !stationFile.ambiguous.includes(name))
  .slice(0, 5);

const START = Date.parse('2026-09-28T00:00:00.000Z');
const TRAINS_PER_LINE = 5;                 // the sample key caps at five trains per line

/* recptnDt is KST wall clock with no zone marker. */
function kst(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function linePayload(lineId, at, count = TRAINS_PER_LINE) {
  return {
    status: 500, code: 'INFO-000', message: '성공',
    realtimePositionList: STATIONS.slice(0, count).map((name, i) => ({
      subwayId: lineId, subwayNm: lineId, trainNo: `${lineId}-${i}`,
      statnNm: name, statnTnm: STATIONS[0], recptnDt: kst(at),
      trainSttus: '1', directAt: '0', lstcarAt: '0',
    })),
  };
}

function makeHarness({ fail = null, now = START } = {}) {
  const state = { now };
  const RealDate = Date;
  class Clock extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(state.now); }
    static now() { return state.now; }
  }
  const calls = [];
  let failWith = fail;
  let staleMs = 0;                    // how old the operator's own report claims to be

  const fetchImpl = async (url) => {
    const target = String(url);
    const json = (body, ok = true) => ({
      ok, status: ok ? 200 : 502,
      json: async () => body, text: async () => JSON.stringify(body),
    });
    if (target.startsWith('data/transit.json')) {
      return json({ feeds: registryFile.feeds.filter((f) => f.id === 'seoul-metro') });
    }
    if (target.startsWith('data/kr-stations.json')) return json(stationFile);
    if (target === '/api/transit/seoul') {
      calls.push({ target, at: state.now });
      const lines = Object.fromEntries(LINES.map((lineId) => [lineId,
        failWith
          ? { data: { errorMessage: { code: failWith, message: '요청 한도 초과' } } }
          : { data: linePayload(lineId, state.now - staleMs) }]));
      return json({ lines });
    }
    return json({ error: 'unexpected ' + target }, false);
  };

  const sources = new Map();
  const layers = new Map();
  const images = new Map();
  const drawing = {
    translate() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {}, fillRect() {}, shadowColor: '', shadowBlur: 0, fillStyle: '', strokeStyle: '', lineWidth: 0,
    getImageData(x, y, width, height) { return { width, height }; },
  };
  const map = {
    getSource: (id) => sources.get(id),
    addSource(id, spec) { sources.set(id, { spec, data: null, setData(d) { this.data = d; } }); },
    removeSource(id) { sources.delete(id); },
    hasImage: () => true,
    addImage: (id, data, options) => images.set(id, { data, options }),
    getLayer: (id) => layers.get(id),
    addLayer: (layer) => layers.set(layer.id, layer),
    removeLayer: (id) => layers.delete(id),
    setLayoutProperty() {}, on() {}, getCanvas: () => ({ style: {} }),
    getCenter: () => ({ lng: 126.978, lat: 37.5665 }), getZoom: () => 11,
  };
  const chip = { classList: { add() {}, remove() {}, toggle() {} }, textContent: '', title: '' };
  const button = { classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {} };
  const context = {
    Date: Clock, URL, console,
    window: {}, maplibregl: { Popup: class { setLngLat() { return this; } setDOMContent() { return this; } addTo() { return this; } } },
    document: {
      createElement: () => ({ width: 0, height: 0, style: {}, append() {}, getContext: () => drawing }),
      getElementById: (id) => (id === 'transit-chip' ? chip : id === 'btn-transit' ? button : null),
    },
    Contacts: { close() {}, open() {} },
    fetch: fetchImpl,
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
  };
  const Transit = runInNewContext(
    readFileSync(new URL('../js/transit.js', import.meta.url), 'utf8') + '\nTransit;', context);

  const drawn = () => (sources.get('transit-vehicles')?.data?.features) || [];
  /* toggle() fires its own refresh without awaiting it; let it land before asserting on it,
     otherwise the first explicit sweep would be the app's second and every count doubles. */
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    Transit, map, chip, calls, drawn, settle,
    advance: (ms) => { state.now += ms; },
    failNext: (code) => { failWith = code; },
    heal: () => { failWith = null; },
    staleBy: (ms) => { staleMs = ms; },
  };
}

test('a sweep reads every line once, then the budget keeps it silent while the map stays drawn', async () => {
  const h = makeHarness();
  h.Transit.init(h.map);
  assert.equal(await h.Transit.toggle(), true);
  await h.settle();

  assert.equal(h.calls.length, 1, 'the first sweep is one bounded browser-to-relay batch call');
  const expected = LINES.length * TRAINS_PER_LINE;
  assert.equal(h.drawn().length, expected, `${expected} trains drawn from the real station table`);
  assert.match(h.chip.textContent, new RegExp(`${expected} VEHICLES · 1/1 NETWORKS`));
  assert.equal(h.calls[0].target, '/api/transit/seoul', 'no caller-controlled URL or key reaches the batch endpoint');

  // One minute later nothing is due: zero upstream calls, same trains, an age the user can read.
  h.advance(60_000);
  const before = h.calls.length;
  await h.Transit.refresh();
  assert.equal(h.calls.length - before, 0, 'a sweep inside the budget must cost nothing');
  assert.equal(h.drawn().length, expected, 'and the trains stay on the map');
  assert.equal(TransitAge(h, 0), '1 min ago');
  assert.doesNotMatch(h.chip.title, /held/, 'nothing failed, so nothing is held');
});

function TransitAge(h, index) {
  const feature = h.drawn()[index];
  const seconds = feature.properties.age;
  if (seconds < 45) return 'just now';
  if (seconds < 90) return '1 min ago';
  return `${Math.round(seconds / 60)} min ago`;
}

test('the daily cap holds the last good sweep and reports the reason and its age', async () => {
  const h = makeHarness();
  h.Transit.init(h.map);
  await h.Transit.toggle();
  await h.settle();
  const expected = LINES.length * TRAINS_PER_LINE;
  assert.equal(h.drawn().length, expected);

  h.failNext('INFO-300');
  h.advance(seoul.budgetSec * 1000);          // every line is due again
  const before = h.calls.length;
  await h.Transit.refresh();

  assert.equal(h.calls.length - before, 1, 'all lines are retried through one function invocation');
  assert.equal(h.drawn().length, expected, 'the fleet does not vanish because the key ran out');
  assert.match(h.chip.title, /held \(daily request limit reached\)/, 'the reason is the operator’s own');
  assert.match(h.chip.title, /25 min ago/, 'and so is the age of what is being shown');
  assert.doesNotMatch(h.chip.textContent, /UNAVAILABLE/);

  // A dead key must not be able to advertise a fresh fleet: the rows age, they are not refreshed.
  h.advance(10 * 60_000);
  await h.Transit.refresh();
  assert.match(h.chip.title, /held \(daily request limit reached\) · 35 min ago/);
});

test('an hour of failures expires the held rows to an honest TRANSIT FEEDS UNAVAILABLE', async () => {
  const h = makeHarness();
  h.Transit.init(h.map);
  await h.Transit.toggle();
  await h.settle();
  h.failNext('ERROR-337');

  for (let minute = 0; minute <= 60; minute++) {
    h.advance(60_000);
    await h.Transit.refresh();                 // the app's own 60 s tick
  }
  assert.equal(h.drawn().length, 0, 'nothing survives past maxAgeSec');
  assert.equal(h.chip.textContent, '◇ TRANSIT FEEDS UNAVAILABLE');
  assert.match(h.chip.title, /Seoul/, 'the reason is still named');
});

test('a dead key is not hammered, and it comes back on the first sweep after the key resets', async () => {
  const h = makeHarness();
  h.Transit.init(h.map);
  await h.Transit.toggle();
  await h.settle();
  const first = h.calls.length;
  h.failNext('INFO-300');

  // 30 minutes of 60 s ticks with a dead key: the backoff must keep this well under budget.
  for (let minute = 0; minute < 30; minute++) { h.advance(60_000); await h.Transit.refresh(); }
  const whileDead = h.calls.length - first;
  assert.ok(whileDead <= 2,
    `${whileDead} batch requests in 30 minutes of failure is more than the backoff allows`);

  h.heal();
  h.advance(seoul.pollSec * 1000);
  await h.Transit.refresh();
  assert.equal(h.drawn().length, LINES.length * TRAINS_PER_LINE, 'the fleet is back in one sweep');
  assert.doesNotMatch(h.chip.title, /held/);
});

test('a report older than maxAgeSec is refused rather than drawn', async () => {
  const h = makeHarness();
  h.Transit.init(h.map);
  await h.Transit.toggle();
  await h.settle();
  assert.equal(h.drawn().length, LINES.length * TRAINS_PER_LINE);

  // The operator answers, but with a 30-minute-old report: inside maxAgeSec, so it is honest
  // to keep drawing it — and the chip must not claim it is live.
  h.staleBy(30 * 60_000);
  h.advance(seoul.budgetSec * 1000);
  await h.Transit.refresh();
  assert.equal(h.drawn().length, LINES.length * TRAINS_PER_LINE, 'a 30-minute-old report is still inside maxAgeSec');

  // Now a 50-minute-old report, past maxAgeSec (40 min): refused, not drawn.
  h.staleBy(50 * 60_000);
  h.advance(seoul.budgetSec * 1000);
  await h.Transit.refresh();
  assert.equal(h.drawn().length, 0, 'a 50-minute-old position is not a live train');
  assert.equal(h.chip.textContent, '◇ TRANSIT FEEDS UNAVAILABLE');
  assert.equal(h.chip.title, 'Seoul: nothing reported right now',
    'the feed answered but every report is too old: that is what is said, not a network fault');
});

test('teardown removes every source and layer the feed added', async () => {
  const h = makeHarness();
  h.Transit.init(h.map);
  await h.Transit.toggle();
  await h.settle();
  assert.ok(h.map.getSource('transit-vehicles'), 'the layer exists while it is on');
  await h.Transit.toggle();
  assert.equal(h.map.getSource('transit-vehicles'), undefined, '0 sources left');
  assert.equal(h.map.getSource('transit-stations'), undefined, '0 sources left');
  assert.equal(h.map.getLayer('transit-vehicles'), undefined, '0 layers left');
  assert.equal(h.drawn().length, 0);
});
