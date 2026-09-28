import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = readFileSync(new URL('../js/map-tools.js', import.meta.url), 'utf8');

test('map tools start collapsed and retain every feature control exactly once', () => {
  assert.match(html, /<details id="controls" class="map-tools">/);
  for (const id of ['air','vessels','transit','airports','events','infra','news','conflict','companies','countries','markets','terrain','wall4','sensor-mode']) {
    assert.equal(html.split(`id="btn-${id}"`).length - 1, 1, id);
  }
  assert.match(html, /js\/map-tools.js/);
});

test('Escape collapses tools and restores keyboard focus; outside click dismisses', () => {
  const handlers = {};
  let focused = false;
  const tools = { open: true, contains: target => target === 'inside' };
  runInNewContext(src, { document: {
    getElementById: id => id === 'controls' ? tools : id === 'map-tools-toggle' ? { focus: () => { focused = true; } } : null,
    addEventListener: (event, fn) => { handlers[event] = fn; },
  } });
  handlers.pointerdown({target:'inside'});
  assert.equal(tools.open, true);
  handlers.keydown({key:'Escape',stopImmediatePropagation(){}});
  assert.equal(tools.open, false);
  assert.equal(focused, true);
  tools.open = true;
  handlers.pointerdown({target:'outside'});
  assert.equal(tools.open, false);
});
