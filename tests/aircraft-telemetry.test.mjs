import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function buildIntel(payload) {
  const sources = new Map(), layers = new Map(), images = new Map();
  const drawing = {
    translate() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {}, fillRect() {},
    getImageData(x, y, width, height) { return { width, height }; },
  };
  const map = {
    getSource: id => sources.get(id),
    addSource(id) { sources.set(id, { setData() {} }); },
    hasImage: () => true,
    addImage: (id, data, options) => images.set(id, { data, options }),
    getLayer: id => layers.get(id),
    addLayer: layer => layers.set(layer.id, layer),
    setLayoutProperty() {}, on() {}, easeTo() {},
    getCenter: () => ({ lat: 13.08, lng: 80.27 }), getZoom: () => 8,
  };
  const chip = { classList: { remove() {}, add() {} }, textContent: '', title: '' };
  const context = {
    URL, window: {}, document: {
      createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => drawing }),
      getElementById: id => id === 'air-chip' ? chip : null,
    },
    Sources: { fetchJSON: () => Promise.resolve(payload) },
    Contacts: { close() {}, open() {} }, setInterval, clearInterval, setTimeout, clearTimeout,
  };
  const Intel = runInNewContext(readFileSync(new URL('../js/intel.js', import.meta.url), 'utf8') + '\nIntel;', context);
  Intel.init(map);
  return { Intel, drawing, map };
}

test('nearestAirport resolves the closest hub for aircraft positions', () => {
  const { Intel } = buildIntel({ ac: [] });
  const chennai = Intel.nearestAirport(80.27, 13.08);
  assert.equal(chennai.code, 'MAA');
  assert.ok(chennai.km < 40, `expected MAA within 40km, got ${chennai.km}`);
  const london = Intel.nearestAirport(-0.46, 51.47);
  assert.equal(london.code, 'LHR');
  const midatlantic = Intel.nearestAirport(-40, 50);
  assert.ok(midatlantic.km > 500, 'ocean positions should be far from every hub');
});

test('telemetry series maps altitude, ground and missing samples', () => {
  const { Intel } = buildIntel({ ac: [] });
  const series = Intel.airTelemetrySeries([
    { coordinates: [0, 0], time: 1, alt: 30000, gs: 410 },
    { coordinates: [1, 1], time: 2, alt: 'ground', gs: '340' },
    { coordinates: [2, 2], time: 3 },
  ]);
  // Values are created inside the eval realm, so compare structurally via JSON.
  assert.equal(JSON.stringify(series), JSON.stringify({ alt: [30000, 0, null], gs: [410, 340, null] }));
});

test('feed refresh stores per-sample telemetry and paints the popup strip', async () => {
  const { Intel, drawing } = buildIntel({ ac: [
    { hex: 'abc123', flight: 'GEE101', lat: 13.1, lon: 80.2, alt_baro: 30000,
      gs: 412, baro_rate: -640, track: 42, t: 'B738' },
  ] });
  try {
    assert.equal(Intel.toggleAir(), true);
    await new Promise(resolve => setTimeout(resolve, 20));

    const points = Intel.state.airHistory.get('abc123');
    assert.equal(points.length, 1);
    assert.equal(points[0].alt, 30000);
    assert.equal(points[0].gs, 412);

    Intel.selectAirTrack({ hex: 'abc123', callsign: 'GEE101', coordinates: [80.2, 13.1], track: 42 });
    assert.equal(JSON.stringify(Intel.airTelemetrySeries(Intel.state.airTrack.points).alt), JSON.stringify([30000]));

    const readout = { textContent: '' };
    Intel.state.airPopup = {
      hex: 'abc123',
      canvas: { width: 264, height: 56, getContext: () => drawing },
      readout,
    };
    Intel.paintAirTelemetry();
    assert.match(readout.textContent, /ALT 30,000 FT/);
    assert.match(readout.textContent, /GS 412 KT/);
    assert.match(readout.textContent, /V\/S -640 FPM/);
    assert.match(readout.textContent, /MAA \d+ KM/);
  } finally {
    Intel.state.airPopup = null;
    if (Intel.state.air) Intel.toggleAir();
  }
});

/* The aircraft feed polls a provider that rate-limits by IP, so a refused poll is normal and
 * must not empty the sky: the last good sweep stays drawn and the chip says how old it is. */
test('a failed aircraft poll holds the last good sweep instead of emptying the sky', async () => {
  const sources = new Map(), layers = new Map(), images = new Map();
  const drawing = {
    translate() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {}, fillRect() {},
    getImageData(x, y, width, height) { return { width, height }; },
  };
  const map = {
    getSource: id => sources.get(id),
    addSource(id) { sources.set(id, { setData() {} }); },
    hasImage: () => true,
    addImage: (id, data, options) => images.set(id, { data, options }),
    getLayer: id => layers.get(id),
    addLayer: layer => layers.set(layer.id, layer),
    setLayoutProperty() {}, on() {}, easeTo() {},
    getCenter: () => ({ lat: 13.08, lng: 80.27 }), getZoom: () => 8,
  };
  const chip = { classList: { remove() {}, add() {} }, textContent: '', title: '' };
  let failing = false;
  const calls = [];
  const context = {
    URL, window: {}, document: {
      createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => drawing }),
      getElementById: id => id === 'air-chip' ? chip : null,
    },
    Sources: { fetchJSON: (url, windowSec) => {
      calls.push({ url, windowSec });
      if (failing) return Promise.reject(new Error('429 too many requests'));
      return Promise.resolve({ ac: [{ hex: 'abc123', flight: 'GEE101', lat: 13.1, lon: 80.2,
        alt_baro: 30000, gs: 412, baro_rate: -640, track: 42 }] });
    } },
    Contacts: { close() {}, open() {} }, setInterval, clearInterval, setTimeout, clearTimeout,
  };
  const Intel = runInNewContext(readFileSync(new URL('../js/intel.js', import.meta.url), 'utf8')
    + '\nIntel;', context);
  Intel.init(map);
  try {
    Intel.toggleAir();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(Intel.state.airFeatures.length, 1, 'the first poll drew an aircraft');
    assert.ok(calls.every(call => call.windowSec === 20),
      'every poll asks the relay to share its answer for the window');

    failing = true;
    await Intel.fetchAirData().catch(error => Intel.showAirError(error));
    assert.equal(Intel.state.airFeatures.length, 1, 'a refused poll does not clear the layer');
    assert.match(chip.textContent, /HELD/, 'and the chip says the sweep is being held');
    assert.match(chip.title, /429 too many requests/, 'with the provider’s own reason');
    assert.match(chip.textContent, /HELD \d+S|HELD \d+ MIN|HELD [\d.]+ H/);
    assert.doesNotMatch(chip.textContent, /UNAVAILABLE/, 'the feed did respond earlier');

    failing = false;
    await Intel.fetchAirData();
    assert.doesNotMatch(chip.textContent, /HELD|UNAVAILABLE/, 'a good poll clears the held state');
  } finally {
    if (Intel.state.air) Intel.toggleAir();
  }
});
