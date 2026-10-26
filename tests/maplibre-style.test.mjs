/* The vendored MapLibre build validates style properties and expressions.
 * Two shapes silently killed whole layers before: camelCase sky keys (v5
 * expects kebab-case) and "zoom" nested inside a "case" for icon-size.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const intel = readFileSync(new URL('../js/intel.js', import.meta.url), 'utf8');
const vendor = readFileSync(new URL('../vendor/maplibre-gl.js', import.meta.url), 'utf8');

test('the vendored MapLibre sky uses kebab-case keys and the app matches', () => {
  assert.ok(vendor.includes('"sky-color"'), 'vendored MapLibre should define sky-color');
  assert.match(app, /setSky\(\{\s*"sky-color":/);
  assert.doesNotMatch(app, /\bskyColor\s*:/);
  assert.doesNotMatch(app, /\bhorizonColor\s*:/);
  assert.doesNotMatch(app, /\bfogColor\s*:/);
});

test('aircraft icon-size keeps zoom at the top level of interpolate', () => {
  const block = intel.slice(intel.indexOf('"icon-size": ["interpolate", ["linear"], ["zoom"]'), intel.indexOf('"icon-rotate"'));
  assert.ok(block.length > 0, 'aircraft icon-size interpolation is missing');
  // A "case" may appear in the output stops, never around the zoom input.
  assert.doesNotMatch(block, /\[\s*"case"[^\]]*\[\s*"zoom"/);
});
