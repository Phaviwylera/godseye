/* GOD'S EYE — OUTAGES layer: country-level internet outage alerts from IODA.
 *
 * IODA (Internet Outage Detection and Analysis) is a public research project at
 * Georgia Tech that measures network reachability from BGP, active probing,
 * Google traffic and Merit data. Its alerts API is keyless and reports, per
 * country and datasource, whether a signal is normal, warning or critical.
 *
 * These are network-health signals, not an outage confirmation and never a
 * person-level record. Countries are placed at their approximate national
 * centre from data/country-centroids.json; the card says so, because a country
 * centroid is not an event location.
 *
 * Same standing rules as every layer: real publisher data only, source cited,
 * no invented positions.
 */
const Outages = (() => {
  let map = null;
  let centroids = null;
  const state = { on: false, alerts: [], unmapped: 0, at: 0, error: "", timer: null };

  const SOURCE_URL = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts";
  const CENTROIDS_URL = "data/country-centroids.json";
  const REFRESH_MS = 5 * 60 * 1000;
  const WINDOW_HOURS = 24;
  const LIMIT = 1000;
  const LEVEL_RANK = { warning: 1, critical: 2 };
  const DATASOURCE_LABEL = {
    bgp: "BGP routing", "ping-slash24": "active probing", gtr: "Google traffic",
    "merit-nt": "Merit network",
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

  function levelColor(rank) {
    return rank >= 2 ? "#ff4d5e" : "#ffb454";
  }

  function levelLabel(level) {
    return level === "critical" ? "CRITICAL" : level === "warning" ? "WARNING" : "";
  }

  function datasourceLabel(source) {
    return DATASOURCE_LABEL[source] || String(source || "unknown source");
  }

  /** IODA alerts -> one latest non-normal alert per ISO-2 country. */
  function normalizeIoda(doc) {
    const rows = doc && Array.isArray(doc.data) ? doc.data : [];
    const byCode = new Map();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const level = String(row.level || "").trim().toLowerCase();
      const rank = LEVEL_RANK[level] || 0;
      if (!rank) continue;                              // normal is not an alert
      const entity = row.entity || {};
      const code = String(entity.code || "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) continue;
      if (row.time == null || row.time === "") continue;   // Number(null) would be 1970
      const time = Number(row.time);
      if (!Number.isFinite(time)) continue;
      const numeric = (value) => (value == null || value === "" ? null : Number(value));
      const value = numeric(row.value);
      const history = numeric(row.historyValue);
      const next = {
        code,
        name: String(entity.name || code).replace(/\s+/g, " ").trim(),
        level,
        rank,
        condition: String(row.condition || "").replace(/\s+/g, " ").trim(),
        value: Number.isFinite(value) ? value : null,
        history: Number.isFinite(history) ? history : null,
        datasource: String(row.datasource || "").trim(),
        method: String(row.method || "").trim(),
        time,
      };
      const prev = byCode.get(code);
      if (prev && (prev.time > next.time ||
          (prev.time === next.time && prev.rank >= next.rank))) continue;
      byCode.set(code, next);
    }
    return [...byCode.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  }

  /** Attach country centroids; rows without one are counted, not guessed. */
  function placeAlerts(alerts, table) {
    const out = [];
    let unmapped = 0;
    for (const alert of alerts) {
      const point = table && table[alert.code];
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
        unmapped++;
        continue;
      }
      out.push(Object.assign({}, alert, {
        lon: point.lon, lat: point.lat, place: point.name || alert.name,
      }));
    }
    return { rows: out, unmapped };
  }

  function fmtTime(seconds) {
    if (!Number.isFinite(seconds)) return "";
    return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";
  }

  function fmtNum(value) {
    return Number.isFinite(value) ? value.toLocaleString("en-US") : "—";
  }

  function card(a) {
    const changed = a.history != null && a.value != null
      ? ` · previous ${fmtNum(a.history)}` : "";
    return `<div class="ev-card">
      <div class="ev-q">⌁ ${esc(a.place || a.name)}</div>
      <div class="ev-row"><b>${esc(levelLabel(a.level))}</b> · ${esc(datasourceLabel(a.datasource))}</div>
      <div class="ev-row">signal ${fmtNum(a.value)}${changed}${a.condition ? " · condition " + esc(a.condition) : ""}</div>
      <div class="ev-row">${esc(fmtTime(a.time))}${a.method ? " · " + esc(a.method) : ""}</div>
      <div class="ev-row dim">IODA (Georgia Tech) public network telemetry. A signal deviation, not confirmation of an outage. Placed at the country's approximate centre, not an event location.</div>
      <div class="ev-row dim">Source: IODA — ioda.inetintel.cc.gatech.edu</div>
    </div>`;
  }

  /* ------------------------------------------------------------------- DOM -- */

  function chip() { return document.getElementById("outages-chip"); }
  function setChip(text, title) {
    const node = chip();
    if (!node) return;
    node.classList.remove("hidden");
    node.textContent = text;
    if (title) node.title = title;
  }

  function features() {
    return state.alerts.map((a) => ({
      type: "Feature",
      properties: { a: Object.assign({}, a, { color: levelColor(a.rank) }) },
      geometry: { type: "Point", coordinates: [a.lon, a.lat] },
    }));
  }

  function pushData() {
    const src = map && map.getSource("outages-geo");
    if (src) src.setData({ type: "FeatureCollection", features: features() });
  }

  function chipText() {
    if (!state.alerts.length) {
      return state.error ? "⌁ NET ALERTS · UNAVAILABLE" : "⌁ NO NET ALERTS";
    }
    const critical = state.alerts.filter((a) => a.rank >= 2).length;
    return `⌁ ${state.alerts.length} NET ALERTS` +
      (critical ? ` · ${critical} CRITICAL` : "") +
      (state.unmapped ? ` · ${state.unmapped} UNMAPPED` : "");
  }

  function addLayers() {
    if (!map || map.getSource("outages-geo")) return;
    map.addSource("outages-geo", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "outages-dots", type: "circle", source: "outages-geo",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4, 6, 7, 9, 12],
        "circle-color": ["get", "color"],
        "circle-opacity": 0.7,
        "circle-stroke-color": "rgba(10,4,8,.85)",
        "circle-stroke-width": 1,
      },
    });
    map.on("click", "outages-dots", (e) => {
      const f = e.features && e.features[0];
      if (!f || !f.properties || !f.properties.a) return;
      new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "340px" })
        .setLngLat(f.geometry.coordinates).setHTML(card(f.properties.a)).addTo(map);
    });
    map.on("mouseenter", "outages-dots", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "outages-dots", () => { map.getCanvas().style.cursor = ""; });
  }

  /* --------------------------------------------------------------- loading -- */

  async function loadCentroids() {
    if (centroids) return centroids;
    const r = await fetch(CENTROIDS_URL);
    if (!r.ok) throw new Error("country centroids " + r.status);
    const doc = await r.json();
    centroids = (doc && doc.centroids) || {};
    return centroids;
  }

  async function load() {
    const until = Math.floor(Date.now() / 1000);
    const from = until - WINDOW_HOURS * 3600;
    const url = `${SOURCE_URL}?entityType=country&from=${from}&until=${until}&limit=${LIMIT}`;
    const doc = await Sources.fetchJSON(url, 300);
    const table = await loadCentroids();
    const placed = placeAlerts(normalizeIoda(doc), table);
    state.alerts = placed.rows;
    state.unmapped = placed.unmapped;
    state.at = Date.now();
    state.error = "";
  }

  async function refreshAll() {
    try {
      await load();
    } catch (e) {
      state.error = String((e && e.message) || e || "unavailable");
      console.warn("outages: IODA", e);
    }
    pushData();
    const stamp = state.at ? ` Last sweep ${new Date(state.at).toISOString().slice(0, 16).replace("T", " ")}Z.` : "";
    setChip(chipText(),
      "Country-level internet outage alerts from IODA (Georgia Tech), last " +
      WINDOW_HOURS + " hours. A signal deviation, not confirmation of an outage." + stamp);
  }

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      if (chip()) chip().classList.add("hidden");
      if (map.getLayer("outages-dots")) map.removeLayer("outages-dots");
      if (map.getSource("outages-geo")) map.removeSource("outages-geo");
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
    if (state.on && map && !map.getSource("outages-geo")) {
      addLayers();
      pushData();
    }
  }

  function openList() {
    if (typeof Contacts === "undefined" || !state.alerts.length) return;
    Contacts.open(`NETWORK ALERTS · ${state.alerts.length} COUNTRIES`,
      state.alerts.map((a) => ({
        a,
        label: `${levelLabel(a.level)} · ${a.place || a.name}`,
        detail: `${datasourceLabel(a.datasource)}${a.condition ? " · " + a.condition : ""} · ${fmtTime(a.time)}`,
      })), ({ a }) => map.flyTo({ center: [a.lon, a.lat], zoom: 4, speed: 1.4 }));
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, openList, normalizeIoda, placeAlerts, levelColor,
    levelLabel, datasourceLabel, fmtTime, fmtNum, card, features, chipText, _state: state };
})();
