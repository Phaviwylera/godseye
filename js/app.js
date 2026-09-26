/* GOD'S EYE — global CCTV grid frontend (Control Room build) */
(() => {
"use strict";

// ------------------------------------------------------------------ state --
let map, cams = [], byId = new Map(), activeId = null, idleAt = Date.now();
let currentStyle = "dark", terrainOn = true;
let wallTiles = [], wallOpen = false, wallN = 4;
const favs = new Set(JSON.parse(localStorage.getItem("ge_favs") || "[]"));
let favsOnly = localStorage.getItem("ge_favs_only") === "1";
let fxOn = localStorage.getItem("ge_fx") !== "0";
let modalHandle = null;

const $ = (s) => document.querySelector(s);
const el = {
  boot: $("#boot"), bootLog: $("#boot-log"), stCams: $("#st-cams"), stVideo: $("#st-video"),
  stZoom: $("#st-zoom"), stCursor: $("#st-cursor"), stClock: $("#st-clock"),
  q: $("#q"), geoResults: $("#geo-results"), fType: $("#f-type"), fCountry: $("#f-country"), fLive: $("#f-live"),
  stLive: $("#st-live"),
  list: $("#cam-list"), listCount: $("#list-count"), panel: $("#panel"), panelToggle: $("#panel-toggle"),
  modal: $("#modal"), player: $("#player"), mTitle: $("#m-title"), mCoords: $("#m-coords"),
  mRegion: $("#m-region"), mSrc: $("#m-src"), mClock: $("#m-clock"), mStatus: $("#m-status"),
  mAttr: $("#m-attr"), mPage: $("#m-page"), mClose: $("#m-close"),
  mStar: $("#m-star"), mLink: $("#m-link"), mCap: $("#m-cap"),
  scrub: $("#m-scrub"), scrubWrap: $("#scrub-wrap"), scrubLive: $("#m-scrub-live"),
  wall: $("#wall"), wallGrid: $("#wall-grid"), wallCount: $("#wall-count"),
  syncMsg: $("#sync-msg"),
};

// ------------------------------------------------------------------ utils --
const fmtNum = (n) => n.toLocaleString("en-US");
const TYPE_LABEL = { m3u8: "VIDEO", mp4: "MP4", mjpeg: "MJPEG", youtube: "YT-LIVE", image: "SNAP", embed: "PORTAL", dynamic: "LIVE" };

/* ---- sound fx (WebAudio, zero assets) ---- */
let actx = null;
function beep(freq, dur, when = 0, gainv = 0.05) {
  if (!fxOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "square"; o.frequency.value = freq;
    g.gain.setValueAtTime(gainv, actx.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + when + dur);
    o.connect(g).connect(actx.destination);
    o.start(actx.currentTime + when); o.stop(actx.currentTime + when + dur);
  } catch (e) {}
}
const fxLockOn = () => { beep(660, 0.07, 0); beep(990, 0.09, 0.08); };
const fxBlip = () => beep(880, 0.04, 0, 0.03);

function bootLines() {
  const lines = [
    '<span class="dim">> uplink handshake</span> … <span class="ok">OK</span>',
    '<span class="dim">> terrain mesh</span> … <span class="ok">MOUNTED</span>',
    '<span class="dim">> satellite basemap</span> … <span class="ok">LOCKED</span>',
    '<span class="dim">> public cctv registries</span> … <span class="ok">LINKED</span>',
    '<span class="dim">> control room</span> … <span class="ok">ARMED</span>',
    '<span class="dim">> god\'s eye</span> … <span class="ok">ONLINE</span>',
  ];
  let i = 0;
  const t = setInterval(() => {
    el.bootLog.insertAdjacentHTML("beforeend", lines[i] + "<br>");
    if (++i >= lines.length) clearInterval(t);
  }, 240);
  const done = () => { el.boot.classList.add("gone"); clearInterval(t); };
  el.boot.addEventListener("click", done, { once: true });
  setTimeout(done, 2000);
}

// ------------------------------------------------------------- map styles --
const ESRI_IMG = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_LBL = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const STYLE_URLS = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  streets: "https://tiles.openfreemap.org/styles/liberty",
  satellite: null,
};
const GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

function baseStyle(kind, remote) {
  let s;
  if (kind === "satellite" || !remote) {
    s = {
      version: 8, glyphs: GLYPHS,
      sources: {
        base: kind === "satellite"
          ? { type: "raster", tiles: [ESRI_IMG], tileSize: 256, maxzoom: 19,
              attribution: "Esri, Maxar, Earthstar Geographics" }
          : { type: "raster",
              tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                      "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                      "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
              tileSize: 256, maxzoom: 19, attribution: "© OpenStreetMap, © CARTO" },
      },
      layers: [{ id: "base", type: "raster", source: "base" }],
    };
    if (kind === "satellite") {
      s.sources.labels = { type: "raster", tiles: [ESRI_LBL], tileSize: 256, maxzoom: 19 };
      s.layers.push({ id: "labels", type: "raster", source: "labels" });
    }
    return s;
  }
  s = JSON.parse(JSON.stringify(remote));
  s.glyphs = s.glyphs || GLYPHS;
  return s;
}

function withTerrain(s) {
  s.sources = s.sources || {};
  s.sources.dem = {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    encoding: "terrarium", tileSize: 256, maxzoom: 15,
    attribution: "Terrain: AWS Open Data TerrariumDEM",
  };
  s.layers = s.layers || [];
  if (!s.layers.find(l => l.id === "hillshade")) {
    s.layers.push({ id: "hillshade", type: "hillshade", source: "dem",
      paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#020610",
               "hillshade-highlight-color": "#123a4a", "hillshade-accent-color": "#0a2a38" } });
  }
  return s;
}

async function loadStyle(kind) {
  const url = STYLE_URLS[kind];
  let remote = null;
  if (url) {
    try { remote = await Sources.fetchJSON(url); }
    catch (e) { console.warn("style fetch failed, using raster fallback", e); }
  }
  return withTerrain(baseStyle(kind, remote));
}

// ------------------------------------------------------------- cctv icons --
function cctvIcon(ledColor) {
  const c = document.createElement("canvas"); c.width = c.height = 48;
  const g = c.getContext("2d");
  g.shadowColor = ledColor; g.shadowBlur = 6;
  g.fillStyle = "#04101a"; g.strokeStyle = "#00f0ff"; g.lineWidth = 2.5;
  g.beginPath(); g.roundRect(8, 16, 24, 16, 3); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(32, 19); g.lineTo(41, 14); g.lineTo(41, 34); g.lineTo(32, 29); g.closePath(); g.fill(); g.stroke();
  g.shadowBlur = 10; g.fillStyle = ledColor;
  g.beginPath(); g.arc(14, 21, 2.6, 0, 7); g.fill();
  g.shadowBlur = 0; g.strokeStyle = "rgba(0,240,255,.5)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(20, 32); g.lineTo(20, 40); g.moveTo(14, 42); g.lineTo(26, 42); g.stroke();
  return g.getImageData(0, 0, 48, 48);
}

function ensureIcons() {
  if (!map.hasImage("cctv-live")) {
    map.addImage("cctv-live", cctvIcon("#2aff8b"), { pixelRatio: 2 });
    map.addImage("cctv-snap", cctvIcon("#ffb300"), { pixelRatio: 2 });
    map.addImage("cctv-portal", cctvIcon("#b78dff"), { pixelRatio: 2 });
  }
}

function addCamLayers() {
  ensureIcons();
  if (map.getLayer("cam-single")) return;
  map.addLayer({
    id: "cam-single", type: "symbol", source: "cams", filter: ["!", ["has", "point_count"]],
    layout: {
      "icon-image": ["match", ["get", "stype"], ["m3u8", "mp4", "youtube"], "cctv-live", ["image", "dynamic", "mjpeg"], "cctv-snap", "cctv-portal"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.55, 8, 0.8, 14, 1.1],
      "icon-allow-overlap": true, "icon-optional": false,
    },
  });
  map.addLayer({
    id: "cam-clusters", type: "circle", source: "cams", filter: ["has", "point_count"],
    paint: {
      "circle-color": ["step", ["get", "point_count"], "#0a3a4a", 50, "#0d5a6a", 400, "#0f7f8f"],
      "circle-radius": ["step", ["get", "point_count"], 14, 50, 18, 400, 24],
      "circle-stroke-color": "#00f0ff", "circle-stroke-width": 1.5,
      "circle-stroke-opacity": 0.7, "circle-opacity": 0.85,
    },
  });
  map.addLayer({
    id: "cam-cluster-count", type: "symbol", source: "cams", filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"], "text-font": ["Open Sans Regular"],
      "text-size": 11, "text-allow-overlap": true,
    },
    paint: { "text-color": "#00f0ff" },
  });
  map.on("click", "cam-clusters", (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ["cam-clusters"] })[0];
    if (!f) return;
    map.getSource("cams").getClusterExpansionZoom(f.properties.cluster_id)
      .then(z => map.easeTo({ center: f.geometry.coordinates, zoom: z, duration: 900 }))
      .catch(() => {});
  });
  map.on("click", "cam-single", (e) => {
    const f = e.features && e.features[0];
    if (f) openCam(f.properties.id, true);
  });
  map.on("mouseenter", "cam-single", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "cam-single", () => { map.getCanvas().style.cursor = ""; });
  map.on("mouseenter", "cam-clusters", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "cam-clusters", () => { map.getCanvas().style.cursor = ""; });
}

// ------------------------------------------------------------------- data --
function camToFeature(c) {
  return { type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: c };
}

function refreshSource() {
  const src = map.getSource("cams");
  if (src) src.setData({ type: "FeatureCollection", features: filtered().map(camToFeature) });
}

function filtered() {
  const q = el.q.value.trim().toLowerCase();
  const t = el.fType.value, co = el.fCountry.value;
  return cams.filter(c =>
    (t === "all" || c.stype === t || (t === "image" && c.stype === "dynamic")) &&
    (co === "all" || c.country === co) &&
    (!favsOnly || favs.has(c.id)) &&
    (el.fLive.value === "all" || (el.fLive.value === "live" && c.live === 1) || (el.fLive.value === "down" && c.live === 0)) &&
    (!q || (c.name + " " + (c.place || "") + " " + (c.region || "")).toLowerCase().includes(q))
  );
}

function animateNum(node, to) {
  const from = parseInt(String(node.textContent).replace(/[^\d]/g, "")) || 0;
  if (from === to) { node.textContent = fmtNum(to); return; }
  const t0 = performance.now(), dur = 700;
  (function step(t) {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    node.textContent = fmtNum(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

function updateStats() {
  animateNum(el.stCams, cams.length);
  animateNum(el.stVideo, cams.filter(c => c.stype === "m3u8" || c.stype === "mp4" || c.stype === "youtube").length);
  if (cams.some(c => c.live !== undefined)) animateNum(el.stLive, cams.filter(c => c.live === 1).length);
}

function renderList() {
  const f = filtered();
  el.listCount.textContent = fmtNum(f.length) + (favsOnly ? " ★" : "");
  const show = f.slice(0, 300);
  el.list.innerHTML = show.map(c => `
    <li data-id="${c.id}" class="${c.id === activeId ? "active" : ""}">
      <span class="dot ${c.live === 1 ? "m3u8" : c.live === 0 ? "dead" : c.stype === "m3u8" ? "m3u8" : c.status === "live" ? "live" : ""}"></span>
      <div>
        <div class="cam-name">${favs.has(c.id) ? "★ " : ""}${c.name}</div>
        <div class="cam-sub">${[c.place, c.region, c.country].filter(Boolean).join(" · ")}</div>
      </div>
      <span class="badge ${c.stype}">${TYPE_LABEL[c.stype] || c.stype}</span>
    </li>`).join("") + (f.length > 300
      ? `<li style="cursor:default;color:#51707c;font-size:10px">… +${fmtNum(f.length - 300)} more — zoom in or refine search</li>` : "");
}

async function loadBundled() {
  const g = await fetch("data/cameras.geojson").then(r => r.json());
  cams = g.features.map(f => ({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
  cams.forEach(c => byId.set(c.id, c));
  window.GE_CAMS = Object.fromEntries(byId);
  try {
    const lv = await fetch("data/liveness.json").then(r => r.ok ? r.json() : null);
    if (lv && lv.s) cams.forEach(c => { if (c.id in lv.s) c.live = lv.s[c.id]; });
  } catch (e) {}
  const countries = [...new Set(cams.map(c => c.country))].sort();
  el.fCountry.innerHTML = '<option value="all">world</option>' +
    countries.map(c => `<option value="${c}">${c}</option>`).join("");
  updateStats();
  renderList();
  refreshSource();
  // deep link ?cam=ID
  const want = new URLSearchParams(location.search).get("cam");
  if (want && byId.has(want)) setTimeout(() => openCam(want, true), 700);
}

async function mergeNew(newOnes) {
  let added = 0;
  for (const c of newOnes) {
    if (!c.lon && c.lon !== 0) continue;
    if (byId.has(c.id)) continue;
    byId.set(c.id, c); cams.push(c); added++;
  }
  if (added) { updateStats(); renderList(); refreshSource(); }
  return added;
}

// ----------------------------------------------------------- favorites -----
function saveFavs() { localStorage.setItem("ge_favs", JSON.stringify([...favs])); }
function toggleFav(id) {
  if (favs.has(id)) favs.delete(id); else { favs.add(id); fxBlip(); }
  saveFavs(); renderList(); updateStarBtn();
}
function updateStarBtn() {
  if (!activeId) return;
  el.mStar.textContent = favs.has(activeId) ? "★" : "☆";
  el.mStar.classList.toggle("on", favs.has(activeId));
}

// ---------------------------------------------------------- modal player --
function openCam(id, fly) {
  const c = byId.get(id);
  if (!c) return;
  activeId = id;
  const seen = bumpVisit(id);
  const vc = document.getElementById("m-visits");
  if (vc) vc.textContent = "watched ×" + seen;
  renderList();
  if (fly) {
    map.flyTo({
      center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 15.2), pitch: 58,
      bearing: (Math.random() * 50 - 25), duration: 2800, curve: 1.4, easing: (t) => 1 - Math.pow(1 - t, 3), essential: true,
    });
  }
  fxLockOn();
  const box = document.querySelector(".modal-box");
  box.classList.remove("sweep"); void box.offsetWidth; box.classList.add("sweep");

  el.mTitle.textContent = c.name;
  el.mCoords.textContent = `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;
  el.mRegion.textContent = [c.place, c.region, c.country].filter(Boolean).join(" · ");
  el.mSrc.textContent = "SRC " + c.src.toUpperCase();
  el.mStatus.textContent = ({ m3u8: "LIVE VIDEO", mp4: "VIDEO", youtube: "YT LIVE", mjpeg: "MJPEG LIVE", embed: "PORTAL" })[c.stype] || "LIVE FEED";
  el.mAttr.textContent = c.attr || "public feed";
  el.mPage.href = c.page || c.stream || "#";
  el.mPage.style.display = (c.page || c.stream) ? "" : "none";
  updateStarBtn();
  el.modal.classList.remove("hidden");
  Players.stop();
  modalHandle = Players.play(c, el.player, {
    onRetry: () => openCam(id, false),
    captureFrames: c.stype === "image" || c.stype === "dynamic" || c.stype === "m3u8",
    frameW: 1024,
    onFrame: (count) => {
      el.scrub.max = Math.max(0, count - 1);
      el.scrub.value = Math.max(0, count - 1);
      el.scrubWrap.classList.toggle("hidden", count <= 2);
    },
  });
  el.scrubWrap.classList.add("hidden");
  Players.startClock(el.mClock);
}

function closeModal() {
  el.modal.classList.add("hidden");
  Players.stop();
  modalHandle = null;
  activeId = null;
  renderList();
}

// ------------------------------------------------------------ video wall --
function pickWallCams(n) {
  const pool = filtered();
  if (!pool.length) return [];
  let inView = pool, center = map.getCenter();
  try {
    const b = map.getBounds();
    const vis = pool.filter(c => b.contains([c.lon, c.lat]));
    if (vis.length >= 3) inView = vis;
  } catch (e) {}
  // live video first, then spread geographically
  inView = [...inView].sort((a, b2) =>
    (b2.stype === "m3u8") - (a.stype === "m3u8") ||
    Math.hypot(a.lat - center.lat, a.lon - center.lng) - Math.hypot(b2.lat - center.lat, b2.lon - center.lng));
  const out = [], step = Math.max(1, Math.floor(inView.length / n));
  for (let i = 0; i < inView.length && out.length < n; i += step) out.push(inView[i]);
  for (const c of inView) { if (out.length >= n) break; if (!out.includes(c)) out.push(c); }
  return out;
}

function closeWall() {
  wallTiles.forEach(t => t.handle && t.handle.stop());
  wallTiles = [];
  el.wallGrid.innerHTML = "";
  el.wall.classList.add("hidden");
  wallOpen = false;
}

function openWall(n) {
  closeWall();
  wallN = n;
  const picks = pickWallCams(n);
  if (!picks.length) return;
  el.wallGrid.style.gridTemplateColumns = `repeat(${n === 4 ? 2 : 3}, 1fr)`;
  el.wallCount.textContent = `${picks.length} FEEDS // ${n === 4 ? "2×2" : n === 9 ? "3×3" : "3×2"}`;
  picks.forEach((c, i) => {
    const tile = document.createElement("div");
    tile.className = "wall-tile";
    tile.innerHTML = `
      <div class="wall-tile-head">
        <span class="wall-dot ${c.stype === "m3u8" ? "m3u8" : ""}"></span>
        <span class="wall-tile-name">${c.name}</span>
        <button class="wall-open" title="open & fly">⤢</button>
      </div>
      <div class="wall-tile-player"></div>`;
    tile.style.animationDelay = (i * 80) + "ms";
    el.wallGrid.appendChild(tile);
    const handle = Players.mount(c, tile.querySelector(".wall-tile-player"), { minimal: true, frameW: 480, captureFrames: false });
    tile.querySelector(".wall-open").onclick = () => { fxLockOn(); openCam(c.id, true); };
    wallTiles.push({ cam: c, handle });
  });
  el.wall.classList.remove("hidden");
  wallOpen = true;
  fxLockOn();
}

// ----------------------------------------------------------- frame tools --
function captureFrame() {
  if (!modalHandle) return;
  const data = modalHandle.capture();
  if (!data) {
    el.syncMsg.textContent = "⚠ capture blocked for this feed (cross-origin)";
    setTimeout(() => (el.syncMsg.textContent = ""), 3000);
    return;
  }
  const a = document.createElement("a");
  const c = byId.get(activeId) || {};
  a.download = `godseye_${(c.id || "frame")}_${Date.now()}.png`;
  a.href = data;
  a.click();
  fxBlip();
}

function wireScrub() {
  el.scrub.addEventListener("input", () => {
    if (modalHandle) modalHandle.showFrame(+el.scrub.value);
    el.scrubLive.classList.remove("hidden");
  });
  el.scrubLive.onclick = () => {
    if (modalHandle) modalHandle.resume();
    el.scrubLive.classList.add("hidden");
  };
}

// --------------------------------------------------------------- geosearch --
async function geoSearch(q) {
  if (q.length < 3) { el.geoResults.style.display = "none"; return; }
  try {
    const r = await Sources.fetchJSON(
      "https://nominatim.openstreetmap.org/search?format=json&limit=5&q=" + encodeURIComponent(q));
    if (!r.length) { el.geoResults.style.display = "none"; return; }
    el.geoResults.innerHTML = r.map(x =>
      `<div data-lat="${x.lat}" data-lon="${x.lon}">${x.display_name}</div>`).join("");
    el.geoResults.style.display = "block";
    el.geoResults.querySelectorAll("div").forEach(d => d.onclick = () => {
      map.flyTo({ center: [+d.dataset.lon, +d.dataset.lat], zoom: 12, duration: 2500, essential: true });
      el.geoResults.style.display = "none";
    });
  } catch (e) { /* offline is fine */ }
}

// --------------------------------------------------- tour / live / visits ---
const TOUR_STOPS = [
  [/times square|42nd st/i, "Times Square, New York"],
  [/las vegas/i, "The Strip, Las Vegas"],
  [/shibuya/i, "Shibuya Crossing, Tokyo"],
  [/tower bridge/i, "Tower Bridge, London"],
  [/trafalgar/i, "Trafalgar Square, London"],
  [/colosseum|coliseum/i, "Colosseum, Rome"],
  [/sydney harbour|sydney harbor/i, "Sydney Harbour"],
  [/waikiki|diamond head/i, "Waikiki, Hawaii"],
  [/miami beach|ocean dr/i, "Miami Beach"],
  [/niagara/i, "Niagara Falls"],
  [/golden gate/i, "Golden Gate, California"],
  [/gatlinburg|smoky/i, "Smoky Mountains, Tennessee"],
];

function tourStops() {
  const out = [];
  for (const [re, label] of TOUR_STOPS) {
    const c = cams.find((c) => re.test(c.name || ""));
    if (c) out.push({ cam: c, label });
  }
  const hubs = [[-73.98, 40.75], [-0.12, 51.5], [139.7, 35.68], [2.35, 48.85],
                [151.2, -33.86], [-118.24, 34.05], [-80.19, 25.76], [-157.83, 21.27]];
  for (const [lon, lat] of hubs) {
    if (out.length >= 12) break;
    let best = null, bd = 1e9;
    for (const c of cams) {
      if (c.stype !== "m3u8") continue;
      const d = Math.hypot(c.lon - lon, c.lat - lat);
      if (d < bd) { bd = d; best = c; }
    }
    if (best && bd < 1.5 && !out.some((o) => o.cam === best)) out.push({ cam: best, label: best.name || "City camera" });
  }
  return out.slice(0, 12);
}

function startTour() {
  if (tour) { stopTour(); return; }
  const stops = tourStops();
  if (!stops.length) { el.syncMsg.textContent = "no tour stops available yet"; return; }
  const pill = document.createElement("div");
  pill.id = "tour-pill";
  pill.innerHTML = '<span class="tour-dot"></span><span class="tour-title">AUTOPILOT</span>' +
    '<button class="tour-next">NEXT ›</button><button class="tour-stop">✕</button>';
  document.body.appendChild(pill);
  tour = { stops, i: -1, timer: 0, pill };
  pill.querySelector(".tour-next").onclick = (e) => { e.stopPropagation(); tourStep(); };
  pill.querySelector(".tour-stop").onclick = (e) => { e.stopPropagation(); stopTour(); };
  map.once("mousedown", () => tour && stopTour());
  tourStep();
}

function tourStep() {
  if (!tour) return;
  tour.i = (tour.i + 1) % tour.stops.length;
  const st = tour.stops[tour.i];
  const t = tour.pill.querySelector(".tour-title");
  if (t) t.textContent = st.label + " · " + (tour.i + 1) + "/" + tour.stops.length;
  map.flyTo({
    center: [st.cam.lon, st.cam.lat], zoom: 15.4, pitch: 58,
    bearing: (tour.i * 47) % 360, duration: 4200, essential: true,
    easing: (t2) => 1 - Math.pow(1 - t2, 3),
  });
  clearTimeout(tour.timer);
  tour.timer = setTimeout(() => {
    if (!tour) return;
    openCam(st.cam.id, false);
    tour.timer = setTimeout(tourStep, 11000);
  }, 4300);
}

function stopTour() {
  if (!tour) return;
  clearTimeout(tour.timer);
  if (tour.pill) tour.pill.remove();
  tour = null;
}

let tour = null;

function goLive() {
  const rows = cams.filter((c) => c.live === 1 && (c.stype === "m3u8" || c.stype === "image"));
  if (!rows.length) { el.syncMsg.textContent = "no verified-live feeds yet — try ⟳ SYNC"; return; }
  if (tour) stopTour();
  openWall(4);
}

function bumpVisit(id) {
  try {
    const v = JSON.parse(localStorage.getItem("ge_visits") || "{}");
    v[id] = (v[id] || 0) + 1;
    localStorage.setItem("ge_visits", JSON.stringify(v));
    return v[id];
  } catch (e) { return 1; }
}

// --------------------------------------------------------------- controls --
function wireUI() {
  let debounce;
  el.q.addEventListener("input", () => {
    renderList(); refreshSource();
    clearTimeout(debounce);
    debounce = setTimeout(() => geoSearch(el.q.value.trim()), 450);
  });
  el.fType.addEventListener("change", () => { renderList(); refreshSource(); });
  el.fLive.addEventListener("change", () => { renderList(); refreshSource(); });
  el.fCountry.addEventListener("change", () => { renderList(); refreshSource(); });
  el.panelToggle.onclick = () => el.panel.classList.toggle("collapsed");
  el.mClose.onclick = closeModal;
  el.modal.addEventListener("click", (e) => { if (e.target === el.modal) closeModal(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (wallOpen) closeWall(); else closeModal(); }
  });
  el.list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) openCam(li.dataset.id, true);
  });

  el.mStar.onclick = () => activeId && toggleFav(activeId);
  el.mLink.onclick = () => {
    if (!activeId) return;
    const url = `${location.origin}${location.pathname}?cam=${encodeURIComponent(activeId)}`;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(() => { el.syncMsg.textContent = "🔗 camera link copied"; setTimeout(() => (el.syncMsg.textContent = ""), 2500); })
      .catch(() => { prompt("Copy camera link:", url); });
  };
  el.mCap.onclick = captureFrame;
  wireScrub();

  $("#btn-wall4").onclick = () => openWall(4);
  $("#btn-wall6").onclick = () => openWall(6);
  $("#btn-wall9").onclick = () => openWall(9);
  $("#btn-tour").onclick = startTour;
  $("#btn-live").onclick = goLive;
  $("#btn-install").onclick = () => {
    if (window._installPrompt) { window._installPrompt.prompt(); window._installPrompt = null; $("#btn-install").style.display = "none"; }
  };
  $("#wall-close").onclick = closeWall;
  $("#wall-fill").onclick = () => openWall(wallN);
  $("#btn-fx").onclick = (e) => {
    fxOn = !fxOn; localStorage.setItem("ge_fx", fxOn ? "1" : "0");
    e.target.classList.toggle("active", fxOn);
    if (fxOn) fxBlip();
  };
  $("#btn-fav").onclick = (e) => {
    favsOnly = !favsOnly; localStorage.setItem("ge_favs_only", favsOnly ? "1" : "0");
    e.target.classList.toggle("active", favsOnly);
    e.target.textContent = favsOnly ? "★ FAVS ON" : "★ FAVS";
    renderList(); refreshSource();
  };

  document.querySelectorAll("#styles button").forEach(b => b.onclick = async () => {
    document.querySelectorAll("#styles button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    currentStyle = b.dataset.style;
    const style = await loadStyle(currentStyle);
    map.setStyle(style);
    map.once("styledata", () => {
      ensureTerrain();
      map.setProjection && map.setProjection({ type: "globe" });
      addCamLayers(); refreshSource();
    });
  });

  $("#btn-terrain").onclick = (e) => {
    terrainOn = !terrainOn;
    e.target.classList.toggle("active", terrainOn);
    ensureTerrain();
  };
  $("#btn-home").onclick = () => map.flyTo({ center: [10, 20], zoom: 1.55, pitch: 0, bearing: 0, duration: 2500, essential: true });
  $("#btn-sync").onclick = async () => {
    el.syncMsg.textContent = "⟳ live sync running…";
    const added = await mergeNew(await Sources.liveSync((s) => { el.syncMsg.textContent = "⟳ " + s; }));
    el.syncMsg.textContent = `⟳ sync done — ${fmtNum(added)} new feeds merged`;
    setTimeout(() => (el.syncMsg.textContent = ""), 6000);
  };

  // ---- intel layers ----
  $("#btn-night").onclick = (e) => { e.target.classList.toggle("active", Intel.toggleNight()); fxBlip(); };
  $("#btn-iss").onclick = (e) => { e.target.classList.toggle("active", Intel.toggleISS(false)); fxBlip(); };
  $("#btn-radar").onclick = async (e) => {
    const on = await Intel.toggleRadar();
    e.target.classList.toggle("active", !!on);
  };
  $("#btn-route").onclick = () => { $("#route").classList.toggle("hidden"); fxBlip(); };
  $("#route-close").onclick = () => $("#route").classList.add("hidden");
  $("#route-go").onclick = async () => {
    const list = $("#route-list");
    list.innerHTML = '<div class="route-empty">scanning corridor…</div>';
    try { await Intel.sweepRoute($("#route-a").value, $("#route-b").value, list); fxLockOn(); }
    catch (err) { list.innerHTML = `<div class="route-empty">${String(err.message || err)}</div>`; }
  };
  $("#route-clear").onclick = () => { Intel.clearRoute(); $("#route-list").innerHTML = ""; };
  $("#radar-slider").addEventListener("input", (e) => {
    Intel.pauseRadar();
    $("#radar-play").textContent = "▶";
    Intel.state.radarIdx = +e.target.value;
    Intel.applyRadarFrame();
  });
  $("#radar-play").onclick = () => {
    if (Intel.state.radarPlaying) { Intel.pauseRadar(); $("#radar-play").textContent = "▶"; }
    else { Intel.playRadar(); $("#radar-play").textContent = "⏸"; }
  };
  $("#btn-air").onclick = (e) => { e.target.classList.toggle("active", Intel.toggleAir()); fxBlip(); };
  $("#air-chip").onclick = () => { $("#btn-air").click(); };
  $("#iss-chip").onclick = () => {
    Intel.state.issFollow = !Intel.state.issFollow;
    $("#iss-chip").style.borderColor = Intel.state.issFollow ? "var(--amber)" : "";
  };
  window.addEventListener("ge-open-cam", (e2) => openCam(e2.detail, true));

  $("#btn-fx").classList.toggle("active", fxOn);
  $("#btn-fav").classList.toggle("active", favsOnly);
  $("#btn-fav").textContent = favsOnly ? "★ FAVS ON" : "★ FAVS";
}

function ensureTerrain() {
  try {
    map.setTerrain(terrainOn && map.getSource("dem") ? { source: "dem", exaggeration: 1.35 } : null);
  } catch (e) {}
}

// -------------------------------------------------------------------- map --
async function initMap() {
  const style = await loadStyle(currentStyle);
  map = new maplibregl.Map({
    container: "map", style, center: [10, 20], zoom: 1.55, minZoom: 1, maxZoom: 18.8,
    maxPitch: 70, attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

  map.on("style.load", () => {
    try { map.setProjection({ type: "globe" }); } catch (e) {}
    try {
      map.setSky && map.setSky({ skyColor: "#020610", horizonColor: "#0a1626", fogColor: "#0a1626" });
    } catch (e) {}
    ensureTerrain();
  });

  map.on("load", () => {
    map.addSource("cams", {
      type: "geojson", data: { type: "FeatureCollection", features: [] },
      cluster: true, clusterMaxZoom: 11, clusterRadius: 48,
    });
    addCamLayers();
    loadBundled();
  });

  // ---- compass: needle shows live bearing; click = smooth north+level reset
  const needle = document.getElementById("compass-needle");
  const compassBtn = document.getElementById("compass");
  const syncCompass = () => {
    const b = ((map.getBearing() % 360) + 360) % 360;
    const flat = (b < 0.5 || b > 359.5) && Math.abs(map.getPitch()) < 0.5;
    needle.style.transform = `rotate(${-map.getBearing()}deg)`;
    compassBtn.classList.toggle("level", flat);
  };
  map.on("rotate", syncCompass);
  map.on("pitch", syncCompass);
  syncCompass();
  compassBtn.addEventListener("click", () => {
    idleAt = Date.now();
    fxBlip();
    map.easeTo({ bearing: 0, pitch: 0, duration: 1100, easing: (t) => 1 - Math.pow(1 - t, 4) });
  });

  // ---- Apple-momentum wheel smoothing for list panels (notch-quantized
  //      mouse wheels only; trackpads keep native momentum)
  const smoothWheel = (node) => {
    if (!node) return;
    let target = node.scrollTop, raf = null;
    node.addEventListener("wheel", (e) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const notchy = e.deltaMode === 1 || (e.deltaMode === 0 && Math.abs(e.deltaY) >= 100 && Math.abs(e.deltaY) % 3 === 0);
      if (!notchy) return;
      e.preventDefault();
      target = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, target + e.deltaY * 1.2));
      if (!raf) raf = requestAnimationFrame(function step() {
        node.scrollTop += (target - node.scrollTop) * 0.16;
        if (Math.abs(target - node.scrollTop) > 0.6) raf = requestAnimationFrame(step);
        else { node.scrollTop = target; raf = null; }
      });
    }, { passive: false });
    node.style.scrollBehavior = "smooth";
  };
  smoothWheel(el.list);
  smoothWheel(document.getElementById("route-list"));

  // ---- mobile FAB quick-actions
  $("#fab").addEventListener("click", () => { $("#fab-sheet").classList.toggle("hidden"); fxBlip(); });
  $("#fab-sheet").addEventListener("click", (e2) => {
    const b = e2.target.closest("button[data-do]");
    if (b) {
      const t = document.querySelector(b.dataset.do);
      if (t) t.click();
      $("#fab-sheet").classList.add("hidden");
    }
  });

  // ---- mobile: swipe-down to close the camera modal (Apple sheet gesture)
  const box = document.querySelector(".modal-box");
  let dragY0 = null, dragDy = 0;
  el.modal.addEventListener("touchstart", (e2) => {
    if (e2.target.closest("button, a, input")) return;
    if (!e2.target.closest(".modal-head, .modal-grab, .modal-meta")) return;
    dragY0 = e2.touches[0].clientY; dragDy = 0;
    box.style.transition = "none";
  }, { passive: true });
  el.modal.addEventListener("touchmove", (e2) => {
    if (dragY0 == null) return;
    dragDy = Math.max(0, e2.touches[0].clientY - dragY0);
    box.style.transform = `translateY(${dragDy}px)`;
  }, { passive: true });
  el.modal.addEventListener("touchend", () => {
    if (dragY0 == null) return;
    box.style.transition = "";
    box.style.transform = "";
    if (dragDy > 90) closeModal();
    dragY0 = null;
  });

  // ---- any interaction resets idle timer (compass/fab included)
  document.addEventListener("pointerdown", () => { idleAt = Date.now(); }, true);

  // ---- click glow pulse on interactive chrome
  document.addEventListener("click", (e2) => {
    const b = e2.target.closest("button");
    if (!b) return;
    b.classList.remove("clicked");
    void b.offsetWidth;
    b.classList.add("clicked");
  });

  map.on("zoom", () => { el.stZoom.textContent = map.getZoom().toFixed(1); });
  map.on("mousemove", (e) => {
    idleAt = Date.now();
    el.stCursor.textContent = `${e.lngLat.lat.toFixed(3)}, ${e.lngLat.lng.toFixed(3)}`;
  });
  ["mousedown", "touchstart", "wheel"].forEach(ev => map.on(ev, () => { idleAt = Date.now(); }));

  // silky idle globe spin: continuous rAF rotation with gentle speed ramp
  let spinLast = performance.now();
  (function spin(now) {
    const dt = Math.min(0.05, (now - spinLast) / 1000);
    spinLast = now;
    const idleFor = (Date.now() - idleAt) / 1000;
    if (idleFor > 25 && map.getZoom() < 3 && el.modal.classList.contains("hidden") && !wallOpen) {
      const ramp = Math.min(1, (idleFor - 25) / 3); // ease up to full drift
      map.jumpTo({ bearing: map.getBearing() + 1.2 * ramp * dt });
    }
    requestAnimationFrame(spin);
  })(performance.now());
}

// ------------------------------------------------------------------- boot --
function tickClock() {
  const t = () => { el.stClock.textContent = new Date().toISOString().slice(11, 19); };
  t(); setInterval(t, 1000);
}

(async function main() {
  bootLines();
  tickClock();
  wireUI();
  try {
    const h = await fetch("/api/health", { cache: "no-store" });
    if (h.status === 404) window.GE_NO_PROXY = true;
  } catch (e) {
    window.GE_NO_PROXY = true;
  }
  if (window.GE_NO_PROXY) el.syncMsg.textContent = "static mode — live video needs the /api relay";
  await initMap();
  Intel.init(map);
  setTimeout(async () => {
    try {
      el.syncMsg.textContent = "⟳ background sync…";
      const added = await mergeNew(await Sources.liveSync((s) => { el.syncMsg.textContent = "⟳ " + s; }));
      el.syncMsg.textContent = `⟳ live sync: +${fmtNum(added)} feeds`;
      setTimeout(() => (el.syncMsg.textContent = ""), 5000);
    } catch (e) {}
  }, 4000);
})();

})();
