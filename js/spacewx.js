/* GOD'S EYE — SPACE WEATHER layer: the aurora oval and planetary K index.
 *
 * NOAA's Space Weather Prediction Center publishes the OVATION aurora model as
 * a keyless JSON grid (1° longitude/latitude, probability 0–100) and the
 * planetary K index as a rolling three-hour series. Both are public, CORS-open
 * and updated continuously. This layer plots the forecast probability where
 * the model reports it and states the Kp value in the chip; it never invents an
 * oval, a storm level or a position between grid cells.
 *
 * The raw grid is ~65k points. We sample every 2° (about 10k cells) and keep the
 * publisher's value untouched — no interpolation, no smoothing into new places.
 *
 * Same standing rules as every layer: real publisher data only, source cited,
 * no invented positions, degraded state labelled.
 */
const SpaceWx = (() => {
  let map = null;
  const state = {
    on: false, points: [], kp: null, observed: "", forecast: "",
    at: 0, error: "", timer: null,
  };

  const AURORA_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
  const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
  const REFRESH_MS = 15 * 60 * 1000;
  const STEP = 2;

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

  const finite = (value) => {
    if (value == null || value === "") return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  };

  /* OVATION longitude runs 0…359. Map wants -180…180, so shift values above
   * 180 west. Only exact STEP-degree grid nodes are kept. */
  function sampleOvation(doc, step = STEP) {
    const rows = doc && Array.isArray(doc.coordinates) ? doc.coordinates : [];
    const size = Math.max(1, Math.round(step));
    const out = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const lon = finite(row[0]);
      const lat = finite(row[1]);
      const value = finite(row[2]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(value)) continue;
      if (lon < 0 || lon > 359 || lat < -90 || lat > 90) continue;
      if (value <= 0 || value > 100) continue;
      if (Math.round(lon) % size !== 0 || Math.round(lat) % size !== 0) continue;
      out.push({ lon: lon > 180 ? lon - 360 : lon, lat, value });
    }
    return out;
  }

  /** Latest planetary Kp row, in publication order, with its own timestamp. */
  function normalizeKp(doc) {
    const rows = Array.isArray(doc) ? doc : [];
    let latest = null;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const kp = finite(row.Kp);
      if (!Number.isFinite(kp) || kp < 0 || kp > 9) continue;
      const time = String(row.time_tag || "").trim();
      if (!time) continue;
      if (!latest || time > latest.time) {
        latest = {
          kp: kp,
          time: time,
          aRunning: finite(row.a_running),
          stations: finite(row.station_count),
        };
      }
    }
    return latest;
  }

  /* NOAA G-scale is defined from Kp 5 upward; below that the storm scale does
   * not apply and the honest label is the geomagnetic activity band. */
  function geomagneticLevel(kp) {
    const n = finite(kp);
    if (!Number.isFinite(n)) return { code: "—", label: "unknown", color: "#55717c" };
    if (n >= 9) return { code: "G5", label: "extreme storm", color: "#ff4d5e" };
    if (n >= 8) return { code: "G4", label: "severe storm", color: "#ff6b4d" };
    if (n >= 7) return { code: "G3", label: "strong storm", color: "#ff9f45" };
    if (n >= 6) return { code: "G2", label: "moderate storm", color: "#ffd166" };
    if (n >= 5) return { code: "G1", label: "minor storm", color: "#f6e58d" };
    if (n >= 4) return { code: "ACTIVE", label: "active field", color: "#8fdce9" };
    return { code: "QUIET", label: "quiet field", color: "#8fe3a8" };
  }

  function peak(points) {
    let best = null;
    for (const point of points || []) {
      if (!best || point.value > best.value) best = point;
    }
    return best;
  }

  function features(points) {
    return (points || []).map((point) => ({
      type: "Feature",
      properties: { value: point.value, label: point.value + "%" },
      geometry: { type: "Point", coordinates: [point.lon, point.lat] },
    }));
  }

  function chip() { return document.getElementById("aurora-chip"); }
  function setChip(text, title) {
    const node = chip();
    if (!node) return;
    node.classList.remove("hidden");
    node.textContent = text;
    if (title) node.title = title;
  }

  function sourceNote() {
    const observed = state.observed ? ` Observation ${state.observed}.` : "";
    const forecast = state.forecast ? ` Forecast ${state.forecast}.` : "";
    return "Aurora probability from NOAA SWPC OVATION (2° grid sample) and the " +
      "planetary K index from NOAA SWPC." + observed + forecast;
  }

  function chipText() {
    if (state.error && !state.points.length) return "✦ AURORA — UNAVAILABLE";
    if (!state.points.length) return "✦ AURORA — NO FORECAST";
    const level = geomagneticLevel(state.kp && state.kp.kp);
    const top = peak(state.points);
    const kp = state.kp ? `Kp ${state.kp.kp.toFixed(2)} · ${level.code}` : "Kp unavailable";
    return `✦ AURORA — ${kp} · PEAK ${Math.round(top.value)}%`;
  }

  function refreshChip() {
    setChip(chipText(), sourceNote());
  }

  function pushData() {
    const src = map && map.getSource("aurora-geo");
    if (src) src.setData({ type: "FeatureCollection", features: features(state.points) });
  }

  function addLayers() {
    if (!map || map.getSource("aurora-geo")) return;
    map.addSource("aurora-geo", {
      type: "geojson",
      data: { type: "FeatureCollection", features: features(state.points) },
    });
    /* Heatmap density is a rendering aid, not a second measurement: the weight
     * comes from the publisher's probability and no extra cells are drawn. */
    map.addLayer({
      id: "aurora-heat", type: "heatmap", source: "aurora-geo",
      paint: {
        "heatmap-weight": ["interpolate", ["linear"], ["get", "value"],
          0, 0, 10, 0.18, 25, 0.42, 50, 0.72, 75, 0.9, 100, 1],
        "heatmap-intensity": 0.7,
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"],
          0, 5, 2, 12, 4, 24, 6, 40],
        "heatmap-opacity": 0.72,
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(0,0,0,0)",
          0.15, "rgba(105,235,190,0.20)",
          0.35, "rgba(104,240,150,0.55)",
          0.55, "rgba(255,214,102,0.68)",
          0.75, "rgba(255,123,102,0.80)",
          1, "rgba(214,120,255,0.90)"],
      },
    });
  }

  function removeLayers() {
    if (!map) return;
    if (map.getLayer("aurora-heat")) map.removeLayer("aurora-heat");
    if (map.getSource("aurora-geo")) map.removeSource("aurora-geo");
  }

  async function loadKp() {
    try {
      const response = await fetch(KP_URL, { cache: "no-cache" });
      if (!response.ok) return null;
      return normalizeKp(await response.json());
    } catch {
      return null;
    }
  }

  async function load() {
    const response = await fetch(AURORA_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error("aurora forecast HTTP " + response.status);
    const doc = await response.json();
    const points = sampleOvation(doc);
    if (!points.length) throw new Error("aurora forecast had no usable grid values");
    state.points = points;
    state.observed = String(doc["Observation Time"] || "").trim();
    state.forecast = String(doc["Forecast Time"] || "").trim();
    state.kp = await loadKp();
    state.at = Date.now();
    state.error = "";
  }

  async function refreshAll() {
    try {
      await load();
    } catch (error) {
      state.error = String((error && error.message) || error || "unavailable");
      console.warn("space weather: NOAA SWPC", error);
    }
    pushData();
    refreshChip();
  }

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      removeLayers();
      if (chip()) chip().classList.add("hidden");
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      return false;
    }
    state.on = true;
    await refreshAll();
    addLayers();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => { if (state.on) refreshAll(); }, REFRESH_MS);
    return true;
  }

  function restore() {
    if (state.on && map && !map.getSource("aurora-geo")) {
      addLayers();
      pushData();
      refreshChip();
    }
  }

  function openList() {
    if (typeof Contacts === "undefined" || !state.points.length) return;
    const top = state.points.slice().sort((a, b) => b.value - a.value).slice(0, 60);
    const level = geomagneticLevel(state.kp && state.kp.kp);
    const summary = [
      {
        label: `Kp ${state.kp ? state.kp.kp.toFixed(2) : "unavailable"} — ${level.code}`,
        detail: state.kp
          ? `${level.label} · ${state.kp.time.replace("T", " ")}Z · NOAA SWPC planetary K index`
          : "Planetary K index unavailable on this sweep",
      },
      {
        label: `Forecast window ${state.forecast || "unknown"}`,
        detail: `Observation ${state.observed || "unknown"} · ${state.points.length} grid cells sampled at ${STEP}°`,
      },
    ];
    Contacts.open(`✦ AURORA FORECAST — ${state.points.length} SWPC GRID CELLS`,
      summary.concat(top.map((point) => ({
        point,
        label: `${Math.round(point.value)}% aurora probability`,
        detail: `${point.lat.toFixed(0)}° ${point.lat >= 0 ? "N" : "S"} · ` +
          `${Math.abs(point.lon).toFixed(0)}° ${point.lon >= 0 ? "E" : "W"} · publisher grid value`,
      }))),
      ({ point }) => {
        if (point) map.flyTo({ center: [point.lon, point.lat], zoom: 3, speed: 1.2 });
      });
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, openList, sampleOvation, normalizeKp,
    geomagneticLevel, peak, features, chipText, sourceNote, _state: state, STEP };
})();
