import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/palette.js', import.meta.url), 'utf8');
const Palette = runInNewContext(source + '\nPalette;', {});
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');

const inRealm = (x) => JSON.parse(JSON.stringify(x));

test('score prefers exact, then prefix, then substring, then subsequence', () => {
  assert.ok(Palette.score('Layers', 'layers') > Palette.score('World layers', 'layers'));
  assert.ok(Palette.score('World layers', 'world') > Palette.score('World layers', 'ayers'));
  assert.ok(Palette.score('World layers', 'ayers') > Palette.score('World layers', 'wlrs'));
  assert.equal(Palette.score('World layers', 'zzz'), -1);
  assert.equal(Palette.score('World layers', ''), 1);
  // A scattered subsequence in a long description is not a match.
  assert.equal(Palette.score('active storm warnings and named volcanoes', 'compact'), -1);
});

test('rank filters non-matches and keeps the first result relevant', () => {
  const rows = [
    { label: 'Keyboard shortcuts' },
    { label: 'Near me' },
    { label: 'Hazards layer' },
    { label: 'No match here', keywords: 'hidden' },
  ];
  const found = Palette.rank(rows, 'near');
  assert.equal(found.length, 1);
  assert.equal(found[0].label, 'Near me');
  assert.equal(Palette.rank(rows, 'zzzz').length, 0);
  assert.equal(Palette.rank(rows, 'hidden')[0].label, 'No match here');
});

test('coordinate search is lat, lon and rejects impossible points', () => {
  assert.deepEqual(inRealm(Palette.coordTarget('13.08, 80.27')), { lat: 13.08, lon: 80.27 });
  assert.deepEqual(inRealm(Palette.coordTarget('-33.9 151.2')), { lat: -33.9, lon: 151.2 });
  assert.equal(Palette.coordTarget('91, 10'), null);
  assert.equal(Palette.coordTarget('10, 181'), null);
  assert.equal(Palette.coordTarget('not coordinates'), null);
});

test('the palette and keyboard sheet exist and are wired', () => {
  assert.match(html, /id="palette"/);
  assert.match(html, /id="palette-input"/);
  assert.match(html, /id="palette-results"/);
  assert.match(html, /js\/palette\.js/);
  assert.match(html, /id="shortcuts"/);
  assert.match(html, /id="shortcuts-close"/);
  assert.match(html, /id="btn-palette"/);
  assert.ok(source.includes('e.ctrlKey || e.metaKey') && source.includes('"k"'));
  assert.ok(source.includes('e.key === "/"'));
  assert.ok(source.includes('e.key === "?"'));
});

test('the palette is initialised with real app callbacks', () => {
  assert.ok(app.includes('Palette.init('));
  for (const hook of ['getMap', 'getCameras', 'openCamera', 'shareScene', 'toggleDensity', 'toggleMotion']) {
    assert.ok(app.includes(hook), `palette hook ${hook} must be supplied`);
  }
  assert.match(app, /densityState:/);
  assert.match(app, /motionState:/);
});

test('feed paging and near-me controls are wired', () => {
  assert.match(html, /id="m-prev"/);
  assert.match(html, /id="m-next"/);
  assert.match(html, /id="btn-near-me"/);
  assert.ok(app.includes('function stepCam(delta)'));
  assert.ok(app.includes('stepCam(e.key === "ArrowRight" ? 1 : -1)'));
  assert.ok(app.includes('function nearMe()'));
  assert.ok(app.includes('navigator.geolocation.getCurrentPosition'));
  assert.ok(app.includes('el.mPrev.onclick'), 'previous button must call stepCam');
  assert.ok(app.includes('el.mNext.onclick'), 'next button must call stepCam');
  // Geolocation must not be persisted or appended to a URL.
  const near = app.slice(app.indexOf('function nearMe()'), app.indexOf('function dotClass(c)'));
  assert.doesNotMatch(near, /localStorage|sessionStorage|location\.search/);
});

test('compact density and reduced motion are persisted preferences', () => {
  assert.ok(app.includes('ge_density'));
  assert.ok(app.includes('ge_motion'));
  assert.match(css, /body\[data-density="compact"\]/);
  assert.match(css, /body\[data-motion="reduce"\]/);
  // Camera search is substring-only; a fuzzy subsequence would match noise.
  assert.ok(source.includes('entry.text.indexOf(q)'));
  assert.ok(!source.includes('rank(camCache'));
  // css
  assert.match(css, /#palette\.hidden/);
});
