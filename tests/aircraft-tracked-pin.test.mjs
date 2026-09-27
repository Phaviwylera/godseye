import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('selected aircraft renders a large teal pin, waypoint dots, labels and a dashed hour trail', () => {
  const sources = new Map(), data = new Map(), layers = new Map(), order = [], images = new Map();
  const now = Date.now();
  const drawing = {
    translate() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {}, fillRect() {}, getImageData(x, y, width, height) { return { width, height }; },
  };
  const map = {
    getSource: id => sources.get(id),
    addSource(id, spec) {
      const src = { setData(payload) { data.set(id, payload); } };
      sources.set(id, src);
      data.set(id, spec.data);
      return src;
    },
    getLayer: id => layers.get(id),
    addLayer(layer) { layers.set(layer.id, layer); order.push(layer.id); },
    hasImage: id => images.has(id),
    addImage: (id, payload, options) => images.set(id, { data: payload, options }),
    setLayoutProperty() {}, on() {}, easeTo() {},
    getCenter: () => ({ lat: 13.08, lng: 80.27 }), getZoom: () => 6,
  };
  const context = {
    URL, window: {}, document: {
      createElement: () => ({ width: 0, height: 0, getContext: () => drawing }),
      getElementById: () => null,
    },
    Sources: { fetchJSON: () => new Promise(() => {}) },
    Contacts: { close() {}, open() {} }, setInterval, clearInterval, setTimeout, clearTimeout,
  };
  const Intel = runInNewContext(readFileSync(new URL('../js/intel.js', import.meta.url), 'utf8') + '\nIntel;', context);
  Intel.init(map);
  Intel.state.airHistory.set('abc123', [
    { coordinates: [80.0, 13.0], time: now - 2400000 },
    { coordinates: [80.1, 13.1], time: now - 1200000 },
    { coordinates: [80.2, 13.2], time: now },
  ]);
  const json = value => JSON.stringify(value);

  try {
    assert.equal(Intel.toggleAir(), true);

    // A dedicated 72px pin sprite is registered alongside the fleet icons.
    assert.equal(images.get('ge-aircraft-pin-teal').data.width, 72);
    assert.equal(images.get('ge-aircraft-pin-teal').options.pixelRatio, 2);

    const trail = layers.get('air-track-line');
    assert.equal(json(trail.paint['line-dasharray']), '[2,2]');
    const dots = layers.get('air-track-waypoint-dots');
    assert.equal(dots.type, 'circle');
    assert.equal(dots.source, 'air-track-waypoints');
    const pin = layers.get('air-tracked-pin');
    assert.equal(pin.type, 'symbol');
    assert.equal(pin.source, 'air-pin');
    assert.equal(pin.layout['icon-image'], 'ge-aircraft-pin-teal');
    // The pin is prominent but must not blanket the map.
    assert.equal(JSON.stringify(pin.layout['icon-size']), '1.2');
    assert.equal(json(pin.layout['icon-rotate']), '["get","heading"]');
    // Pin and dots must draw above the fleet icons, the way ships stack.
    assert.ok(order.indexOf('air-tracked-pin') > order.indexOf('air-dots'));
    assert.ok(order.indexOf('air-track-waypoint-dots') > order.indexOf('air-dots'));
    // The tracked fleet dot is faded out under the pin so only one marker shows.
    assert.equal(json(layers.get('air-dots').paint['icon-opacity']),
      '["case",["get","tracked"],0,1]');

    Intel.selectAirTrack({ hex: 'abc123', callsign: 'GEE101', coordinates: [80.2, 13.2], track: 42 });

    assert.equal(json(data.get('air-track').features[0].geometry.coordinates),
      json([[80.0, 13.0], [80.1, 13.1], [80.2, 13.2]]));
    assert.equal(json(data.get('air-track-waypoints').features.map(f => f.geometry.coordinates)),
      json([[80.0, 13.0], [80.1, 13.1]]));
    const pinFeatures = data.get('air-pin').features;
    assert.equal(pinFeatures.length, 1);
    assert.equal(json(pinFeatures[0].geometry.coordinates), json([80.2, 13.2]));
    assert.equal(pinFeatures[0].properties.heading, 42);
    const labels = data.get('air-track-points').features;
    assert.equal(labels.length, 2);
    assert.equal(labels[0].properties.label, 'FIRST OBSERVED');
    assert.equal(labels[1].properties.label, 'LATEST');

    // Deselecting clears the pin, dots, labels and trail.
    Intel.selectAirTrack({ hex: 'abc123', callsign: 'GEE101', coordinates: [80.2, 13.2], track: 42 });
    assert.equal(data.get('air-pin').features.length, 0);
    assert.equal(data.get('air-track-waypoints').features.length, 0);
    assert.equal(data.get('air-track-points').features.length, 0);
    assert.equal(data.get('air-track').features.length, 0);
  } finally {
    if (Intel.state.air) Intel.toggleAir();
  }
});
