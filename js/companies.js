/* GOD'S EYE — COMPANIES layer: headquarters of a curated large-cap sample.
 *
 * data/companies.json is built by tools/build_companies.py from
 * data/companies-seed.json (curated names + tickers) with Nominatim HQ
 * geocoding. No coordinates are invented by this layer; a missing snapshot
 * shows a labelled "PENDING BUILD" state. Quotes are a link out to a price
 * search — v1 fetches no prices itself, and a guessed quote deep-link would
 * be fabrication.
 */
const Companies = (() => {
  let map = null;
  const state = { on: false, companies: [], pending: false, dropped: 0 };

  /* ------------------------------------------------------------------ pure -- */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  const quoteUrl = (ticker) =>
    "https://www.google.com/search?q=" + encodeURIComponent(ticker + " stock price");

  function card(c) {
    return `<div class="ev-card"><div class="ev-q">${esc(c.name)}</div>
      <div class="ev-row">${esc(c.ticker)} · HQ ${esc(c.city)}</div>
      <div class="ev-row"><a href="${esc(quoteUrl(c.ticker))}" target="_blank" rel="noopener noreferrer">live quote search ↗</a></div>
      <div class="ev-row dim">Curated large-cap sample + OSM Nominatim HQ geocoding. Not exhaustive; no live prices fetched by godseye.</div></div>`;
  }

  function features() {
    return state.companies.map(c => ({
      type: "Feature",
      properties: { c },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    }));
  }

  /* ------------------------------------------------------------------- DOM -- */

  function chip() { return document.getElementById("companies-chip"); }
  function setChip(text, title) {
    const c = chip();
    if (!c) return;
    c.classList.remove("hidden");
    c.textContent = text;
    if (title) c.title = title;
  }

  function addLayers() {
    if (map.getSource("companies-dots-src")) return;
    map.addSource("companies-dots-src", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "companies-dots", type: "circle", source: "companies-dots-src", minzoom: 2,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 1.4, 6, 2.2, 10, 3.6],
        "circle-color": "#7fd1e8",
        "circle-opacity": 0.9,
        "circle-stroke-color": "rgba(4,20,26,.8)", "circle-stroke-width": 1,
      },
    });
    map.addLayer({
      id: "companies-labels", type: "symbol", source: "companies-dots-src", minzoom: 6,
      layout: { "text-field": ["get", "name"], "text-size": 9, "text-offset": [0, 1.7],
        "text-allow-overlap": true },
      paint: { "text-color": "#7fd1e8", "text-halo-color": "#04141a", "text-halo-width": 2, "text-opacity": 0.85 },
    });
    map.on("click", "companies-dots", (e) => {
      const f = e.features && e.features[0];
      if (!f || !f.properties.c) return;
      new maplibregl.Popup({ maxWidth: "320px" })
        .setLngLat(f.geometry.coordinates).setHTML(card(f.properties.c)).addTo(map);
    });
    map.on("mouseenter", "companies-dots", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "companies-dots", () => { map.getCanvas().style.cursor = ""; });
  }

  function render() {
    const src = map && map.getSource("companies-dots-src");
    if (src) src.setData({ type: "FeatureCollection", features: features() });
    if (state.pending) {
      setChip("▣ COMPANIES · PENDING BUILD",
        "data/companies.json has not been built yet — run `python3 tools/build_companies.py` (the refresh-companies action does this monthly).");
    } else {
      setChip(`▣ ${state.companies.length} HQs`,
        "Headquarters of a curated large-cap sample (see data/companies-seed.json), geocoded via OSM Nominatim. Quotes are a link out — no prices fetched here.");
    }
  }

  async function load() {
    try {
      const r = await fetch("data/companies.json");
      if (!r.ok) { state.pending = true; return; }
      const doc = await r.json();
      state.companies = Array.isArray(doc.companies) ? doc.companies : [];
      state.dropped = Number(doc.dropped) || 0;
      state.pending = state.companies.length === 0;
    } catch { state.pending = true; }
  }

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      chip().classList.add("hidden");
      for (const id of ["companies-labels", "companies-dots"]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource("companies-dots-src")) map.removeSource("companies-dots-src");
      return false;
    }
    state.on = true;
    await load();
    addLayers();
    render();
    return true;
  }

  function restore() {
    if (state.on && map && !map.getSource("companies-dots-src")) {
      addLayers();
      render();
    }
  }

  function openList() {
    if (typeof Contacts === "undefined") return;
    if (!state.companies.length) return;
    Contacts.open(`${state.companies.length} HQs · CURATED SAMPLE`,
      state.companies.slice(0, 60).map(c => ({
        label: c.name,
        detail: `${c.ticker} · ${c.city}`,
        c,
      })), ({ c }) => {
        map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 8), speed: 1.6 });
        window.open(quoteUrl(c.ticker), "_blank", "noopener,noreferrer");
      });
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, openList, card, quoteUrl, features, _state: state };
})();
