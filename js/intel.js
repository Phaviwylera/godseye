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
    air: false, airTimer: null, airMoveTimer: null, airLoading: false, airHandlersBound: false, airMoveBound: false,
    airTrack: null, airFollow: false, airCockpit: false, airSavedCamera: null, airFeatures: [],
    airHistory: new Map(),
    airLast: 0,
    airScope: "nearby",
    airPopup: null,
    quakes: false, quakesTimer: null, quakesLoading: false,
  };

  /* How long one aircraft answer is shared site-wide by the relay. The provider rate-limits by
   * IP and every visitor shares the relay's address, so this is what keeps the layer alive
   * under load instead of spending the limit once per tab. */
  const AIR_WINDOW_SEC = 20;

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
    g.strokeStyle = "#8be9fa"; g.fillStyle = "#031018"; g.lineWidth = 2.2;
    g.shadowColor = "#8be9fa"; g.shadowBlur = 8;
    // solar panels
    g.beginPath(); g.roundRect(3, 18, 14, 12, 2); g.roundRect(31, 18, 14, 12, 2); g.fill(); g.stroke();
    // body
    g.beginPath(); g.roundRect(18, 16, 12, 16, 3); g.fill(); g.stroke();
    // antenna
    g.beginPath(); g.moveTo(24, 16); g.lineTo(24, 8); g.stroke();
    g.fillStyle = "#41efc2"; g.beginPath(); g.arc(24, 7, 2.4, 0, 7); g.fill();
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
          paint: { "line-color": "#8be9fa", "line-width": 1.6, "line-opacity": 0.55, "line-dasharray": [2, 2] },
        });
        map.addLayer({
          id: "iss-dot", type: "symbol", source: "iss",
          filter: ["==", ["geometry-type"], "Point"],
          layout: {
            "icon-image": "iss-sat", "icon-size": 1.1, "icon-allow-overlap": true,
            "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 11,
            "text-offset": [0, 1.4], "text-anchor": "top", "text-allow-overlap": true,
          },
          paint: { "text-color": "#8be9fa", "text-halo-color": "#02070b", "text-halo-width": 1.5 },
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
    /* RainViewer colour scheme 2 (Universal Blue): cool white-to-blue only, chosen to sit
     * inside the interface's desaturated cyan/graphite palette — the multi-colour schemes
     * (4/5/6) throw warm alarms across the whole globe and fight every other layer. */
    return [`${state.radarHost}${f.path}/256/{z}/{x}/{y}/2/1_1.png`];
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
          paint: { "raster-opacity": 0.55 } });  // low-intensity overlay: weather informs, it does not blind other layers
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
      paint: { "line-color": "#d9b56d", "line-width": 2.4, "line-opacity": 0.85, "line-dasharray": [3, 1.5] },
    });
    map.addLayer({
      id: "route-cams", type: "circle", source: "route",
      filter: ["==", ["get", "kind"], "cam"],
      paint: {
        "circle-color": "#d9b56d", "circle-radius": 6,
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
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d");
    g.translate(32, 32); // nose points north; icon-rotate applies the reported heading
    g.fillStyle = "#69ffe0"; g.strokeStyle = "#e6fff8"; g.lineWidth = 2.8;
    g.shadowColor = "#41efc2"; g.shadowBlur = 9;
    g.beginPath();
    g.moveTo(0, -24); g.lineTo(5, -3); g.lineTo(23, 9); g.lineTo(23, 14);
    g.lineTo(5, 10); g.lineTo(5, 21); g.lineTo(11, 25); g.lineTo(11, 28);
    g.lineTo(0, 25); g.lineTo(-11, 28); g.lineTo(-11, 25); g.lineTo(-5, 21);
    g.lineTo(-5, 10); g.lineTo(-23, 14); g.lineTo(-23, 9); g.lineTo(-5, -3); g.closePath();
    g.fill(); g.stroke();
    g.shadowBlur = 0; g.fillStyle = "#07333b"; g.fillRect(-2, -8, 4, 18);
    return g.getImageData(0, 0, 64, 64);
  }

  /** Dedicated pin for the selected aircraft: large teal plane inside a glowing ring. */
  function planePinIcon() {
    const c = document.createElement("canvas"); c.width = c.height = 72;
    const g = c.getContext("2d");
    g.beginPath(); g.arc(36, 36, 33, 0, 7);
    g.fillStyle = "rgba(4, 28, 34, 0.85)"; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = "#41efc2";
    g.shadowColor = "#41efc2"; g.shadowBlur = 10; g.stroke();
    g.shadowBlur = 0;
    g.translate(36, 36); // nose points north; icon-rotate applies the reported heading
    g.fillStyle = "#69ffe0"; g.strokeStyle = "#e6fff8"; g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(0, -20); g.lineTo(4, -3); g.lineTo(19, 8); g.lineTo(19, 12);
    g.lineTo(4, 8); g.lineTo(4, 17); g.lineTo(9, 21); g.lineTo(9, 23);
    g.lineTo(0, 21); g.lineTo(-9, 23); g.lineTo(-9, 21); g.lineTo(-4, 17);
    g.lineTo(-4, 8); g.lineTo(-19, 12); g.lineTo(-19, 8); g.lineTo(-4, -3); g.closePath();
    g.fill(); g.stroke();
    g.fillStyle = "#07333b"; g.fillRect(-2, -7, 4, 15);
    return g.getImageData(0, 0, 72, 72);
  }

  function setAirTrackData() {
    const src = map.getSource("air-track");
    const points = state.airTrack ? state.airTrack.points : [];
    if (src) {
      src.setData({
        type: "FeatureCollection",
        features: points.length > 1 ? [{
          type: "Feature",
          properties: { callsign: state.airTrack.callsign },
          geometry: { type: "LineString", coordinates: points.map(point => point.coordinates) },
        }] : [],
      });
    }
    map.getSource("air-track-points")?.setData({ type: "FeatureCollection", features: points.length < 2 ? [] : [
      { type: "Feature", properties: { label: "FIRST OBSERVED" }, geometry: { type: "Point", coordinates: points[0].coordinates } },
      { type: "Feature", properties: { label: "LATEST" }, geometry: { type: "Point", coordinates: points.at(-1).coordinates } },
    ] });
    // Waypoint dots on every earlier observation; the pin marks the latest one.
    map.getSource("air-track-waypoints")?.setData({ type: "FeatureCollection",
      features: points.length < 2 ? [] : points.slice(0, -1).map(p => ({
        type: "Feature", properties: { observed: p.time },
        geometry: { type: "Point", coordinates: p.coordinates },
      })) });
    const last = points.at(-1);
    const rawHeading = Number(state.airTrack && state.airTrack.track);
    map.getSource("air-pin")?.setData({ type: "FeatureCollection",
      features: state.airTrack && last ? [{
        type: "Feature",
        properties: {
          callsign: state.airTrack.callsign,
          heading: Number.isFinite(rawHeading) ? rawHeading : 0,
        },
        geometry: { type: "Point", coordinates: last.coordinates },
      }] : [] });
  }

  function updateAirChip(count) {
    const chip = document.getElementById("air-chip");
    if (!chip) return;
    if (!state.airTrack) {
      chip.textContent = `✈ ${count} AIRCRAFT · ${state.airScope === "regions" ? "4 REGIONS" : "NEARBY"}`;
      chip.title = state.airScope === "regions"
        ? "Sampled aircraft near Chennai, Singapore, London and New York. Click to browse the current aircraft."
        : "Aircraft near the map center. Click to browse the current aircraft.";
      return;
    }
    const ago = Math.max(0, Math.round((Date.now() - state.airTrack.lastSeen) / 1000));
    const freshness = ago < 30 ? "LIVE" : `SEEN ${Math.floor(ago / 60)}m AGO`;
    chip.textContent = `✈ ${state.airTrack.callsign} · ${freshness} · ${state.airCockpit ? "COCKPIT" : state.airFollow ? "FOLLOW ON" : "FOLLOW OFF"}`;
    chip.title = "Click to browse aircraft. Select a plane on the map to inspect its observed trail.";
  }

  function positionAirCockpit(coordinates, heading, duration) {
    const bearing = Number.isFinite(Number(heading)) ? Number(heading) : map.getBearing();
    const lat = coordinates[1] * rad;
    const behind = (bearing + 180) * rad;
    const distanceKm = 38;
    const center = [
      coordinates[0] + Math.sin(behind) * distanceKm / (111.32 * Math.max(0.05, Math.cos(lat))),
      Math.max(-85, Math.min(85, coordinates[1] + Math.cos(behind) * distanceKm / 111.32)),
    ];
    map.easeTo({ center, zoom: 8, bearing, pitch: 55, duration });
  }

  function leaveAirCockpit() {
    const camera = state.airSavedCamera;
    state.airCockpit = false;
    state.airSavedCamera = null;
    if (camera) map.easeTo({ ...camera, duration: 1200 });
  }

  function toggleAirCockpit() {
    if (!state.airTrack) return false;
    if (state.airCockpit) {
      leaveAirCockpit();
      state.airFollow = false;
    } else {
      state.airSavedCamera = {
        center: map.getCenter().toArray(),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
      state.airCockpit = true;
      state.airFollow = true;
      const last = state.airTrack.points[state.airTrack.points.length - 1];
      if (last) positionAirCockpit(last.coordinates, state.airTrack.track, 1500);
    }
    updateAirChip(state.airFeatures.length);
    return state.airCockpit;
  }

  function selectAirTrack(record) {
    const existing = state.airTrack;
    if (existing && existing.hex === record.hex) {
      if (state.airCockpit) leaveAirCockpit();
      state.airTrack = null;
      state.airFollow = false;
    } else {
      if (state.airCockpit) leaveAirCockpit();
      state.airTrack = {
        hex: record.hex,
        callsign: record.callsign,
        track: record.track,
        points: [...(state.airHistory.get(record.hex) || [{ coordinates: record.coordinates, time: Date.now() }])],
        lastSeen: Date.now(),
      };
      state.airFollow = false;
      map.easeTo({ center: record.coordinates, duration: 900 });
    }
    setAirTrackData();
    updateAirChip(state.airFeatures.length);
    state.airFeatures.forEach(feature => {
      feature.properties.tracked = !!state.airTrack && feature.properties.hex === state.airTrack.hex;
    });
    const source = map.getSource("air");
    if (source) source.setData({ type: "FeatureCollection", features: state.airFeatures });
    return !!state.airTrack;
  }

  function toggleAirFollow() {
    if (!state.airTrack) return false;
    if (state.airCockpit) {
      leaveAirCockpit();
      state.airFollow = false;
      updateAirChip(state.airFeatures.length);
      return false;
    }
    state.airFollow = !state.airFollow;
    updateAirChip(state.airFeatures.length);
    if (state.airFollow && state.airTrack.points.length) {
      map.easeTo({
        center: state.airTrack.points[state.airTrack.points.length - 1].coordinates,
        duration: 900,
      });
    }
    return state.airFollow;
  }

  function addAirLayers() {
    if (!map.getSource("air")) {
      state.airFeatures = [];
      map.addSource("air", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getSource("air-track")) {
      map.addSource("air-track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getSource("air-track-points")) {
      map.addSource("air-track-points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getSource("air-track-waypoints")) {
      map.addSource("air-track-waypoints", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getSource("air-pin")) {
      map.addSource("air-pin", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    // Use a private image id: map styles may already define a small dark "plane" sprite.
    if (!map.hasImage("ge-aircraft-teal-v3")) map.addImage("ge-aircraft-teal-v3", planeIcon(), { pixelRatio: 2 });
    if (!map.hasImage("ge-aircraft-pin-teal")) map.addImage("ge-aircraft-pin-teal", planePinIcon(), { pixelRatio: 2 });
    if (!map.getLayer("air-track-line")) {
      map.addLayer({
        id: "air-track-line", type: "line", source: "air-track",
        paint: {
          "line-color": "#41efc2",
          "line-width": 2.5,
          "line-opacity": 0.9,
          "line-dasharray": [2, 2],
        },
      });
    }
    if (!map.getLayer("air-track-labels")) {
      map.addLayer({
        id: "air-track-labels", type: "symbol", source: "air-track-points",
        layout: { "text-field": ["get", "label"], "text-size": 10,
          "text-offset": [0, 3], "text-allow-overlap": true },
        paint: { "text-color": "#a9f9eb", "text-halo-color": "#041c22", "text-halo-width": 2 },
      });
    }
    if (!map.getLayer("air-dots")) {
      map.addLayer({
        id: "air-dots", type: "symbol", source: "air",
        layout: {
          "icon-image": "ge-aircraft-teal-v3",
          // Keep planes compact so they never blanket the map: small on the
          // globe, growing gradually as the user zooms in.
          "icon-size": ["case", ["get", "tracked"], 1.15,
            ["interpolate", ["linear"], ["zoom"], 3, 0.55, 8, 0.7, 12, 0.95]],
          "icon-rotate": ["get", "track"], "icon-rotation-alignment": "map",
          "icon-allow-overlap": true, "icon-padding": 1,
        },
        // The dedicated tracked pin replaces the fleet icon for the selected plane.
        paint: { "icon-opacity": ["case", ["get", "tracked"], 0, 1] },
      });
    }
    if (!map.getLayer("air-track-waypoint-dots")) {
      map.addLayer({
        id: "air-track-waypoint-dots", type: "circle", source: "air-track-waypoints",
        paint: { "circle-radius": 3, "circle-color": "#9afbe9",
          "circle-stroke-color": "#06232a", "circle-stroke-width": 1 },
      });
    }
    if (!map.getLayer("air-tracked-pin")) {
      map.addLayer({
        id: "air-tracked-pin", type: "symbol", source: "air-pin",
        layout: {
          "icon-image": "ge-aircraft-pin-teal",
          // Compact on the globe, full prominence once the user zooms in.
          "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.7, 8, 1.0, 12, 1.3],
          "icon-rotate": ["get", "heading"], "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
        },
      });
    }
    if (!state.airHandlersBound) {
      state.airHandlersBound = true;
      map.on("click", "air-dots", (event) => {
        const feature = event.features && event.features[0];
        if (!feature) return;
        const properties = feature.properties || {};
        const record = {
          hex: String(properties.hex || ""),
          callsign: String(properties.callsign || properties.hex || "Unknown aircraft"),
          coordinates: feature.geometry.coordinates,
          track: Number(properties.track),
        };
        if (!record.hex) return;
        const tracking = selectAirTrack(record);
        const content = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = record.callsign;
        title.style.color = "#41efc2";
        content.appendChild(title);
        const details = document.createElement("div");
        details.textContent = [
          properties.type && `Aircraft ${properties.type}`,
          properties.alt != null && `Altitude ${properties.alt} ft`,
          properties.gs != null && `Speed ${properties.gs} kt`,
          properties.track != null && `Heading ${Math.round(Number(properties.track))}°`,
        ].filter(Boolean).join(" · ");
        content.appendChild(details);
        const note = document.createElement("div");
        const paintNote = () => {
          const tracked = state.airTrack && state.airTrack.hex === record.hex ? state.airTrack : null;
          note.textContent = tracked && tracked.points.length > 1
            ? `${tracked.points.length} observed positions in the last hour · the large teal pin marks the latest`
            : "Dashed trail, waypoint dots and pin appear after a second distinct position is observed";
        };
        paintNote();
        content.appendChild(note);
        // Live telemetry strip: altitude (bright) and speed (dim) over the
        // last hour, redrawn on every feed refresh while the popup is open.
        const strip = document.createElement("canvas");
        strip.width = 264; strip.height = 56;
        strip.style.width = "100%"; strip.style.margin = "6px 0 2px";
        strip.style.borderBottom = "1px solid rgba(65, 239, 194, 0.25)";
        content.appendChild(strip);
        const readout = document.createElement("div");
        readout.style.fontVariantNumeric = "tabular-nums";
        readout.style.opacity = "0.9";
        content.appendChild(readout);
        state.airPopup = { hex: record.hex, canvas: strip, readout };
        const action = document.createElement("button");
        action.type = "button";
        action.textContent = tracking ? "STOP TRACKING" : "TRACK AIRCRAFT";
        action.onclick = () => {
          const isTracking = selectAirTrack(record);
          action.textContent = isTracking ? "STOP TRACKING" : "TRACK AIRCRAFT";
          paintNote();
        };
        content.appendChild(action);
        const cockpit = document.createElement("button");
        cockpit.type = "button";
        cockpit.textContent = state.airCockpit ? "EXIT COCKPIT" : "COCKPIT VIEW";
        cockpit.disabled = !tracking;
        cockpit.onclick = () => {
          const active = toggleAirCockpit();
          cockpit.textContent = active ? "EXIT COCKPIT" : "COCKPIT VIEW";
        };
        content.appendChild(cockpit);
        new maplibregl.Popup({ closeButton: true, maxWidth: "320px" })
          .setLngLat(record.coordinates)
          .setDOMContent(content)
          .on("close", () => { if (state.airPopup && state.airPopup.hex === record.hex) state.airPopup = null; })
          .addTo(map);
        paintAirTelemetry();
      });
      map.on("mouseenter", "air-dots", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "air-dots", () => { map.getCanvas().style.cursor = "grab"; });
    }
    setAirTrackData();
  }

  function airAgeText(stamp) {
    const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    return `${(seconds / 3600).toFixed(1)} h`;
  }

  /* A failed poll keeps the aircraft already drawn — the layer is stale, not empty — so the
   * chip says how old the sweep is rather than announcing that the feed does not exist. */
  function showAirError(error) {
    const chip = document.getElementById("air-chip");
    if (!chip) return;
    const reason = String(error && error.message || error);
    if (state.airFeatures.length && state.airLast) {
      const age = airAgeText(state.airLast);
      chip.textContent = `✈ ${state.airFeatures.length} AIRCRAFT · HELD ${age.toUpperCase()}`;
      chip.title = `${reason}. Showing the last sweep that succeeded, ${age} ago.`;
      return;
    }
    chip.textContent = "✈ AIR FEED UNAVAILABLE";
    chip.title = reason;
  }

  /** Major airports (IATA, name, lat, lon) for the nearest-field readout. */
  const AIRPORTS = [
    ["MAA", "Chennai", 12.994, 80.171], ["DEL", "Delhi", 28.56, 77.1], ["BOM", "Mumbai", 19.09, 72.87],
    ["BLR", "Bengaluru", 13.2, 77.71], ["HYD", "Hyderabad", 17.24, 78.43], ["CCU", "Kolkata", 22.65, 88.45],
    ["GOI", "Goa", 15.38, 73.83], ["CMB", "Colombo", 7.18, 79.88], ["KTM", "Kathmandu", 27.7, 85.36],
    ["DAC", "Dhaka", 23.84, 90.4], ["MLE", "Male", 4.19, 73.53], ["SIN", "Singapore", 1.36, 103.99],
    ["BKK", "Bangkok", 13.69, 100.75], ["KUL", "Kuala Lumpur", 2.75, 101.71], ["CGK", "Jakarta", -6.13, 106.66],
    ["MNL", "Manila", 14.51, 121.02], ["HKG", "Hong Kong", 22.31, 113.91], ["PEK", "Beijing", 40.08, 116.58],
    ["PVG", "Shanghai", 31.14, 121.81], ["HND", "Tokyo Haneda", 35.55, 139.78], ["NRT", "Tokyo Narita", 35.77, 140.39],
    ["ICN", "Seoul", 37.46, 126.44], ["DXB", "Dubai", 25.25, 55.36], ["AUH", "Abu Dhabi", 24.43, 54.65],
    ["DOH", "Doha", 25.27, 51.61], ["RUH", "Riyadh", 24.96, 46.7], ["JED", "Jeddah", 21.68, 39.16],
    ["TLV", "Tel Aviv", 32.01, 34.89], ["CAI", "Cairo", 30.11, 31.41], ["NBO", "Nairobi", -1.32, 36.93],
    ["ADD", "Addis Ababa", 8.98, 38.8], ["JNB", "Johannesburg", -26.14, 28.25], ["CPT", "Cape Town", -33.97, 18.6],
    ["LOS", "Lagos", 6.58, 3.32], ["IST", "Istanbul", 41.26, 28.74], ["SVO", "Moscow", 55.97, 37.41],
    ["FRA", "Frankfurt", 50.03, 8.56], ["CDG", "Paris", 49.01, 2.55], ["AMS", "Amsterdam", 52.31, 4.76],
    ["MAD", "Madrid", 40.47, -3.57], ["BCN", "Barcelona", 41.3, 2.08], ["FCO", "Rome", 41.8, 12.25],
    ["MUC", "Munich", 48.35, 11.79], ["ZRH", "Zurich", 47.46, 8.55], ["VIE", "Vienna", 48.11, 16.57],
    ["CPH", "Copenhagen", 55.62, 12.66], ["OSL", "Oslo", 60.19, 11.1], ["ARN", "Stockholm", 59.65, 17.92],
    ["HEL", "Helsinki", 60.32, 24.96], ["WAW", "Warsaw", 52.17, 20.97], ["LIS", "Lisbon", 38.77, -9.13],
    ["DUB", "Dublin", 53.43, -6.24], ["MAN", "Manchester", 53.35, -2.28], ["EDI", "Edinburgh", 55.95, -3.37],
    ["LHR", "London Heathrow", 51.47, -0.45], ["LGW", "London Gatwick", 51.15, -0.19],
    ["JFK", "New York JFK", 40.64, -73.78], ["EWR", "Newark", 40.69, -74.17], ["LGA", "New York LaGuardia", 40.78, -73.87],
    ["LAX", "Los Angeles", 33.94, -118.41], ["SFO", "San Francisco", 37.62, -122.38], ["SEA", "Seattle", 47.45, -122.31],
    ["ORD", "Chicago", 41.97, -87.91], ["DFW", "Dallas", 32.9, -97.04], ["ATL", "Atlanta", 33.64, -84.43],
    ["MIA", "Miami", 25.79, -80.29], ["YYZ", "Toronto", 43.68, -79.63], ["YVR", "Vancouver", 49.19, -123.18],
    ["HNL", "Honolulu", 21.32, -157.92], ["ANC", "Anchorage", 61.17, -149.99], ["MEX", "Mexico City", 19.44, -99.07],
    ["BOG", "Bogota", 4.7, -74.15], ["GRU", "Sao Paulo", -23.44, -46.47], ["EZE", "Buenos Aires", -34.82, -58.54],
    ["SCL", "Santiago", -33.39, -70.79], ["SYD", "Sydney", -33.95, 151.18], ["MEL", "Melbourne", -37.67, 144.84],
    ["BNE", "Brisbane", -27.38, 153.12], ["AKL", "Auckland", -37.01, 174.79],
  ];

  function haversineKm(lon1, lat1, lon2, lat2) {
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(s));
  }

  /** Closest bundled airport to a position: {code, name, km}. */
  function nearestAirport(lon, lat) {
    let best = null;
    for (const [code, name, alat, alon] of AIRPORTS) {
      const km = haversineKm(lon, lat, alon, alat);
      if (!best || km < best.km) best = { code, name, km };
    }
    return best;
  }

  /** Altitude/ground-speed series from track points; non-numeric samples become null. */
  function airTelemetrySeries(points) {
    return {
      alt: points.map(p => liveAlt(p.alt)),
      gs: points.map(p => (Number.isFinite(Number(p.gs)) ? Number(p.gs) : null)),
    };
  }

  function formatAlt(value) {
    if (value == null) return "?";
    return Math.round(value).toLocaleString("en-US");
  }

  /** Repaint the live telemetry strip in the open tracked-aircraft popup, if any. */
  function paintAirTelemetry() {
    const ui = state.airPopup;
    if (!ui || !state.airTrack || state.airTrack.hex !== ui.hex) return;
    const canvas = ui.canvas, g = canvas.getContext && canvas.getContext("2d");
    if (!g) return;
    const series = airTelemetrySeries(state.airTrack.points);
    const width = canvas.width || 264, height = canvas.height || 56;
    canvas.width = width; // resets the bitmap, also clears
    const pad = 4, plotH = height - 12;
    const plot = (values, lo, hi) => {
      const span = Math.max(hi - lo, 1);
      let pen = false;
      g.beginPath();
      values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        const x = pad + i * (width - pad * 2) / Math.max(values.length - 1, 1);
        const y = 4 + plotH - (v - lo) / span * plotH;
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
      });
      g.stroke();
    };
    g.lineWidth = 1.6;
    g.strokeStyle = "#41efc2"; // altitude
    if (series.alt.some(v => v != null)) {
      const finite = series.alt.filter(v => v != null);
      const lo = Math.min(...finite), hi = Math.max(...finite);
      plot(series.alt, lo - 200, hi + 200);
      const lastIdx = series.alt.reduce((acc, v, i) => v != null ? i : acc, -1);
      if (lastIdx >= 0) {
        const span = Math.max(hi - lo, 400);
        const x = pad + lastIdx * (width - pad * 2) / Math.max(series.alt.length - 1, 1);
        const y = 4 + plotH - (series.alt[lastIdx] - (lo - 200)) / (span + 400) * plotH;
        g.beginPath(); g.arc(x, y, 2.4, 0, 7); g.fillStyle = "#a9f9eb"; g.fill();
      }
    }
    g.strokeStyle = "#5f8fa8"; // ground speed
    if (series.gs.some(v => v != null)) {
      const finite = series.gs.filter(v => v != null);
      plot(series.gs, Math.min(...finite) - 20, Math.max(...finite) + 20);
    }
    if (ui.readout) {
      const feature = state.airFeatures.find(f => f.properties.hex === ui.hex);
      const live = feature ? feature.properties : null;
      const last = [...state.airTrack.points].reverse().find(p => p.alt != null || p.gs != null) || {};
      const alt = live ? live.alt : last.alt;
      const gs = live ? live.gs : last.gs;
      const vs = live && live.vs != null ? Number(live.vs) : null;
      const vsText = vs != null && Number.isFinite(vs) && vs !== 0 ? ` · V/S ${vs > 0 ? "+" : ""}${Math.round(vs / 10) * 10} FPM` : "";
      const near = feature ? nearestAirport(feature.geometry.coordinates[0], feature.geometry.coordinates[1]) : null;
      const nearText = near ? ` · ${near.code} ${Math.round(near.km)} KM` : "";
      ui.readout.textContent =
        `ALT ${formatAlt(alt)} FT · GS ${gs != null ? Math.round(Number(gs)) : "?"} KT${vsText}${nearText}`;
    }
  }

  /** Current altitude as a number ("ground" counts as 0). */
  function liveAlt(alt) {
    if (alt == null) return null;
    const n = Number(alt);
    if (Number.isFinite(n)) return n;
    return String(alt).trim().toLowerCase() === "ground" ? 0 : null;
  }


  function rememberAircraft(features) {
    const now = Date.now(), cutoff = now - 60 * 60 * 1000;
    for (const feature of features) {
      const hex = feature.properties.hex;
      if (!hex) continue;
      const points = (state.airHistory.get(hex) || []).filter(p => p.time >= cutoff);
      const coordinates = feature.geometry.coordinates;
      const last = points.at(-1);
      if (!last || last.coordinates[0] !== coordinates[0] || last.coordinates[1] !== coordinates[1]) {
        // Telemetry samples ride along with each waypoint so the popup strip
        // can chart the altitude and speed trend of the last hour.
        points.push({
          coordinates, time: now,
          alt: liveAlt(feature.properties.alt),
          gs: Number.isFinite(Number(feature.properties.gs)) ? Number(feature.properties.gs) : null,
        });
      } else if (last.alt == null && feature.properties.alt != null) {
        last.alt = liveAlt(feature.properties.alt);
        last.gs = Number.isFinite(Number(feature.properties.gs)) ? Number(feature.properties.gs) : null;
      }
      state.airHistory.set(hex, points.slice(-120));
    }
    for (const [hex, points] of state.airHistory) {
      if (!points.length || points.at(-1).time < cutoff) state.airHistory.delete(hex);
    }
  }

  function openAirList() {
    if (!state.air) return;
    const center = map.getCenter();
    const contacts = [...state.airFeatures].sort((a, b) =>
      Math.abs(a.geometry.coordinates[0] - center.lng) + Math.abs(a.geometry.coordinates[1] - center.lat) -
      Math.abs(b.geometry.coordinates[0] - center.lng) - Math.abs(b.geometry.coordinates[1] - center.lat));
    Contacts.open(`${contacts.length} AIRCRAFT · ${state.airScope === "regions" ? "4 REGIONS" : "NEARBY"}`,
      contacts.map(feature => ({
        label: feature.properties.callsign,
        detail: `${feature.properties.alt} ft · ${feature.properties.gs} kt · ${feature.properties.hex}`,
        feature,
      })), row => {
        const feature = row.feature;
        selectAirTrack({ hex: feature.properties.hex, callsign: feature.properties.callsign,
          coordinates: feature.geometry.coordinates, track: feature.properties.track });
        map.easeTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 7),
          duration: 650, essential: true });
      });
  }

  async function fetchAirData() {
    const c = map.getCenter();
    const zoom = map.getZoom();
    const radius = Math.min(250, Math.max(30, 30 * Math.pow(1.45, zoom)));
    const localQuery = `${c.lat.toFixed(2)}/${c.lng.toFixed(2)}/${Math.round(radius)}`;
    // A radius around the default world center contains no aircraft. At wide
    // zooms sample four busy regions; local mode tracks the visible map center.
    const regional = zoom < 4;
    const targets = regional
      ? [[13.08, 80.27], [1.35, 103.82], [51.47, -0.46], [40.64, -73.78]]
      : [localQuery];
    const pull = async (target) => {
      const q = typeof target === "string" ? target : `${target[0].toFixed(2)}/${target[1].toFixed(2)}/220`;
      // The relay window collapses every visitor's poll into one upstream request: the
      // provider rate-limits by IP, and every visitor shares the function's address.
      const d = await Sources.fetchJSON("https://api.adsb.lol/v2/point/" + q, AIR_WINDOW_SEC);
      if (!Array.isArray(d.ac)) throw new Error("no ac array");
      return d.ac.filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon)).slice(0, regional ? 90 : 350);
    };
    const responses = await Promise.allSettled(targets.map(pull));
    const successful = responses.filter(result => result.status === "fulfilled");
    if (!successful.length) {
      // Say which provider error this was: a rate limit and a dead host need different fixes.
      const reason = responses.map(result => result.reason).find(Boolean);
      throw new Error(reason
        ? `Aircraft provider unavailable (${String(reason && reason.message || reason)})`
        : "Aircraft provider unavailable");
    }
    if (!state.air) return;
    state.airScope = regional ? "regions" : "nearby";
    const ac = [...new Map(successful.flatMap(result => result.value)
      .map(a => [String(a.hex || `${a.lat},${a.lon}`), a])).values()].slice(0, 350);
    const src = map.getSource("air");
    if (!src) return;
    const features = ac.map(a => ({
      type: "Feature",
      properties: {
        hex: String(a.hex || "").trim().toLowerCase(),
        callsign: (a.flight || a.r || a.hex || "?").trim(),
        track: a.track != null ? a.track : (a.true_heading != null ? a.true_heading : 0),
        alt: a.altt || a.alt_baro || a.alt || "?",
        gs: Math.round(a.gs || 0),
        vs: Number.isFinite(Number(a.baro_rate)) ? Math.round(Number(a.baro_rate))
          : Number.isFinite(Number(a.vert_rate)) ? Math.round(Number(a.vert_rate)) : null,
        type: a.t || "",
        tracked: !!state.airTrack && String(a.hex || "").trim().toLowerCase() === state.airTrack.hex,
      },
      geometry: { type: "Point", coordinates: [a.lon, a.lat] },
    }));
    rememberAircraft(features);
    state.airFeatures = features;
    state.airLast = Date.now();
    src.setData({ type: "FeatureCollection", features });
    if (state.airTrack) {
      const tracked = features.find(feature => feature.properties.hex === state.airTrack.hex);
      if (tracked) {
        const coordinates = tracked.geometry.coordinates;
        const now = Date.now();
        state.airTrack.points = [...(state.airHistory.get(state.airTrack.hex) || [])];
        state.airTrack.callsign = tracked.properties.callsign;
        state.airTrack.track = Number(tracked.properties.track);
        state.airTrack.lastSeen = now;
        setAirTrackData();
        if (state.airCockpit) positionAirCockpit(coordinates, state.airTrack.track, 900);
        else if (state.airFollow) map.easeTo({ center: coordinates, duration: 900 });
      }
    }
    updateAirChip(ac.length);
  }

  async function airTick() {
    if (!state.air || state.airLoading) return;
    state.airLoading = true;
    try {
      await fetchAirData();
    } catch (error) {
      showAirError(error);
    } finally {
      state.airLoading = false;
    }
  }

  function restoreAirLayer() {
    if (!state.air) return;
    addAirLayers();
    airTick().catch(error => {
      const chip = document.getElementById("air-chip");
      if (chip) chip.title = `Aircraft feed update failed: ${String(error && error.message || error)}`;
    });
  }

  function toggleAir() {
    state.air = !state.air;
    const chip = document.getElementById("air-chip");
    if (state.air) {
      addAirLayers();
      map.setLayoutProperty("air-dots", "visibility", "visible");
      map.setLayoutProperty("air-track-line", "visibility", "visible");
      map.setLayoutProperty("air-track-labels", "visibility", "visible");
      map.setLayoutProperty("air-track-waypoint-dots", "visibility", "visible");
      map.setLayoutProperty("air-tracked-pin", "visibility", "visible");
      if (chip) chip.classList.remove("hidden");
      airTick();
      state.airTimer = setInterval(airTick, 30000);
      state.airMoveTimer = null;
      if (!state.airMoveBound) {
        state.airMoveBound = true;
        map.on("moveend", () => {
          if (!state.air) return;
          clearTimeout(state.airMoveTimer);
          state.airMoveTimer = setTimeout(airTick, 800);
        });
      }
    } else {
      clearInterval(state.airTimer);
      clearTimeout(state.airMoveTimer);
      if (state.airCockpit) leaveAirCockpit();
      state.airFollow = false;
      if (chip) chip.classList.add("hidden");
      Contacts.close();
      if (map.getLayer("air-dots")) map.setLayoutProperty("air-dots", "visibility", "none");
      if (map.getLayer("air-track-line")) map.setLayoutProperty("air-track-line", "visibility", "none");
      if (map.getLayer("air-track-labels")) map.setLayoutProperty("air-track-labels", "visibility", "none");
      if (map.getLayer("air-track-waypoint-dots")) map.setLayoutProperty("air-track-waypoint-dots", "visibility", "none");
      if (map.getLayer("air-tracked-pin")) map.setLayoutProperty("air-tracked-pin", "visibility", "none");
    }
    return state.air;
  }

  // ============================================================ QUAKES ===
  const QUAKES_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson";

  async function quakeTick() {
    if (!state.quakes || state.quakesLoading) return;
    state.quakesLoading = true;
    const chip = document.getElementById("quake-chip");
    try {
      const response = await fetch(QUAKES_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`USGS feed returned HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.features)) throw new Error("USGS feed returned invalid GeoJSON");
      const source = map.getSource("quakes");
      if (!source) throw new Error("Earthquake map layer is unavailable");
      source.setData(data);
      if (chip) {
        chip.textContent = `◇ ${data.features.length} QUAKES · ${new Date().toISOString().slice(11, 16)}Z`;
        chip.title = "USGS earthquakes of magnitude 2.5 or greater in the past 24 hours; refreshes every 5 minutes.";
      }
    } finally {
      state.quakesLoading = false;
    }
  }

  function showQuakeStatusError(error) {
    const chip = document.getElementById("quake-chip");
    if (!chip) return;
    chip.textContent = "◇ QUAKES · UPDATE FAILED";
    chip.title = String(error && error.message || error);
  }

  function addQuakeLayers() {
    if (!map.getSource("quakes")) {
      map.addSource("quakes", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "quake-circles", type: "circle", source: "quakes",
        paint: {
          "circle-color": [
            "interpolate", ["linear"], ["coalesce", ["get", "mag"], 0],
            0, "#41efc2", 2, "#d9b56d", 4, "#ff994d", 6, "#ff667d",
          ],
          "circle-radius": [
            "interpolate", ["linear"], ["coalesce", ["get", "mag"], 0],
            0, 3, 2, 5, 4, 8, 6, 13, 8, 18,
          ],
          "circle-opacity": 0.82,
          "circle-stroke-color": "#f4fbff",
          "circle-stroke-width": 1,
          "circle-stroke-opacity": 0.75,
        },
      });
      map.on("click", "quake-circles", (event) => {
        const feature = event.features && event.features[0];
        if (!feature) return;
        const properties = feature.properties || {};
        const coordinates = feature.geometry.coordinates;
        const content = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = String(properties.place || "Earthquake");
        title.style.color = "#ff994d";
        content.appendChild(title);
        const detail = document.createElement("div");
        const magnitude = properties.mag == null ? "unknown" : Number(properties.mag).toFixed(1);
        const depth = coordinates[2] == null ? "unknown" : `${Number(coordinates[2]).toFixed(1)} km`;
        detail.textContent = `Magnitude ${magnitude} · depth ${depth}`;
        content.appendChild(detail);
        if (Number.isFinite(Number(properties.time))) {
          const time = document.createElement("div");
          time.textContent = new Date(Number(properties.time)).toISOString();
          content.appendChild(time);
        }
        if (typeof properties.url === "string" && properties.url.startsWith("https://earthquake.usgs.gov/")) {
          const link = document.createElement("a");
          link.href = properties.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "USGS event details ↗";
          content.appendChild(link);
        }
        new maplibregl.Popup({ closeButton: true, maxWidth: "300px" })
          .setLngLat(coordinates)
          .setDOMContent(content)
          .addTo(map);
      });
      map.on("mouseenter", "quake-circles", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "quake-circles", () => { map.getCanvas().style.cursor = "grab"; });
    } else {
      map.setLayoutProperty("quake-circles", "visibility", "visible");
    }
  }

  async function toggleQuakes() {
    state.quakes = !state.quakes;
    const chip = document.getElementById("quake-chip");
    if (!state.quakes) {
      clearInterval(state.quakesTimer);
      if (map.getLayer("quake-circles")) map.setLayoutProperty("quake-circles", "visibility", "none");
      if (chip) chip.classList.add("hidden");
      return false;
    }

    addQuakeLayers();
    if (chip) chip.classList.remove("hidden");
    try {
      await quakeTick();
      if (!state.quakes) return false;
      clearInterval(state.quakesTimer);
      state.quakesTimer = setInterval(() => {
        quakeTick().catch(showQuakeStatusError);
      }, 5 * 60 * 1000);
      return true;
    } catch (error) {
      state.quakes = false;
      if (map.getLayer("quake-circles")) map.setLayoutProperty("quake-circles", "visibility", "none");
      if (chip) chip.classList.add("hidden");
      throw error;
    }
  }

  function restoreQuakeLayer() {
    if (!state.quakes) return;
    addQuakeLayers();
    quakeTick().catch(showQuakeStatusError);
  }

  function init(m) {
    map = m;
    window.GE_CAMS = window.GE_CAMS || {};
  }

  return { init, toggleNight, toggleISS, toggleRadar, toggleAir, toggleAirFollow, toggleAirCockpit, selectAirTrack, openAirList, restoreAirLayer, toggleQuakes, restoreQuakeLayer, playRadar, pauseRadar, applyRadarFrame, sweepRoute, clearRoute,
    airTelemetrySeries, nearestAirport, paintAirTelemetry, fetchAirData, showAirError,
           get state() { return state; } };
})();
