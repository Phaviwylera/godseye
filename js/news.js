/* GOD'S EYE — NEWS layer: geolocated world headlines from GDELT DOC 2.0.
 *
 * The relay (/api/gdelt, server.py locally + netlify/functions/api.mjs in the
 * cloud) runs one fixed PointData sweep per 15 minutes — an OR of
 * conflict/disaster headline terms, geocoded articles, 250-record cap.
 *
 * Severity is a TRANSPARENT HEADLINE KEYWORD SCORE, never an editorial
 * judgement: the popup says which bucket matched, and "general" is the honest
 * default. Articles are links out — godseye never re-hosts the article text.
 */
const News = (() => {
  let map = null;
  const state = { on: false, items: [], last: 0, busy: false };

  const NEW_URL = "/api/gdelt?window=900";

  /* ------------------------------------------------------------------ pure -- */

  // Bordered buckets: first match wins. Words are deliberately blunt —
  // a headline that says "killed" is treated as severe, full stop.
  const SEVERITY = [
    { level: 9, label: "CASUALTIES", re: /kill(ed|ing|s)?\b|dead\b|death|died|fatal|massacre|drown(ed|ing)?\b/i },
    { level: 7, label: "USE OF FORCE", re: /attack|airstrike|air strike|bomb(ed|ing|s)?|explosi|detonat|missile|shelling|gunfire|shoot(ing|s|er)?|invasion|raid/i },
    { level: 5, label: "CONFRONTATION", re: /arrest|detain|imprison|jail|riot|clash|protest|demonstrat|strike\b|coup|seiz/i },
    { level: 4, label: "DISASTER", re: /earthquake|quake|tsunami|flood|wildfire|cyclone|hurricane|typhoon|landslide|eruption|disaster|rescue|evacuat/i },
  ];
  const SEVERITY_DEFAULT = { level: 2, label: "GENERAL" };

  function severity(title) {
    const t = String(title || "");
    for (const b of SEVERITY) if (b.re.test(t)) return b;
    return SEVERITY_DEFAULT;
  }

  const LEVEL_COLOR = { 9: "#ff667d", 7: "#ff9dab", 5: "#ffb454", 4: "#ffd28a", 2: "#9db4bd" };

  /** GDELT PointData FeatureCollection -> tidy items (defensive on property names). */
  function normalize(doc, now) {
    if (!doc || !Array.isArray(doc.features)) return [];
    const out = [];
    for (const f of doc.features) {
      const g = f && f.geometry;
      if (!g || !Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
      const [lon, lat] = g.coordinates;
      if (!Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) continue;
      if (Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) continue;
      const p = f.properties || {};
      const title = String(p.title || p.name || "headless report").trim();
      out.push({
        lon: Number(lon), lat: Number(lat),
        title,
        url: String(p.url || ""),
        date: String(p.date || ""),
        severity: severity(title),
      });
    }
    out.sort((a, b) => (b.severity.level - a.severity.level) || (b.date > a.date ? 1 : -1));
    return out;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function ageLabel(iso, now) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const m = Math.max(0, Math.round((now - t) / 60000));
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.floor(h / 24)} d ago`;
  }

  /* ------------------------------------------------------------------- DOM -- */

  function chip() { return document.getElementById("news-chip"); }
  function setChip(text, title) {
    const c = chip();
    if (!c) return;
    c.classList.remove("hidden");
    c.textContent = text;
    if (title) c.title = title;
  }

  function addLayers() {
    if (map.getSource("news-dots-src")) return;
    map.addSource("news-dots-src", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "news-dots", type: "circle", source: "news-dots-src", minzoom: 1,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.6, 6, 2.6, 10, 4.2],
        "circle-color": ["step", ["get", "sev"], "#9db4bd", 4, LEVEL_COLOR[4], 5, LEVEL_COLOR[5], 7, LEVEL_COLOR[7], 9, LEVEL_COLOR[9]],
        "circle-opacity": 0.85,
        "circle-stroke-color": "rgba(4,20,26,.8)", "circle-stroke-width": 1,
      },
    });
    map.on("click", "news-dots", (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      const p = f.properties || {};
      const age = ageLabel(p.date, Date.now());
      const html = `<div class="ev-card"><div class="ev-q">${esc(p.title)}</div>
        <div class="ev-row">severity ${p.sev}/10 · ${esc(p.sevlabel)}${age ? " · " + esc(age) : ""}</div>
        ${p.url ? `<div class="ev-row"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">source article ↗</a></div>` : ""}
        <div class="ev-row dim">GDELT DOC 2.0 geolocated world news · headline keyword score, not an editorial verdict</div></div>`;
      new maplibregl.Popup({ maxWidth: "340px" })
        .setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
    });
    map.on("mouseenter", "news-dots", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "news-dots", () => { map.getCanvas().style.cursor = ""; });
  }

  function render() {
    const src = map && map.getSource("news-dots-src");
    if (src) {
      src.setData({ type: "FeatureCollection", features: state.items.map(i => ({
        type: "Feature",
        properties: { title: i.title, url: i.url, date: i.date, sev: i.severity.level, sevlabel: i.severity.label },
        geometry: { type: "Point", coordinates: [i.lon, i.lat] },
      })) });
    }
    setChip(`◈ ${state.items.length} NEWS · 15 MIN`,
      "GDELT DOC 2.0 geolocated world headlines (conflict & disaster terms), refreshed every 15 minutes. Severity is a transparent headline-keyword score.");
  }

  async function refresh() {
    if (!state.on || state.busy) return;
    state.busy = true;
    let doc = null;
    try {
      const r = await fetch(NEW_URL);
      if (r.ok) doc = await r.json();
    } catch { /* keep last sweep */ }
    const items = normalize(doc, Date.now());
    if (items.length) { state.items = items; state.last = Date.now(); }
    state.busy = false;
    render();
  }

  let timer = null;

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      chip().classList.add("hidden");
      if (map.getLayer("news-dots")) map.removeLayer("news-dots");
      if (map.getSource("news-dots-src")) map.removeSource("news-dots-src");
      if (timer) { clearInterval(timer); timer = null; }
      return false;
    }
    state.on = true;
    await refresh();
    addLayers();
    render();
    timer = setInterval(refresh, 15 * 60 * 1000);
    return true;
  }

  function openList() {
    if (!state.items.length) return;
    if (typeof Contacts === "undefined") return;
    Contacts.open(`${state.items.length} REPORTS · LAST 24 H`, state.items.slice(0, 40).map(i => ({
      label: i.title,
      detail: `severity ${i.severity.level}/10 ${i.severity.label} · ${ageLabel(i.date, Date.now()) || "time unknown"}`,
      i,
    })), ({ i }) => {
      map.flyTo({ center: [i.lon, i.lat], zoom: Math.max(map.getZoom(), 5), speed: 1.6 });
      if (i.url) window.open(i.url, "_blank", "noopener,noreferrer");
    });
  }

  function restore() {
    if (state.on && map && !map.getSource("news-dots-src")) {
      addLayers();
      render();
      if (!timer) timer = setInterval(refresh, 15 * 60 * 1000);
    }
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, openList, normalize, severity, severityLabel: (t) => severity(t).label, ageLabel, _state: state };
})();
