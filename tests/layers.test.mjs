/* Layer links are a product promise: a shared view should reopen the same
 * persistent layers, and a foreign link should degrade to the layers we know
 * instead of turning random buttons on. These tests pin that contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/layers.js', import.meta.url), 'utf8');
const Layers = runInNewContext(source + '\nLayers;', {});
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

const inRealm = (value) => JSON.parse(JSON.stringify(value));

test('layer links parse, aliases resolve and unknown names are ignored', () => {
  assert.deepEqual(inRealm(Layers.parse('?layers=quakes,news,aurora')),
    ['quakes', 'news', 'aurora']);
  assert.deepEqual(inRealm(Layers.parse('?layers=earthquakes,day_night,cables')),
    ['quakes', 'infra', 'day-night']);
  assert.deepEqual(inRealm(Layers.parse('?layers=maritime,sdk_air,live_news,global_incidents')),
    ['air', 'ships', 'news', 'hazards']);
  // Publisher or hand-typed noise is dropped, not guessed into a layer.
  assert.deepEqual(inRealm(Layers.parse('?layers=nope,gps_jamming,,cctv')), []);
  assert.deepEqual(inRealm(Layers.parse('?layers=quakes,quakes')), ['quakes']);
  assert.deepEqual(inRealm(Layers.parse('')), []);
  assert.deepEqual(inRealm(Layers.parse(null)), []);
  // A malformed escape must not throw the page away.
  assert.deepEqual(inRealm(Layers.parse('?layers=%E0%A4%A,quakes')), ['quakes']);
});

test('layer queries are canonical, ordered and omit an empty set', () => {
  assert.equal(Layers.query(['aurora', 'quakes', 'news']), 'quakes,news,aurora');
  assert.equal(Layers.query(['earthquakes', 'maritime']), 'ships,quakes');
  assert.equal(Layers.query(['nope', '']), '');
  assert.equal(Layers.query([]), '');
  assert.equal(Layers.query(null), '');
  // A round-trip through the link shape returns the same canonical list.
  assert.deepEqual(inRealm(Layers.parse('?layers=' + Layers.query(['aurora', 'quakes']))),
    ['quakes', 'aurora']);
});

test('every layer names a real persistent button and has a readable label', () => {
  for (const layer of Layers.LIST) {
    assert.match(html, new RegExp('id="' + layer.id + '"'), layer.slug + ' is missing from the shell');
    assert.ok(layer.label && layer.label.length > 2, layer.slug + ' needs a label');
    assert.equal(Layers.resolve(layer.slug).slug, layer.slug);
    assert.equal(Layers.label(layer.slug), layer.label);
    assert.equal(Layers.fromId(layer.id).slug, layer.slug);
  }
  // The ISS-pass card is a modal, not a persistent layer: a shared link must
  // not silently reopen a dialog.
  assert.equal(Layers.resolve('iss-passes'), null);
  assert.equal(Layers.fromId('btn-iss-passes'), null);
});

test('the shell restores linked layers through the real buttons', () => {
  assert.match(html, /js\/layers\.js/);
  assert.ok(app.includes('function activeLayerSlugs()'));
  assert.ok(app.includes('function restoreLayersFromURL()'));
  assert.ok(app.includes('function wireLayerURLSync()'));
  assert.ok(app.includes('Layers.parse(location.search)'));
  assert.ok(app.includes('button.click()'));
  assert.ok(app.includes('restoreLayersFromURL();'));
  // Scene sharing and the address bar both carry the active set.
  assert.ok(app.includes('layers ? "layers=" + layers : ""'));
  assert.ok(app.includes('"&layers=" + layers'));
  // A restore must not rewrite the link before the slow layers settle.
  assert.ok(app.includes('restoringLayers = true'));
});
