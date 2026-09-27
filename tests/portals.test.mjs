import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('SkylineWebcams catalog page is explained as publisher-hosted without claiming playback', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/regions/MV.json', import.meta.url), 'utf8'));
  const cam = catalog.cams.find(c => c.name === 'Dhonakulhi Island');
  assert.equal(cam.stype, 'embed');
  assert.equal(cam.stream, cam.page);
  const context = {
    URL, window: { GE_CAMS: {} },
    document: { createElement: () => ({ style: {}, innerHTML: '' }) },
  };
  const Players = runInNewContext(readFileSync(new URL('../js/players.js', import.meta.url), 'utf8') + '\nPlayers;', context);
  const container = { children: [], innerHTML: '', appendChild(node) { this.children.push(node); } };
  Players.mount(cam, container);
  const html = container.children[0].innerHTML;
  assert.match(html, /SKYLINEWEBCAMS · PUBLISHER PAGE/);
  assert.match(html, /No authorized playable stream is supplied/);
  assert.match(html, /VIEW ON SKYLINEWEBCAMS/);
  assert.match(html, /href="https:\/\/www\.skylinewebcams\.com\/en\/webcam\/maldives\//);
  assert.doesNotMatch(html, /<video|<iframe|PLAYING NOW/);
});
