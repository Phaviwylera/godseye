/* GOD'S EYE — global CCTV grid frontend */
(() => {
"use strict";

// ------------------------------------------------------------------ state --
let map, cams = [], byId = new Map(), activeId = null, idleAt = Date.now();
let currentStyle = "dark", terrainOn = true, hlsNote = null;

const $ = (s) => document.querySelector(s);
const el = {
  boot: $("#boot"), bootLog: $("#boot-log"), stCams: $("#st-cams"), stVideo: $("#st-video"),
  stZoom: $("#st-zoom"), stCursor: $("#st-cursor"), stClock: $("#st-clock"),
  q: $("#q"), geoResults: $("#geo-results"), fType: $("#f-type"), fCountry: $("#f-country"),
  list: $("#cam-list"), listCount: $("#list-count"), panel: $("#panel"), panelToggle: $("#panel-toggle"),
  modal: $("#modal"), player: $("#player"), mTitle: $("#m-title"), mCoords: $("#m-coords"),
  mRegion: $("#m-region"), mSrc: $("#m-src"), mClock: $("#m-clock"), mStatus: $("#m-status"),
  mAttr: $("#m-attr"), mPage: $("#m-page"), mClose: $("#m-close"),
  syncMsg: $("#sync-msg"),
};

// ------------------------------------------------------------------ utils --
const fmtNum = (n) => n.toLocaleString("en-US");
const TYPE_LABEL = { m3u8: "VIDEO", image: "SNAP", embed: "PORTAL", dynamic: "LIVE" };

function bootLines() {
  const lines = [
    '<span class="dim">> uplink handshake</span> … <span class="ok">OK</span>',
    '<span class="dim">> terrain mesh</span> … <span class="ok">MOUNTED</span>',
    '<span class="dim">> satellite basemap</span> … <span class="ok">LOCKED</span>',
    '<span class="dim">> public cctv registries</span> … <span class="ok">LINKED</span>',
    '<span class="dim">> god\'s eye</span> … <span class="ok">ONLINE</span>',
  ];
  let i = 0;
  const t = setInterval(() => {
    el.bootLog.insertAdjacentHTML("beforeend", lines[i] + "<br>");
    if (++i >= lines.length) clearInterval(t);
  }, 260);
  const done = () => { el.boot.classList.add("gone"); clearInterval(t); };
  el.boot.addEventListener("click", done, { once: true });
  setTimeout(done, 2100);
}

// ------------------------------------------------------------- map styles --
const ESRI_IMG = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_LBL = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const STYLE_URLS = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  streets: "https://tiles.openfreemap.org/styles/liberty",
  satellite: null, // built locally
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
  // camera body
  g.beginPath(); g.roundRect(8, 16, 24, 16, 3); g.fill(); g.stroke();
  // lens
  g.beginPath(); g.moveTo(32, 19); g.lineTo(41, 14); g.lineTo(41, 34); g.lineTo(32, 29); g.closePath(); g.fill(); g.stroke();
  // LED
  g.shadowBlur = 10; g.fillStyle = ledColor;
  g.beginPath(); g.arc(14, 21, 2.6, 0, 7); g.fill();
  // mount
  g.shadowBlur = 0; g.strokeStyle = "rgba(0,240,255,.5)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(20, 32); g.lineTo(20, 40); g.moveTo(14, 42); g.lineTo(26, 42); g.stroke();
  return g.getImageData(0, 0, 48, 48);
}

function camIconId(stype) {
  return stype === "m3u8" ? "cctv-live" : stype === "image" || stype === "dynamic" ? "cctv-snap" : "cctv-portal";
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
      "icon-image": ["match", ["get", "stype"], "m3u8", "cctv-live", ["image", "dynamic"], "cctv-snap", "cctv-portal"],
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
    (!q || (c.name + " " + (c.place || "") + " " + (c.region || "")).toLowerCase().includes(q))
  );
}

function updateStats() {
  el.stCams.textContent = fmtNum(cams.length);
  el.stVideo.textContent = fmtNum(cams.filter(c => c.stype === "m3u8").length);
}

function renderList() {
  const f = filtered();
  el.listCount.textContent = fmtNum(f.length);
  const show = f.slice(0, 300);
  el.list.innerHTML = show.map(c => `
    <li data-id="${c.id}" class="${c.id === activeId ? "active" : ""}">
      <span class="dot ${c.stype === "m3u8" ? "m3u8" : c.status === "live" ? "live" : ""}"></span>
      <div>
        <div class="cam-name">${c.name}</div>
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
  // country select
  const countries = [...new Set(cams.map(c => c.country))].sort();
  el.fCountry.innerHTML = '<option value="all">world</option>' +
    countries.map(c => `<option value="${c}">${c}</option>`).join("");
  updateStats();
  renderList();
  refreshSource();
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

// --------------------------------------------------------------- controls --
function openCam(id, fly) {
  const c = byId.get(id);
  if (!c) return;
  activeId = id;
  renderList();
  if (fly) {
    map.flyTo({
      center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 15.2), pitch: 58,
      bearing: (Math.random() * 50 - 25), duration: 2200, curve: 1.5, essential: true,
    });
  }
  el.mTitle.textContent = c.name;
  el.mCoords.textContent = `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;
  el.mRegion.textContent = [c.place, c.region, c.country].filter(Boolean).join(" · ");
  el.mSrc.textContent = "SRC " + c.src.toUpperCase();
  el.mStatus.textContent = c.stype === "m3u8" ? "LIVE VIDEO" : c.stype === "embed" ? "PORTAL" : "LIVE FEED";
  el.mAttr.textContent = c.attr || "public feed";
  el.mPage.href = c.page || "#";
  el.mPage.style.display = c.page ? "" : "none";
  el.modal.classList.remove("hidden");
  Players.play(c, el.player);
  Players.startClock(el.mClock);
}

function closeModal() {
  el.modal.classList.add("hidden");
  Players.stop();
  activeId = null;
  renderList();
}

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

function wireUI() {
  let debounce;
  el.q.addEventListener("input", () => {
    renderList(); refreshSource();
    clearTimeout(debounce);
    debounce = setTimeout(() => geoSearch(el.q.value.trim()), 450);
  });
  el.fType.addEventListener("change", () => { renderList(); refreshSource(); });
  el.fCountry.addEventListener("change", () => { renderList(); refreshSource(); });
  el.panelToggle.onclick = () => el.panel.classList.toggle("collapsed");
  el.mClose.onclick = closeModal;
  el.modal.addEventListener("click", (e) => { if (e.target === el.modal) closeModal(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  el.list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) openCam(li.dataset.id, true);
  });

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

  map.on("zoom", () => { el.stZoom.textContent = map.getZoom().toFixed(1); });
  map.on("mousemove", (e) => {
    idleAt = Date.now();
    el.stCursor.textContent = `${e.lngLat.lat.toFixed(3)}, ${e.lngLat.lng.toFixed(3)}`;
  });
  ["mousedown", "touchstart", "wheel"].forEach(ev => map.on(ev, () => { idleAt = Date.now(); }));

  // slow cinematic drift when idle & zoomed out
  setInterval(() => {
    if (Date.now() - idleAt > 25000 && map.getZoom() < 3 && el.modal.classList.contains("hidden")) {
      map.easeTo({ bearing: map.getBearing() + 2.5, duration: 320, easing: (x) => x });
    }
  }, 320);
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
  await initMap();
  // background live sync — keeps the grid fresh from official APIs
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
