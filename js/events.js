/* GOD'S EYE — EVENTS layer: live-world events on the globe.
 *
 * Three open sources, each drawn only where the source actually reported:
 *   storms   — NOAA/NWS active weather alerts (US), keyless JSON, Severe/Extreme
 *              storm events only (tornado, hurricane, flood, winter, dust…).
 *   fires    — NASA FIRMS satellite fire hotspots (VIIRS NOAA-21, last day).
 *              The free MAP_KEY lives server-side (FIRMS_MAP_KEY); without it
 *              the layer says "FIRES · KEY PENDING" instead of inventing data.
 *   volcanoes— every named volcano in OpenStreetMap, built nightly-ish by
 *              tools/build_infra.py. Until that snapshot has run, the layer
 *              says "VOLC · PENDING BUILD".
 *
 * Ground rules, same as every other layer: real operator data only, source
 * cited in every card, no invented positions.
 */
const Events = (() => {
  let map = null;
  const state = {
    on: false,
    storms: [], fires: [], volcanoes: [],
    stormsAt: 0, firesAt: 0,
    firesKeyPending: false, volcPending: false, firesHeld: false,
    timer: null,
  };

  const NWS_URL = "https://api.weather.gov/alerts/active?status=actual";
  const VOLC_URL = "data/volcanoes.json";
  const FIRES_URL = "/api/fires?window=900";
  const STORM_MS = 10 * 60 * 1000;
  const FIRE_MS = 15 * 60 * 1000;
  const MAX_FIRE_POINTS = 20000; // brightness-ranked cap keeps the globe fast

  const STORM_RE = /tornado|hurricane|tsunami|tropical storm|severe thunderstorm|blowing dust|flash flood|flood|winter storm|ice storm|blizzard|high wind|wind advisory|fire weather|extreme cold/i;
  const SEV_RANK = { Extreme: 3, Severe: 2 };

  /* ------------------------------------------------------------------ pure -- */

  /** Mean of the first ring of the first polygon — a stable plot centre for an
   *  NWS alert geometry. Returns [lon, lat] or null. */
  function ringCenter(geom) {
    try {
      let ring = null;
      if (geom && geom.type === "Polygon" && Array.isArray(geom.coordinates) && geom.coordinates[0]) {
        ring = geom.coordinates[0];
      } else if (geom && geom.type === "MultiPolygon" && Array.isArray(geom.coordinates) &&
          geom.coordinates[0] && geom.coordinates[0][0]) {
        ring = geom.coordinates[0][0];
      }
      if (!ring || !ring.length) return null;
      // GeoJSON rings are closed: the last vertex repeats the first — drop it,
      // or the average drifts toward the corner.
      if (ring.length > 1 &&
          ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
        ring = ring.slice(0, -1);
      }
      if (!ring.length) return null;
      let lon = 0, lat = 0;
      for (const [a, b] of ring) { lon += a; lat += b; }
      lon /= ring.length; lat /= ring.length;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
      return [lon, lat];
    } catch { return null; }
  }

  /** NWS alerts GeoJSON -> storm events, Severe/Extreme storm types only. */
  function normalizeNws(doc) {
    const out = [];
    for (const f of (doc && doc.features) || []) {
      const p = (f && f.properties) || {};
      const event = String(p.event || "");
      const rank = SEV_RANK[p.severity] || 0;
      if (!rank || !STORM_RE.test(event)) continue;
      const c = ringCenter(f.geometry);
      if (!c) continue;
      out.push({
        event,
        severity: p.severity,
        headline: String(p.headline || p.description || "").replace(/\s+/g, " ").slice(0, 160),
        issued: p.issueDate || "",
        lon: c[0], lat: c[1],
        rank,
      });
    }
    out.sort((a, b) => b.rank - a.rank);
    return out;
  }

  /** FIRMS CSV (lat,lon,brightness,temp,scan,track,acq_date,acq_time,confidence,…)
   *  -> hotspots. Rows that fail validation are dropped, never coerced. */
  function parseFirmsCsv(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];
    const lines = trimmed.split(/\r?\n/);
    const head = lines[0].split(",");
    const idx = (name) => head.indexOf(name);
    const iLat = idx("lat"), iLon = idx("lon"), iBright = idx("brightness"),
      iConf = idx("confidence"), iDate = idx("acq_date");
    if (iLat < 0 || iLon < 0 || iBright < 0) throw new Error("not a FIRMS csv");
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split(",");
      const lat = Number(f[iLat]), lon = Number(f[iLon]), bright = Number(f[iBright]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(bright)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const conf = iConf >= 0 ? Number(f[iConf]) : NaN;
      rows.push({ lon, lat, bright, conf: Number.isFinite(conf) ? conf : null, date: iDate >= 0 ? f[iDate] : "" });
    }
    if (rows.length > MAX_FIRE_POINTS) {
      rows.sort((a, b) => b.bright - a.bright);
      return rows.slice(0, MAX_FIRE_POINTS);
    }
    return rows;
  }

  function fmtAge(at) {
    if (!at) return "—";
    const m = Math.round((Date.now() - at) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    return Math.round(m / 60) + " h ago";
  }

  function stormCard(s) {
    const esc = (x) => String(x).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    return `<div class="ev-card">
      <div class="ev-q">${esc(s.event)}</div>
      <div class="ev-row"><b>${esc(s.severity)}</b> · issued ${esc((s.issued || "").slice(0, 16).replace("T", " "))}</div>
      <div class="ev-row dim">${esc(s.headline)}</div>
      <div class="ev-row dim">Source: NOAA/NWS active alerts (US coverage)</div>
    </div>`;
  }

  function fireCard(f) {
    return `<div class="ev-card">
      <div class="ev-q">Fire hotspot</div>
      <div class="ev-row">brightness ${f.bright.toFixed(0)}${f.conf != null ? " · confidence " + f.conf.toFixed(0) + "%" : ""}${f.date ? " · " + f.date : ""}</div>
      <div class="ev-row dim">Satellite detection (NASA FIRMS, VIIRS NOAA-21, last day). A thermal signal — not always a wildfire.</div>
    </div>`;
  }

  /* ------------------------------------------------------------------- DOM -- */

  function chip() { return document.getElementById("events-chip"); }
  function setChip(text, title) {
    const c = chip();
    if (!c) return;
    c.classList.remove("hidden");
    c.textContent = text;
    if (title) c.title = title;
  }

  function features() {
    const out = [];
    for (const s of state.storms) out.push({ type: "Feature", properties: { kind: "storm", storm: s },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] } });
    for (const f of state.fires) out.push({ type: "Feature", properties: { kind: "fire", fire: f },
      geometry: { type: "Point", coordinates: [f.lon, f.lat] } });
    for (const v of state.volcanoes) out.push({ type: "Feature", properties: { kind: "volcano", volcano: v },
      geometry: { type: "Point", coordinates: [v[0], v[1]] } });
    return { type: "FeatureCollection", features: out };
  }

  function pushData() {
    const src = map.getSource("events-geo");
    if (src) src.setData(features());
  }

  function chipText() {
    const parts = [];
    parts.push(`${state.storms.length} STORMS`);
    if (state.firesKeyPending) parts.push("FIRES · KEY PENDING");
    else if (state.firesHeld) parts.push(`${state.fires.length} FIRES · HELD ${fmtAge(state.firesAt).toUpperCase()}`);
    else parts.push(`${state.fires.length} FIRES`);
    if (state.volcPending) parts.push("VOLC · PENDING BUILD");
    else parts.push(`${state.volcanoes.length} VOLC`);
    return "⌁ " + parts.join(" · ");
  }

  function addLayers() {
    if (map.getSource("events-geo")) return;
    map.addSource("events-geo", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const base = { source: "events-geo" };
    map.addLayer({
      ...base, id: "events-volcano", type: "circle",
      filter: ["==", ["get", "kind"], "volcano"],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 6, 2.5, 9, 4],
        "circle-color": "#b9a68e", "circle-stroke-color": "rgba(10,8,6,.8)", "circle-stroke-width": 0.8, "circle-opacity": 0.85 },
    });
    map.addLayer({
      ...base, id: "events-fire", type: "circle",
      filter: ["==", ["get", "kind"], "fire"],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 1.2, 6, 2, 9, 3.2],
        "circle-color": "#ff9f43", "circle-opacity": 0.75 },
    });
    map.addLayer({
      ...base, id: "events-storm", type: "circle",
      filter: ["==", ["get", "kind"], "storm"],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 3, 6, 5, 9, 8],
        "circle-color": "#ff667d", "circle-stroke-color": "rgba(10,4,8,.9)", "circle-stroke-width": 1, "circle-opacity": 0.9 },
    });
    const popupFor = (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      const p = f.properties;
      const html = p.kind === "storm" ? stormCard(p.storm) : p.kind === "fire" ? fireCard(p.fire) :
        `<div class="ev-card"><div class="ev-q">${String(p.volcano.name || "Volcano").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])}</div><div class="ev-row dim">${p.volcano.ele ? "elevation " + p.volcano.ele + " m · " : ""}named volcano, OpenStreetMap</div></div>`;
      new maplibregl.Popup({ closeButton: true, closeOnClick: true })
        .setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
    };
    for (const id of ["events-storm", "events-fire", "events-volcano"]) {
      map.on("click", id, popupFor);
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }
  }

  /* --------------------------------------------------------------- loading -- */

  async function loadStorms() {
    const d = await Sources.fetchJSON(NWS_URL, 600);
    state.storms = normalizeNws(d);
    state.stormsAt = Date.now();
  }

  async function loadFires() {
    const r = await fetch(FIRES_URL);
    if (r.status === 501 || r.status === 404) { state.firesKeyPending = true; return; }
    if (!r.ok) throw new Error("firms " + r.status);
    state.fires = parseFirmsCsv(await r.text());
    state.firesKeyPending = false;
    state.firesHeld = false;
    state.firesAt = Date.now();
  }

  async function loadVolcanoes() {
    const r = await fetch(VOLC_URL);
    if (!r.ok) { state.volcPending = true; return; }
    const doc = await r.json();
    state.volcanoes = Array.isArray(doc.records) ? doc.records : [];
    state.volcPending = state.volcanoes.length === 0;
  }

  function refreshAll() {
    return Promise.allSettled([
      loadStorms().catch((e) => { console.warn("events: storms", e); throw e; }),
      loadFires().catch((e) => {
        // keep the last good sweep, show its age — the vessels "HELD" pattern
        if (!state.firesKeyPending) { state.firesHeld = true; console.warn("events: fires held", e); }
      }),
      loadVolcanoes().catch((e) => { console.warn("events: volcanoes", e); }),
    ]).then(() => {
      pushData();
      setChip(chipText(),
        "Active NWS storm warnings (US), NASA FIRMS fire hotspots (last day) and named OpenStreetMap volcanoes. Real operator data only.");
    });
  }

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      chip().classList.add("hidden");
      for (const id of ["events-storm", "events-fire", "events-volcano"]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource("events-geo")) map.removeSource("events-geo");
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      return false;
    }
    state.on = true;
    await refreshAll();
    addLayers();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => { if (state.on) refreshAll(); },
      Math.min(STORM_MS, FIRE_MS));
    return true;
  }

  function restore() {
    if (state.on && map && !map.getSource("events-geo")) {
      addLayers();
      pushData();
    }
  }

  function openList() {
    const rows = [];
    for (const s of state.storms) {
      rows.push({ s, label: `${s.severity.toUpperCase()} · ${s.event}`,
        detail: (s.headline || (s.issued || "").slice(0, 16)).slice(0, 60) });
    }
    const hotFires = state.fires.slice().sort((a, b) => b.bright - a.bright).slice(0, 50);
    for (const f of hotFires) {
      rows.push({ f, label: "FIRE HOTSPOT · BRIGHT " + f.bright.toFixed(0),
        detail: `${f.lat.toFixed(2)}, ${f.lon.toFixed(2)}${f.date ? " · " + f.date : ""}` });
    }
    Contacts.open("EVENTS — storms & fire hotspots", rows, ({ s, f }) => {
      const c = s ? [s.lon, s.lat] : [f.lon, f.lat];
      map.flyTo({ center: c, zoom: s ? 7 : 8, duration: 1200 });
    });
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, openList, normalizeNws, parseFirmsCsv, ringCenter, fmtAge,
    stormCard, fireCard, _state: state };
})();
