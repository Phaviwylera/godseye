/* GOD'S EYE — intel layers: day/night terminator, live ISS tracker,
 * global weather radar (RainViewer), route corridor camera sweep.
 * Everything is optional/toggleable and self-contained in this module;
 * app.js calls Intel.init(map) and Intel actions from the HUD buttons.
 */
const Intel = (() => {
  let map = null;
  const state = {
    night: false, iss: false, radar: false,
    issTimer: null, nightTimer: null, radarTimer: null,
    issTrail: [], issFollow: false, radarFrames: [], radarIdx: 0, radarPlaying: false,
    air: false, airTimer: null, airMoveTimer: null,
  };

  // ================================================================ SUN ====
  const rad = Math.PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397;
  const toDays = (date) => date.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
  function eclipticLongitude(M) {
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    return M + C + rad * 102.9372 + Math.PI;
  }
  function subsolar(date) {
    const d = toDays(date), M = solarMeanAnomaly(d), L = eclipticLongitude(M);
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
    const gmst = rad * (280.16 + 360.9856235 * d);
    let lng = (ra - gmst) / rad;
    lng = ((lng + 180) % 360 + 360) % 360 - 180;
    return { lat: dec / rad, lng };
  }

  function terminatorCoords(date) {
    const s = subsolar(date);
    const dec = s.lat * rad;
    const pts = [];
    for (let lng = -180; lng <= 180; lng += 2) {
      const H = (lng - s.lng) * rad;
      let lat = Math.atan(-Math.cos(H) / Math.tan(dec)) / rad;
      lat = Math.max(-89.9, Math.min(89.9, lat));
      pts.push([lng, lat]);
    }
    // close the polygon over whichever pole is in darkness
    const pole = s.lat >= 0 ? -89.99 : 89.99;
    pts.push([180, pole], [-180, pole]);
    return [[pts]];
  }

  function nightLayerData() {
    return {
      type: "FeatureCollection",
      features: [{
        type: "Feature", properties: {},
        geometry: { type: "Polygon", coordinates: terminatorCoords(new Date()) },
      }],
    };
  }

  function ensureNight() {
    if (!map.getSource("night")) {
      map.addSource("night", { type: "geojson", data: nightLayerData() });
      map.addLayer({
        id: "night-fill", type: "fill", source: "night",
        paint: { "fill-color": "#01040c", "fill-opacity": 0.42 },
      });
    }
  }

  function toggleNight() {
    state.night = !state.night;
    if (state.night) {
      ensureNight();
      map.setLayoutProperty("night-fill", "visibility", "visible");
      state.nightTimer = setInterval(() => {
        const s = map.getSource("night");
        if (s) s.setData(nightLayerData());
      }, 60000);
    } else {
      clearInterval(state.nightTimer);
      if (map.getLayer("night-fill")) map.setLayoutProperty("night-fill", "visibility", "none");
    }
    return state.night;
  }

  // ================================================================= ISS ===
  function issIcon() {
    const c = document.createElement("canvas"); c.width = c.height = 48;
    const g = c.getContext("2d");
    g.strokeStyle = "#00f0ff"; g.fillStyle = "#04101a"; g.lineWidth = 2.2;
    g.shadowColor = "#00f0ff"; g.shadowBlur = 8;
    // solar panels
    g.beginPath(); g.roundRect(3, 18, 14, 12, 2); g.roundRect(31, 18, 14, 12, 2); g.fill(); g.stroke();
    // body
    g.beginPath(); g.roundRect(18, 16, 12, 16, 3); g.fill(); g.stroke();
    // antenna
    g.beginPath(); g.moveTo(24, 16); g.lineTo(24, 8); g.stroke();
    g.fillStyle = "#2aff8b"; g.beginPath(); g.arc(24, 7, 2.4, 0, 7); g.fill();
    return g.getImageData(0, 0, 48, 48);
  }

  async function issTick() {
    try {
      const d = await Sources.fetchJSON("https://api.wheretheiss.at/v1/satellites/25544");
      const pt = [+d.longitude, +d.latitude];
      state.issTrail.push(pt);
      if (state.issTrail.length > 45) state.issTrail.shift();
      const src = map.getSource("iss");
      const feat = {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {
              name: "ISS (ZARYA) · " + Math.round(d.altitude) + " km · " +
                    Math.round(d.velocity).toLocaleString() + " km/h",
            },
            geometry: { type: "Point", coordinates: pt } },
          { type: "Feature", properties: {},
            geometry: { type: "LineString", coordinates: state.issTrail.slice() } },
        ],
      };
      if (src) src.setData(feat);
      const chip = document.getElementById("iss-chip");
      if (chip) {
        chip.textContent = `ISS · ${Math.round(d.altitude)}km · ${Math.round(d.velocity).toLocaleString()}km/h`;
        chip.title = `ISS position: ${(+d.latitude).toFixed(2)}, ${(+d.longitude).toFixed(2)}`;
      }
      if (state.issFollow) map.easeTo({ center: pt, duration: 1500 });
    } catch (e) { /* next tick */ }
  }

  function toggleISS(onFollow) {
    state.iss = !state.iss;
    const chip = document.getElementById("iss-chip");
    if (state.iss) {
      if (!map.getSource("iss")) {
        map.addSource("iss", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        if (!map.hasImage("iss-sat")) map.addImage("iss-sat", issIcon(), { pixelRatio: 2 });
        map.addLayer({
          id: "iss-trail", type: "line", source: "iss",
          filter: ["==", ["geometry-type"], "LineString"],
          paint: { "line-color": "#00f0ff", "line-width": 1.6, "line-opacity": 0.55, "line-dasharray": [2, 2] },
        });
        map.addLayer({
          id: "iss-dot", type: "symbol", source: "iss",
          filter: ["==", ["geometry-type"], "Point"],
          layout: {
            "icon-image": "iss-sat", "icon-size": 1.1, "icon-allow-overlap": true,
            "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 11,
            "text-offset": [0, 1.4], "text-anchor": "top", "text-allow-overlap": true,
          },
          paint: { "text-color": "#00f0ff", "text-halo-color": "#020610", "text-halo-width": 1.5 },
        });
      } else {
        map.setLayoutProperty("iss-trail", "visibility", "visible");
        map.setLayoutProperty("iss-dot", "visibility", "visible");
      }
      if (chip) chip.classList.remove("hidden");
      state.issFollow = !!onFollow;
      issTick();
      state.issTimer = setInterval(issTick, 8000);
    } else {
      clearInterval(state.issTimer);
      state.issFollow = false;
      if (chip) chip.classList.add("hidden");
      if (map.getLayer("iss-dot")) {
        map.setLayoutProperty("iss-dot", "visibility", "none");
        map.setLayoutProperty("iss-trail", "visibility", "none");
      }
    }
    return state.iss;
  }

  // ============================================================== RADAR ====
  async function loadRadar() {
    const meta = await Sources.fetchJSON("https://api.rainviewer.com/public/weather-maps.json");
    state.radarFrames = [...(meta.radar && meta.radar.past || []), ...(meta.radar && meta.radar.nowcast || [])].slice(-10);
    state.radarHost = meta.host || "https://tilecache.rainviewer.com";
    state.radarIdx = Math.max(0, meta.radar && meta.radar.past ? meta.radar.past.length - 1 : 0);
  }

  function radarTiles() {
    const f = state.radarFrames[state.radarIdx];
    if (!f) return [];
    return [`${state.radarHost}${f.path}/256/{z}/{x}/{y}/4/1_1.png`];
  }

  function applyRadarFrame() {
    const src = map.getSource("radar");
    if (src) {
      src.setTiles(radarTiles());
      const lbl = document.getElementById("radar-time");
      if (lbl && state.radarFrames[state.radarIdx]) {
        lbl.textContent = new Date(state.radarFrames[state.radarIdx].time * 1000).toISOString().slice(11, 16) + "Z";
      }
      const sl = document.getElementById("radar-slider");
      if (sl) { sl.max = state.radarFrames.length - 1; sl.value = state.radarIdx; }
    }
  }

  async function toggleRadar() {
    state.radar = !state.radar;
    const ctl = document.getElementById("radar-ctl");
    if (state.radar) {
      try { await loadRadar(); } catch (e) { return false; }
      if (!map.getSource("radar")) {
        map.addSource("radar", { type: "raster", tiles: radarTiles(), tileSize: 256, maxzoom: 12,
          attribution: "Weather radar: RainViewer" });
        map.addLayer({ id: "radar-tiles", type: "raster", source: "radar",
          paint: { "raster-opacity": 0.65 } });
      } else {
        map.setLayoutProperty("radar-tiles", "visibility", "visible");
      }
      applyRadarFrame();
      if (ctl) ctl.classList.remove("hidden");
      playRadar();
    } else {
      state.radarPlaying = false;
      clearInterval(state.radarTimer);
      if (ctl) ctl.classList.add("hidden");
      if (map.getLayer("radar-tiles")) map.setLayoutProperty("radar-tiles", "visibility", "none");
    }
    return state.radar;
  }

  function playRadar() {
    state.radarPlaying = true;
    clearInterval(state.radarTimer);
    state.radarTimer = setInterval(() => {
      state.radarIdx = (state.radarIdx + 1) % Math.max(1, state.radarFrames.length);
      applyRadarFrame();
    }, 700);
  }
  function pauseRadar() {
    state.radarPlaying = false;
    clearInterval(state.radarTimer);
  }

  // =============================================================== ROUTE ===
  function haversine(a, b) {
    const [l1, f1] = a, [l2, f2] = b;
    const s = Math.sin;
    const c = Math.cos;
    const R = 6371;
    const dφ = (f2 - f1) * rad, dλ = (l2 - l1) * rad;
    const h = s(dφ / 2) ** 2 + c(f1 * rad) * c(f2 * rad) * s(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** distance (km) from point p to segment ab, plus t = position along (0..1) */
  function segDist(p, a, b) {
    const φ0 = ((a[1] + b[1]) / 2) * rad;
    const pr = 111.32; // km per deg lng at equator → scaled below
    const P = [p[0] * pr * Math.cos(φ0), p[1] * pr];
    const A = [a[0] * pr * Math.cos(φ0), a[1] * pr];
    const B = [b[0] * pr * Math.cos(φ0), b[1] * pr];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = A[0] + t * dx, cy = A[1] + t * dy;
    return [Math.hypot(P[0] - cx, P[1] - cy), t];
  }

  async function geocode(q) {
    const r = await Sources.fetchJSON(
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q));
    if (!r.length) throw new Error("place not found: " + q);
    return [+r[0].lon, +r[0].lat];
  }

  function clearRoute() {
    ["route-line", "route-cams"].forEach(l => { if (map.getLayer(l)) map.removeLayer(l); });
    if (map.getSource("route")) map.removeSource("route");
  }

  function renderRouteResults(hits, listEl, totalKm) {
    if (!listEl) return;
    if (!hits.length) {
      listEl.innerHTML = '<div class="route-empty">no public cameras within 8 km of the corridor</div>';
      return;
    }
    listEl.innerHTML =
      `<div class="route-summary">${hits.length} cams · ${Math.round(totalKm)} km corridor</div>` +
      hits.map((h, i) => `
        <li data-id="${h.cam.id}" class="route-hit">
          <span class="route-km">${h.t > 0 ? Math.round(h.t * totalKm) : 0} km</span>
          <div><div class="cam-name">${h.cam.name}</div>
          <div class="cam-sub">${[h.cam.place, h.cam.region, h.cam.country].filter(Boolean).join(" · ")}</div></div>
          <span class="badge ${h.cam.stype}">${h.cam.stype}</span>
        </li>`).join("");
    listEl.querySelectorAll("li[data-id]").forEach(li =>
      li.onclick = () => window.dispatchEvent(new CustomEvent("ge-open-cam", { detail: li.dataset.id })));
  }

  async function sweepRoute(qA, qB, listEl) {
    const a = await geocode(qA), b = await geocode(qB);
    clearRoute();
    // geodesic-ish polyline with midpoints for great-circle curvature
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const lift = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.12;
    const mids = [];
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      mids.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + lift * Math.sin(Math.PI * t) * 0.3]);
    }
    const line = [a, ...mids, b];
    const totalKm = haversine(a, b);

    const hits = [];
    for (const c of Object.values(window.GE_CAMS || {})) {
      let best = null;
      for (let i = 0; i < line.length - 1; i++) {
        const [d, t] = segDist([c.lon, c.lat], line[i], line[i + 1]);
        const tt = (i + t) / (line.length - 1);
        if (d <= 8 && (!best || d < best.d)) best = { d, t: tt };
      }
      if (best) hits.push({ cam: c, ...best });
    }
    hits.sort((x, y) => x.t - y.t);
    const top = hits.slice(0, 60);

    map.addSource("route", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [
        { type: "Feature", properties: { kind: "line" },
          geometry: { type: "LineString", coordinates: line } },
        ...top.map(h => ({ type: "Feature", properties: { kind: "cam" },
          geometry: { type: "Point", coordinates: [h.cam.lon, h.cam.lat] } })),
      ] },
    });
    map.addLayer({
      id: "route-line", type: "line", source: "route",
      filter: ["==", ["get", "kind"], "line"],
      paint: { "line-color": "#ffb300", "line-width": 2.4, "line-opacity": 0.85, "line-dasharray": [3, 1.5] },
    });
    map.addLayer({
      id: "route-cams", type: "circle", source: "route",
      filter: ["==", ["get", "kind"], "cam"],
      paint: {
        "circle-color": "#ffb300", "circle-radius": 6,
        "circle-stroke-color": "#fff", "circle-stroke-width": 1.2,
      },
    });
    map.fitBounds([[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]],
      { padding: 90, duration: 1800 });
    renderRouteResults(top, listEl, totalKm);
    return top;
  }

  // ================================================================ AIR ===
  function planeIcon() {
    const c = document.createElement("canvas"); c.width = c.height = 48;
    const g = c.getContext("2d");
    g.translate(24, 24); g.rotate(Math.PI); // nose points up after rotation by track
    g.fillStyle = "#04101a"; g.strokeStyle = "#2aff8b"; g.lineWidth = 2.2;
    g.shadowColor = "#2aff8b"; g.shadowBlur = 6;
    g.beginPath();
    g.moveTo(0, -14); g.lineTo(7, 4); g.lineTo(13, 10); g.lineTo(7, 8);
    g.lineTo(5, 14); g.lineTo(0, 11); g.lineTo(-5, 14); g.lineTo(-7, 8);
    g.lineTo(-13, 10); g.lineTo(-7, 4); g.closePath();
    g.fill(); g.stroke();
    return g.getImageData(0, 0, 48, 48);
  }

  async function airTick() {
    const c = map.getCenter();
    const zoom = map.getZoom();
    const radius = Math.min(250, Math.max(30, 30 * Math.pow(1.45, zoom)));
    const q = `${c.lat.toFixed(2)}/${c.lon.toFixed(2)}/${Math.round(radius)}`;
    let ac = [];
    try {
      const d = await Sources.fetchJSON("https://api.airplanes.live/v2/point/" + q);
      ac = (d.ac || []).filter(a => a.lat != null && a.lon != null);
    } catch (e) {
      try {
        const d = await Sources.fetchJSON("https://api.adsb.lol/v2/point/" + q);
        ac = (d.ac || []).filter(a => a.lat != null && a.lon != null);
      } catch (e2) { return; }
    }
    ac = ac.slice(0, 350);
    const src = map.getSource("air");
    if (!src) return;
    src.setData({ type: "FeatureCollection", features: ac.map(a => ({
      type: "Feature",
      properties: {
        callsign: (a.flight || a.r || a.hex || "?").trim(),
        track: a.track != null ? a.track : (a.true_heading != null ? a.true_heading : 0),
        alt: a.altt || a.alt_baro || a.alt || "?",
        gs: Math.round(a.gs || 0),
        type: a.t || "",
      },
      geometry: { type: "Point", coordinates: [a.lon, a.lat] },
    })) });
    const chip = document.getElementById("air-chip");
    if (chip) chip.textContent = `✈ ${ac.length} aircraft`;
  }

  function toggleAir() {
    state.air = !state.air;
    const chip = document.getElementById("air-chip");
    if (state.air) {
      if (!map.getSource("air")) {
        map.addSource("air", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        if (!map.hasImage("plane")) map.addImage("plane", planeIcon(), { pixelRatio: 2 });
        map.addLayer({
          id: "air-dots", type: "symbol", source: "air",
          layout: {
            "icon-image": "plane", "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 8, 0.8, 12, 1],
            "icon-rotate": ["get", "track"], "icon-rotation-alignment": "map",
            "icon-allow-overlap": true, "icon-padding": 1,
          },
        });
        map.on("click", "air-dots", (e2) => {
          const f = e2.features && e2.features[0];
          if (!f) return;
          const p = f.properties;
          new maplibregl.Popup({ closeButton: false, maxWidth: "260px" })
            .setLngLat(f.geometry.coordinates)
            .setHTML(`<b style="color:#2aff8b">${p.callsign}</b><br>
              ${p.alt} ft · ${p.gs} kt${p.type ? " · " + p.type : ""}`)
            .addTo(map);
        });
        map.on("mouseenter", "air-dots", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "air-dots", () => { map.getCanvas().style.cursor = ""; });
      } else {
        map.setLayoutProperty("air-dots", "visibility", "visible");
      }
      if (chip) chip.classList.remove("hidden");
      airTick();
      state.airTimer = setInterval(airTick, 10000);
      state.airMoveTimer = null;
      map.on("moveend", () => {
        if (!state.air) return;
        clearTimeout(state.airMoveTimer);
        state.airMoveTimer = setTimeout(airTick, 800);
      });
    } else {
      clearInterval(state.airTimer);
      clearTimeout(state.airMoveTimer);
      if (chip) chip.classList.add("hidden");
      if (map.getLayer("air-dots")) map.setLayoutProperty("air-dots", "visibility", "none");
    }
    return state.air;
  }

  function init(m) {
    map = m;
    window.GE_CAMS = window.GE_CAMS || {};
  }

  return { init, toggleNight, toggleISS, toggleRadar, toggleAir, playRadar, pauseRadar, applyRadarFrame, sweepRoute, clearRoute,
           get state() { return state; } };
})();
