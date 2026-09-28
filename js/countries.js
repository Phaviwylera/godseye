/* GOD'S EYE — COUNTRIES layer: clickable admin-0 boundaries + World Bank
 * country cards.
 *
 * data/countries.json is built by tools/build_countries.py from the small,
 * widely mirrored world.geo.json (OpenStreetMap-derived). Clicking a country
 * asks the relay (/api/worldbank, both runtimes) for ten keyless World Bank
 * indicators — latest year each — and the card states the year of every
 * figure. Values are World Bank's, not godseye's; no interpolation, no
 * estimates, missing figures just say "no data".
 */
const Countries = (() => {
  let map = null;
  const state = { on: false, loaded: false, pending: false, modalOpen: false };

  /* ------------------------------------------------------------------ pure -- */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function fmtValue(v) {
    if (!Number.isFinite(v)) return "no data";
    const abs = Math.abs(v);
    if (abs >= 1e12) return (v / 1e12).toFixed(2) + " T";
    if (abs >= 1e9) return (v / 1e9).toFixed(1) + " B";
    if (abs >= 1e6) return (v / 1e6).toFixed(1) + " M";
    if (abs >= 1000) return (v / 1000).toFixed(1) + " k";
    return String(Math.round(v * 100) / 100);
  }

  function indicatorRows(doc) {
    return (doc.indicators || []).map(ind => ({
      name: ind.name || ind.id,
      value: ind.value,
      date: ind.date,
    }));
  }

  function featureCollection(doc) {
    return { type: "FeatureCollection", features: (doc.countries || []).map(c => ({
      type: "Feature",
      properties: { name: c.name, iso2: c.iso2 || "" },
      geometry: c.geometry,
    })) };
  }

  /* ------------------------------------------------------------------- DOM -- */

  function addLayers() {
    if (map.getSource("countries-boundaries")) return;
    const src = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
    map.addSource("countries-boundaries", src);
    map.addLayer({
      id: "countries-fill", type: "fill", source: "countries-boundaries",
      paint: { "fill-color": "#82d9e7", "fill-opacity": 0 },
    });
    map.addLayer({
      id: "countries-lines", type: "line", source: "countries-boundaries",
      paint: { "line-color": "#82d9e7", "line-width": 0.7, "line-opacity": 0.28 },
    });
    map.on("click", "countries-lines", (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      openCard(f.properties.name, f.properties.iso2);
    });
    map.on("mouseenter", "countries-lines", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "countries-lines", () => { map.getCanvas().style.cursor = ""; });
  }

  const $ = (s) => document.querySelector(s);

  function openCard(name, iso2) {
    state.modalOpen = true;
    const m = $("#countries-modal");
    const body = $("#countries-body");
    const meta = $("#countries-meta");
    if (!m || !body) return;
    m.classList.remove("hidden");
    meta.textContent = iso2 ? `${name} · ${iso2} — loading…` : `${name} — no ISO code in the boundary file`;
    body.replaceChildren();
    if (!iso2) {
      const d = document.createElement("div");
      d.className = "iss-row";
      d.textContent = "Indicators need the ISO-2 code, and this boundary file carries none for that territory.";
      body.replaceChildren(d);
      return;
    }
    fetch(`/api/worldbank?cc=${encodeURIComponent(iso2)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(doc => {
        if (!doc) throw new Error("relay unavailable");
        if (meta.textContent.startsWith(name)) meta.textContent = `${doc.country || name} · ${doc.iso2}`;
        const rows = indicatorRows(doc).map(ind => {
          const d = document.createElement("div");
          d.className = "iss-row";
          d.textContent = `${ind.name}: ${fmtValue(ind.value)} · ${ind.date}`;
          return d;
        });
        const src = document.createElement("div");
        src.className = "iss-row";
        src.style.color = "#5f8894";
        src.textContent = "World Bank open data API (keyless relay, 1 h cache) — figures are the publisher's, latest year reported per indicator.";
        body.replaceChildren(...rows, src);
      })
      .catch((error) => {
        meta.textContent = `${name} · ${iso2} — unavailable`;
        const d = document.createElement("div");
        d.className = "iss-row";
        d.textContent = `Could not fetch indicators (${String(error.message || error)}). Try again — no invented figures.`;
        body.replaceChildren(d);
      });
  }

  function closeCard() {
    state.modalOpen = false;
    const m = $("#countries-modal");
    if (m) m.classList.add("hidden");
  }

  async function load() {
    if (state.loaded || state.pending) return;
    state.pending = true;
    try {
      const r = await fetch("data/countries.json");
      if (r.ok) {
        const doc = await r.json();
        const src = map.getSource("countries-boundaries");
        if (src) src.setData(featureCollection(doc));
        state.loaded = true;
      }
    } catch { /* boundaries are optional polish; the basemap still works */ }
    state.pending = false;
  }

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      for (const id of ["countries-lines", "countries-fill"]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource("countries-boundaries")) map.removeSource("countries-boundaries");
      return false;
    }
    state.on = true;
    addLayers();
    await load();
    return true;
  }

  function restore() {
    if (state.on && map && !map.getSource("countries-boundaries")) {
      addLayers();
      load();
    }
  }

  function init(instance) {
    map = instance;
    const btn = document.getElementById("btn-countries");
    if (btn) btn.onclick = async (e) => {
      try {
        e.target.classList.toggle("active", await toggle());
      } catch (error) {
        e.target.classList.remove("active");
        console.warn("countries layer unavailable", error);
      }
    };
    const close = $("#countries-close");
    if (close) close.onclick = closeCard;
    const m = $("#countries-modal");
    if (m) m.addEventListener("click", (e) => { if (e.target.id === "countries-modal") closeCard(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.modalOpen) closeCard(); });
  }

  return { init, toggle, restore, openCard, closeCard, featureCollection, indicatorRows, fmtValue, _state: state };
})();
