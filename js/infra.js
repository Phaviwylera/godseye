/* GOD'S EYE — INFRA layer: the critical infrastructure that moves the world.
 *
 * Three static snapshots built by tools/build_infra.py (refresh-infra, weekly):
 *   power  — named power=plant features in OpenStreetMap (kind from generator tags)
 *   ports  — named harbour places in OpenStreetMap
 *   cables — the open "CABLE" submarine-cable dataset (2019 vintage; the file
 *            says so and so does every popup — routes are historical, not live)
 *
 * Until the first snapshot has run, each dataset degrades to a labelled
 * "PENDING BUILD" state in the chip — never a fabricated count.
 */
const Infra = (() => {
  let map = null;
  let handlersBound = false;
  const state = { on: false, power: null, ports: null, cables: null, pending: { power: false, ports: false, cables: false } };

  /* ------------------------------------------------------------------ pure -- */

  function fmtCount(n) {
    return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
  }

  /** [lon, lat, name, kind] records -> features. Malformed rows are dropped. */
  function powerFeatures(records) {
    const out = [];
    for (const r of records || []) {
      if (!Array.isArray(r) || r.length < 4) continue;
      const [lon, lat, name, kind] = r;
      if (!Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      out.push({ type: "Feature", properties: { name: String(name), kind: String(kind || "other") },
        geometry: { type: "Point", coordinates: [Number(lon), Number(lat)] } });
    }
    return out;
  }

  function portFeatures(records) {
    const out = [];
    for (const r of records || []) {
      if (!Array.isArray(r) || r.length < 3) continue;
      const [lon, lat, name] = r;
      if (!Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      out.push({ type: "Feature", properties: { name: String(name) },
        geometry: { type: "Point", coordinates: [Number(lon), Number(lat)] } });
    }
    return out;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  /** A card may be handed a feature's properties (what the map click passes)
   *  or the whole feature (callers that keep the geometry). Both must render
   *  the same card: the cable card used to read `.properties` off an
   *  already-unwrapped properties object, so every submarine-cable popup came
   *  up nameless and empty. */
  function propsOf(feature) {
    if (!feature || typeof feature !== "object") return {};
    const p = feature.properties;
    return p && typeof p === "object" ? p : feature;
  }

  function powerCard(feature) {
    const f = propsOf(feature);
    return `<div class="ev-card"><div class="ev-q">${esc(f.name || "Power plant")}</div>
      <div class="ev-row">${esc(f.kind || "other")} plant</div>
      <div class="ev-row dim">OpenStreetMap (power=plant), CC-BY-SA</div></div>`;
  }

  function portCard(feature) {
    const f = propsOf(feature);
    return `<div class="ev-card"><div class="ev-q">${esc(f.name || "Harbour")}</div>
      <div class="ev-row dim">Named harbour, OpenStreetMap, CC-BY-SA</div></div>`;
  }

  function cableCard(feature) {
    const p = propsOf(feature);
    const bits = [];
    if (p.length) bits.push(esc(p.length));
    if (p.rfs) bits.push("in service " + esc(p.rfs));
    if (p.owners) bits.push(esc(p.owners));
    return `<div class="ev-card"><div class="ev-q">${esc(p.name || "Submarine cable")}</div>
      ${bits.length ? `<div class="ev-row">${bits.join(" · ")}</div>` : ""}
      <div class="ev-row dim">Open CABLE dataset, 2019 vintage — historical route, not live status</div></div>`;
  }

  const CARDS = { "infra-power": powerCard, "infra-ports": portCard, "infra-cables": cableCard };

  /** The popup HTML for one clicked feature — the single contract the map
   *  click handler and the tests share. */
  function cardFor(layerId, feature) {
    const card = CARDS[layerId];
    return card ? card(feature) : "";
  }

  /* ------------------------------------------------------------------- DOM -- */

  function chip() { return document.getElementById("infra-chip"); }
  function setChip(text, title) {
    const c = chip();
    if (!c) return;
    c.classList.remove("hidden");
    c.textContent = text;
    if (title) c.title = title;
  }

  function chipText() {
    const p = state.pending.power ? "PWR · PENDING" : `${fmtCount((state.power || []).length)} PWR`;
    const po = state.pending.ports ? "PORTS · PENDING" : `${fmtCount((state.ports || []).length)} PORTS`;
    const cb = state.pending.cables ? "CABLES · PENDING" : `${fmtCount((state.cables || []).length)} CABLES`;
    return `⬡ ${p} · ${po} · ${cb}`;
  }

  const KIND_COLOR = {
    solar: "#ffd28a", wind: "#9afbe9", hydro: "#82d9e7", nuclear: "#d8b772",
    coal: "#c98a5e", gas: "#e0a458", oil: "#b08968", other: "#9db4bd",
  };

  function addLayers() {
    if (map.getSource("infra-power")) return;
    map.addSource("infra-power", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addSource("infra-ports", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addSource("infra-cables", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "infra-cables", type: "line", source: "infra-cables", minzoom: 1,
      paint: { "line-color": "#4f7f9d", "line-width": 1.1, "line-opacity": 0.55,
        "line-dasharray": [1.5, 1.2] },
    });
    map.addLayer({
      id: "infra-power", type: "circle", source: "infra-power", minzoom: 3.5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3.5, 1.5, 7, 2.6, 10, 4],
        "circle-color": ["match", ["get", "kind"], "solar", KIND_COLOR.solar, "wind", KIND_COLOR.wind,
          "hydro", KIND_COLOR.hydro, "nuclear", KIND_COLOR.nuclear, "coal", KIND_COLOR.coal,
          "gas", KIND_COLOR.gas, "oil", KIND_COLOR.oil, KIND_COLOR.other],
        "circle-opacity": 0.9,
      },
    });
    map.addLayer({
      id: "infra-ports", type: "circle", source: "infra-ports", minzoom: 4,
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 1.8, 7, 2.8, 10, 4.4],
        "circle-color": "#65e4d2", "circle-stroke-color": "rgba(4,28,34,.9)",
        "circle-stroke-width": 1, "circle-opacity": 0.95 },
    });
    if (handlersBound) return;
    handlersBound = true;
    for (const id of Object.keys(CARDS)) {
      map.on("click", id, (e) => {
        const f = e.features && e.features[0];
        if (!f) return;
        // Geometry anchor for a line layer: use the click point, not the first
        // vertex (which can be an ocean away from what was clicked).
        const at = id === "infra-cables" ? e.lngLat : f.geometry.coordinates;
        new maplibregl.Popup({ closeButton: true, closeOnClick: true })
          .setLngLat(at).setHTML(cardFor(id, f)).addTo(map);
      });
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }
  }

  async function loadDataset(key, url, parse) {
    try {
      const r = await fetch(url);
      if (!r.ok) { state.pending[key] = true; return; }
      const doc = await r.json();
      state[key] = parse(doc);
      state.pending[key] = false;
    } catch { state.pending[key] = true; }
  }

  function refresh() {
    return Promise.all([
      loadDataset("power", "data/power.json", (d) => powerFeatures(d.records)),
      loadDataset("ports", "data/ports.json", (d) => portFeatures(d.records)),
      loadDataset("cables", "data/cables.geojson", (d) => (d.features || [])),
    ]).then(() => {
      if (!map) return;
      const src = (name) => map.getSource(name);
      if (src("infra-power")) src("infra-power").setData({ type: "FeatureCollection", features: state.power || [] });
      if (src("infra-ports")) src("infra-ports").setData({ type: "FeatureCollection", features: state.ports || [] });
      if (src("infra-cables")) src("infra-cables").setData({ type: "FeatureCollection", features: state.cables || [] });
      setChip(chipText(),
        "Named power plants and harbours from OpenStreetMap (CC-BY-SA) and the open CABLE submarine-cable dataset (2019 vintage, historical). Built weekly by the refresh-infra action.");
    });
  }

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      chip().classList.add("hidden");
      for (const id of ["infra-power", "infra-ports", "infra-cables"]) if (map.getLayer(id)) map.removeLayer(id);
      for (const name of ["infra-power", "infra-ports", "infra-cables"]) if (map.getSource(name)) map.removeSource(name);
      return false;
    }
    state.on = true;
    await refresh();
    if (!state.on) return false;
    addLayers();
    if (map.getSource("infra-power")) map.getSource("infra-power").setData({ type: "FeatureCollection", features: state.power || [] });
    if (map.getSource("infra-ports")) map.getSource("infra-ports").setData({ type: "FeatureCollection", features: state.ports || [] });
    if (map.getSource("infra-cables")) map.getSource("infra-cables").setData({ type: "FeatureCollection", features: state.cables || [] });
    setChip(chipText());
    return true;
  }

  function restore() {
    if (state.on && map && !map.getSource("infra-power")) {
      addLayers();
      if (map.getSource("infra-power")) map.getSource("infra-power").setData({ type: "FeatureCollection", features: state.power || [] });
      if (map.getSource("infra-ports")) map.getSource("infra-ports").setData({ type: "FeatureCollection", features: state.ports || [] });
      if (map.getSource("infra-cables")) map.getSource("infra-cables").setData({ type: "FeatureCollection", features: state.cables || [] });
    }
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, powerFeatures, portFeatures, powerCard, portCard, cableCard,
    cardFor, propsOf, fmtCount, chipText, _state: state };
})();
