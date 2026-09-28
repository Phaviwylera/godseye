/* GOD'S EYE — CONFLICT layer: recent UCDP/PRIO GED conflict events.
 *
 * data/conflict.json is built by tools/build_conflict.py from UCDP's public
 * Government-Endowed dataset (last 180 days, geolocated events only). UCDP
 * classifies and geocodes the events; godseye adds nothing editorial. No
 * frontlines are drawn — none exist in an open, verifiable source, and a
 * hand-drawn contact line would be fabrication.
 */
const Conflict = (() => {
  let map = null;
  const state = { on: false, events: [], windowDays: 0, pending: false };

  /* ------------------------------------------------------------------ pure -- */

  function kindOf(ev) {
    const [, , , , , type, kills] = ev;
    const t = String(type);
    return t === "3" ? "war" : t === "2" ? "terrorism" : "political violence";
  }

  function colorFor(ev) {
    const kills = ev[6] || 0;
    if (kills >= 25) return "#ff667d";
    if (kills >= 5) return "#ff9dab";
    if (kills >= 1) return "#ffb454";
    return "#e07a5f";
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function card(ev) {
    const [d, , , country, region, , kills, place] = ev;
    return `<div class="ev-card"><div class="ev-q">${esc(country || "Unknown country")}${region ? " · " + esc(region) : ""}</div>
      <div class="ev-row">${esc(d)} · ${esc(kindOf(ev))}${kills ? " · " + kills + " reported killed" : " · no reported deaths"}</div>
      ${place ? `<div class="ev-row">${esc(place)}</div>` : ""}
      <div class="ev-row dim">UCDP/PRIO GED · classification by the dataset, not by godseye</div></div>`;
  }

  /* ------------------------------------------------------------------- DOM -- */

  function chip() { return document.getElementById("conflict-chip"); }
  function setChip(text, title) {
    const c = chip();
    if (!c) return;
    c.classList.remove("hidden");
    c.textContent = text;
    if (title) c.title = title;
  }

  function features() {
    return state.events.map(ev => ({
      type: "Feature",
      properties: { ev, kind: kindOf(ev), color: colorFor(ev) },
      geometry: { type: "Point", coordinates: [ev[1], ev[2]] },
    }));
  }

  function addLayers() {
    if (map.getSource("conflict-dots-src")) return;
    map.addSource("conflict-dots-src", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "conflict-dots", type: "circle", source: "conflict-dots-src", minzoom: 1,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.5, 5, 2.4, 9, 3.8],
        "circle-color": ["get", "color"],
        "circle-opacity": 0.8,
        "circle-stroke-color": "rgba(4,20,26,.7)", "circle-stroke-width": 1,
      },
    });
    map.on("click", "conflict-dots", (e) => {
      const f = e.features && e.features[0];
      if (!f || !f.properties.ev) return;
      new maplibregl.Popup({ maxWidth: "340px" })
        .setLngLat(f.geometry.coordinates).setHTML(card(f.properties.ev)).addTo(map);
    });
    map.on("mouseenter", "conflict-dots", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "conflict-dots", () => { map.getCanvas().style.cursor = ""; });
  }

  function render() {
    const src = map && map.getSource("conflict-dots-src");
    if (src) src.setData({ type: "FeatureCollection", features: features() });
    if (state.pending) {
      setChip("☒ CONFLICT · PENDING BUILD",
        "data/conflict.json has not been built yet — run `python3 tools/build_conflict.py` (the refresh-conflict action does this weekly).");
    } else {
      setChip(`☒ ${state.events.length} EVENTS · ${state.windowDays}D`,
        "UCDP/PRIO GED conflict events, last " + state.windowDays + " days. Colour is reported deaths: red ≥25, rose ≥5, orange ≥1, salmon none reported. No frontlines: none exist in an open verifiable source.");
    }
  }

  async function load() {
    try {
      const r = await fetch("data/conflict.json");
      if (!r.ok) { state.pending = true; return; }
      const doc = await r.json();
      state.events = Array.isArray(doc.events) ? doc.events : [];
      state.windowDays = Number(doc.window_days) || 0;
      state.pending = state.events.length === 0;
    } catch { state.pending = true; }
  }

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      chip().classList.add("hidden");
      if (map.getLayer("conflict-dots")) map.removeLayer("conflict-dots");
      if (map.getSource("conflict-dots-src")) map.removeSource("conflict-dots-src");
      return false;
    }
    state.on = true;
    await load();
    addLayers();
    render();
    return true;
  }

  function restore() {
    if (state.on && map && !map.getSource("conflict-dots-src")) {
      addLayers();
      render();
    }
  }

  function openList() {
    if (typeof Contacts === "undefined") return;
    if (!state.events.length) return;
    const sorted = [...state.events].sort((a, b) => (b[6] || 0) - (a[6] || 0));
    Contacts.open(`${state.events.length} EVENTS · LAST ${state.windowDays} DAYS`,
      sorted.slice(0, 40).map(ev => ({
        label: `${ev[3]}${ev[4] ? " · " + ev[4] : ""}`,
        detail: `${ev[0]} · ${kindOf(ev)}${ev[6] ? " · " + ev[6] + " reported killed" : ""}`,
        ev,
      })), ({ ev }) => map.flyTo({ center: [ev[1], ev[2]], zoom: 6, speed: 1.6 }));
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, openList, kindOf, colorFor, card, features, _state: state };
})();
