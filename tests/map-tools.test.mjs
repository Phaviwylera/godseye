/* The globe used to carry three wrapping button rows. They now live in one
 * arrow-expandable MAP TOOLS panel grouped by purpose: collapsed by default, the
 * active-tool count on the toggle, the camera registry's own collapse button
 * untouched, and the zoom pair the only thing still floating on the map.
 *
 * These assertions are the contract that stops the rows creeping back over the
 * globe (and that stops a future edit from orphaning a control).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');

const panelHtml = html.slice(html.indexOf('<div id="map-tools"'), html.indexOf('<section id="contacts-panel"'));
const groupHtml = (name) => {
  const at = panelHtml.indexOf(`<h4 id="tg-${name}">`);
  const from = panelHtml.lastIndexOf("<section", at);
  return panelHtml.slice(from, panelHtml.indexOf("</section>", at));
};
const TOOL_IDS = [
  // VIEW
  "btn-sensor-mode", "btn-night", "btn-fx", "btn-terrain", "btn-buildings",
  // PLAYBACK
  "btn-wall4", "btn-wall6", "btn-wall9", "btn-wall-custom", "btn-fav", "btn-route",
  // LIVE LAYERS
  "btn-air", "btn-vessels", "btn-transit", "btn-airports", "btn-quakes",
  // WORLD LAYERS
  "btn-events", "btn-news", "btn-conflict", "btn-markets", "btn-infra", "btn-companies", "btn-countries",
  // WEATHER & SPACE
  "btn-radar", "btn-iss", "btn-satellites", "btn-iss-passes",
  // MAP
  "btn-sync", "btn-share-scene", "btn-home", "btn-context-view",
];

test('every control lives inside the Map tools panel', () => {
  assert.ok(panelHtml.length > 1500, 'the panel should hold the controls');
  for (const id of TOOL_IDS) {
    assert.ok(panelHtml.includes(`id="${id}"`), `${id} must live in the Map tools panel`);
  }
  assert.ok(panelHtml.includes('id="styles"'), 'basemap choices belong to the panel too');
  assert.ok(panelHtml.includes('id="intel-row"'), 'layer status chips belong to the panel too');
  assert.ok(panelHtml.includes('id="radar-ctl"'), 'the radar scrubber belongs to the panel too');
  // …and the buttons are nowhere else in the document.
  assert.equal(html.indexOf(`id="${TOOL_IDS[0]}"`), html.indexOf(`id="${TOOL_IDS[0]}"`, html.indexOf('<div id="map-tools"')));
});

test('the panel is grouped by purpose, one section per job', () => {
  const headings = [...panelHtml.matchAll(/<h4 id="tg-[\w-]+"><span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(headings, ["VIEW", "PLAYBACK", "LIVE LAYERS", "WORLD LAYERS", "WEATHER &amp; SPACE", "MAP", "STATUS"]);
  const inGroup = (name) => groupHtml(name);
  for (const id of ["btn-air", "btn-vessels", "btn-transit", "btn-airports", "btn-quakes"]) {
    assert.ok(inGroup("live").includes(`id="${id}"`), `${id} belongs to LIVE LAYERS`);
  }
  for (const id of ["btn-events", "btn-markets", "btn-infra", "btn-news", "btn-conflict", "btn-companies", "btn-countries"]) {
    assert.ok(inGroup("world").includes(`id="${id}"`), `${id} belongs to WORLD LAYERS`);
  }
  for (const id of ["btn-radar", "btn-iss", "btn-satellites", "btn-iss-passes"]) {
    assert.ok(inGroup("space").includes(`id="${id}"`), `${id} belongs to WEATHER & SPACE`);
  }
  assert.ok(inGroup("view").includes('id="btn-buildings"'));
  for (const id of ["btn-sensor-mode", "btn-terrain", "btn-night", "btn-fx"]) {
    assert.ok(inGroup("view").includes(`id="${id}"`), `${id} belongs to VIEW`);
  }
});

test('the panel starts collapsed and the arrow carries the active-tool count', () => {
  assert.match(html, /<div id="map-tools" class="collapsed">/);
  assert.match(html, /id="map-tools-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="map-tools-panel" class="hidden"/);
  assert.match(panelHtml, /class="mt-arrow"[^>]*>▸</);
  assert.match(panelHtml, /id="map-tools-count"/);
  assert.match(panelHtml, /id="map-tools-close"/);
});

test('only the zoom pair floats on the map', () => {
  assert.doesNotMatch(html, /id="controls"/, 'the old wrapping row container is gone');
  const zoomAt = html.indexOf('<div id="zoomctl">');
  const zoomBlock = html.slice(zoomAt, html.indexOf("</div>", zoomAt));
  assert.equal((zoomBlock.match(/<button/g) || []).length, 2, 'zoom in / zoom out only');
  // No file may still style or address the removed container.
  for (const [name, text] of [["css/style.css", css], ["js/app.js", app]]) {
    assert.doesNotMatch(text, /#controls\b/, `${name} still references #controls`);
  }
  // The camera registry keeps its own collapse button, outside the panel.
  assert.ok(!panelHtml.includes('id="panel-toggle"'));
  assert.match(html, /id="panel-toggle"[^>]*>◀</);
});

test('the collapsed chip counts live layers, not view settings', () => {
  // data-layer marks the buttons that put data on the globe; basemap/terrain/FX
  // are view settings and must not make the badge look permanently active.
  const panels = panelHtml;
  for (const id of ["btn-air", "btn-vessels", "btn-transit", "btn-airports", "btn-quakes",
    "btn-events", "btn-news", "btn-conflict", "btn-markets", "btn-infra", "btn-companies",
    "btn-countries", "btn-radar", "btn-iss", "btn-satellites", "btn-iss-passes"]) {
    assert.match(panels, new RegExp(`<button id="${id}" data-layer`), `${id} must be marked data-layer`);
  }
  for (const id of ["btn-terrain", "btn-fx", "btn-night", "btn-buildings", "btn-sensor-mode", "btn-sync"]) {
    assert.doesNotMatch(panels, new RegExp(`<button id="${id}" data-layer`), `${id} is a view setting, not a layer`);
  }
  const wire = app.slice(app.indexOf("const syncCount = ()"), app.indexOf("toggle.onclick"));
  assert.match(wire, /button\[data-layer\]/);
  assert.match(wire, /aria-pressed/);
});

test('the panel is wired: toggle, keyboard, persistence, count, click-away', () => {
  const wire = app.slice(app.indexOf("function wireMapTools()"), app.indexOf("// --------------------------------------------------------------- controls --"));
  assert.ok(wire.includes('$("#map-tools-toggle")'));
  assert.ok(wire.includes("localStorage.setItem(\"ge_tools_open\""));
  assert.ok(wire.includes('e.key.toLowerCase() === "m"'));
  assert.ok(wire.includes('e.key === "Escape"'));
  assert.ok(wire.includes("new MutationObserver(syncCount)"));
  assert.ok(wire.includes('pointerdown'));
  assert.ok(app.includes("wireMapTools();"), "wireUI must wire the panel on boot");
});

test('the phone FAB still mirrors every layer toggle in the panel', () => {
  const fab = html.slice(html.indexOf('<div id="fab-sheet"'), html.indexOf("</div>", html.indexOf('data-do="#panel-toggle"')));
  for (const id of TOOL_IDS) {
    assert.ok(fab.includes(`data-do="#${id}"`), `the FAB sheet must still reach ${id} on a phone`);
  }
});

test('styles give the panel a scroll bound and hide it where the FAB takes over', () => {
  assert.match(css, /#map-tools-panel\s*\{[^}]*max-height/);
  assert.match(css, /#map-tools-panel\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /body\.map-unavailable #map-tools\s*\{\s*display:\s*none/);
  const tablet = css.slice(css.indexOf("@media (max-width: 1100px) and (min-width: 761px)"));
  assert.match(tablet.slice(0, tablet.indexOf("\n}")), /#map-tools\s*\{\s*display:\s*none/);
  // The one-handed layout keeps its FAB sheet, and the panel is not on screen there.
  const phoneAt = css.indexOf("@media (max-width: 760px) {\n  #fab { display: block; }");
  assert.ok(phoneAt > -1, "the FAB breakpoint must exist");
  const phone = css.slice(phoneAt, css.indexOf("\n}", phoneAt));
  assert.match(phone, /#map-tools\s*\{\s*display:\s*none/);
});
