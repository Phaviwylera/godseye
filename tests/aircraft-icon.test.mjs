import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('aircraft uses a visible custom sprite even when a base style has a plane image', () => {
  const sources = new Map(), layers = new Map(), images = new Map();
  const strokes = [], fills = [];
  const drawing = {
    translate() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() { fills.push(this.fillStyle); }, stroke() { strokes.push(this.strokeStyle); },
    fillRect() {}, getImageData(x, y, width, height) { return { width, height }; },
  };
  const map = {
    getSource: id => sources.get(id),
    addSource: (id) => sources.set(id, { setData() {} }),
    hasImage: id => id === 'plane' || images.has(id),
    addImage: (id, data, options) => images.set(id, { data, options }),
    getLayer: id => layers.get(id),
    addLayer: layer => layers.set(layer.id, layer),
    setLayoutProperty() {}, on() {}, getCenter: () => ({ lat: 13.08, lng: 80.27 }), getZoom: () => 3,
  };
  const chip = { classList: { remove() {}, add() {} }, textContent: '' };
  const context = {
    URL, window: {}, document: {
      createElement: () => ({ width: 0, height: 0, getContext: () => drawing }),
      getElementById: id => id === 'air-chip' ? chip : null,
    },
    Sources: { fetchJSON: () => new Promise(() => {}) },
    Contacts: { close() {} }, setInterval, clearInterval, setTimeout, clearTimeout,
  };
  const Intel = runInNewContext(readFileSync(new URL('../js/intel.js', import.meta.url), 'utf8') + '\nIntel;', context);
  Intel.init(map);
  assert.equal(Intel.toggleAir(), true);
  const sprite = images.get('ge-aircraft-teal-v3');
  assert.equal(sprite.data.width, 64);
  assert.equal(sprite.options.pixelRatio, 2);
  assert.ok(fills.includes('#69ffe0'));
  assert.ok(strokes.includes('#e6fff8'));
  assert.equal(layers.get('air-dots').layout['icon-image'], 'ge-aircraft-teal-v3');
  assert.equal(Intel.toggleAir(), false);
});
