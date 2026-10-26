/* GOD'S EYE — HAZARDS layer: global disaster alerts from GDACS.
 *
 * GDACS (Global Disaster Alert and Coordination System, run by the European
 * Commission JRC and UN OCHA) publishes a keyless event list covering
 * earthquakes, tropical cyclones, floods, volcanoes, droughts, wildfires and
 * tsunamis. Each row carries its own alert level (Green/Orange/Red) and a link
 * to the official report.
 *
 * Why this exists next to EVENTS: the NWS storm feed is US-only, while GDACS is
 * global and covers slow-onset events (drought) the US feed never reports. The
 * two layers are complementary; neither invents positions or alert levels.
 *
 * Same standing rules as every layer: real operator data only, source cited in
 * every card, no estimated epicentres or hand-drawn impact areas.
 */
const Hazards = (() => {
  let map = null;
  const state = { on: false, events: [], at: 0, error: "", timer: null };

  const SOURCE_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";
  const REFRESH_MS = 15 * 60 * 1000;
  const WINDOW_DAYS = 14;
  const ALERT_RANK = { Green: 1, Orange: 2, Red: 3 };
  const TYPE_LABEL = {
    EQ: "Earthquake", TC: "Tropical cyclone", FL: "Flood", VO: "Volcano",
    DR: "Drought", WF: "Wildfire", TS: "Tsunami",
  };
  const TYPE_ICON = { EQ: "⌁", TC: "◉", FL: "≋", VO: "△", DR: "☼", WF: "♨", TS: "≈" };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

  /* GDACS report links come from the feed. Allow only http(s): a feed bug must
   * never turn an anchor into javascript:/data: in the app origin. */
  function safeLink(value) {
    const text = String(value ?? "").trim();
    return /^https?:\/\//i.test(text) ? text : "";
  }

  function alertRank(level) {
    return ALERT_RANK[String(level || "").trim()] || 0;
  }

  function alertColor(rank) {
    return rank >= 3 ? "#ff4d5e" : rank === 2 ? "#ffb454" : "#8fe3a8";
  }

  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  /** GDACS FeatureCollection -> compact events with real coordinates only. */
  function normalizeGdacs(doc) {
    const feats = doc && Array.isArray(doc.features) ? doc.features : [];
    const out = [];
    for (const feature of feats) {
      const p = (feature && feature.properties) || {};
      const geom = (feature && feature.geometry) || {};
      const coords = Array.isArray(geom.coordinates) ? geom.coordinates : [];
      // Number(null) is 0: a missing coordinate must be dropped, not placed on
      // the equator or the prime meridian.
      const coord = (value) => (value == null || value === "" ? NaN : Number(value));
      const lon = coord(coords[0]);
      const lat = coord(coords[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      if (lat === 0 && lon === 0) continue;
      const type = String(p.eventtype || "").trim().toUpperCase();
      if (!TYPE_LABEL[type]) continue;
      const alert = String(p.alertlevel || "").trim();
      const rank = alertRank(alert);
      if (!rank) continue;
      const severity = (p.severitydata && p.severitydata.severitytext) || "";
      out.push({
        id: `${type}-${p.eventid == null ? "" : p.eventid}-${p.episodeid == null ? "0" : p.episodeid}`,
        type,
        typeLabel: TYPE_LABEL[type],
        icon: TYPE_ICON[type] || "⚠",
        name: String(p.name || p.eventname || "Unnamed event").replace(/\s+/g, " ").trim(),
        alert,
        rank,
        country: String(p.country || "").replace(/\s+/g, " ").trim(),
        iso3: String(p.iso3 || "").trim().toUpperCase(),
        from: String(p.fromdate || "").slice(0, 10),
        to: String(p.todate || "").slice(0, 10),
        current: p.iscurrent !== false,
        severity: String(severity).replace(/\s+/g, " ").slice(0, 160),
        description: String(p.description || p.htmldescription || "")
          .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 260),
        report: safeLink(p.url && p.url.report),
        details: safeLink(p.url && p.url.details),
        lon, lat,
      });
    }
    out.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
    return out;
  }

  function card(h) {
    const dates = h.from ? `${h.from}${h.to && h.to !== h.from ? " → " + h.to : ""}` : "";
    const report = safeLink(h.report);            // defence in depth: re-check at render time
    const link = report
      ? `<div class="ev-row"><a href="${report}" target="_blank" rel="noopener noreferrer">GDACS report ↗</a></div>`
      : "";
    return `<div class="ev-card">
      <div class="ev-q">${h.icon} ${esc(h.name)}</div>
      <div class="ev-row"><b>${esc(h.alert)} alert</b> · ${esc(h.typeLabel)}${h.country ? " · " + esc(h.country) : ""}</div>
      ${h.severity ? `<div class="ev-row">${esc(h.severity)}</div>` : ""}
      ${dates ? `<div class="ev-row">${esc(dates)}${h.current ? "" : " · ended"}</div>` : ""}
      ${h.description ? `<div class="ev-row dim">${esc(h.description)}</div>` : ""}
      ${link}
      ${typeof Context !== "undefined" ? Context.buttonHTML(h.lat, h.lon, h.name) : ""}
      <div class="ev-row dim">Source: GDACS (European Commission JRC / UN OCHA). Alert level is the publisher's.</div>
    </div>`;
  }

  /* ------------------------------------------------------------------- DOM -- */

  function chip() { return document.getElementById("hazards-chip"); }
  function setChip(text, title) {
    const node = chip();
    if (!node) return;
    node.classList.remove("hidden");
    node.textContent = text;
    if (title) node.title = title;
  }

  function features() {
    return state.events.map((h) => ({
      type: "Feature",
      properties: { h: Object.assign({}, h, { color: alertColor(h.rank) }) },
      geometry: { type: "Point", coordinates: [h.lon, h.lat] },
    }));
  }

  function pushData() {
    const src = map && map.getSource("hazards-geo");
    if (src) src.setData({ type: "FeatureCollection", features: features() });
  }

  function chipText() {
    if (!state.events.length) {
      return state.error ? "⚠ HAZARDS · UNAVAILABLE" : "⚠ NO REPORTED HAZARDS";
    }
    const red = state.events.filter((h) => h.rank >= 3).length;
    const orange = state.events.filter((h) => h.rank === 2).length;
    const active = state.events.filter((h) => h.current).length;
    return `⚠ ${state.events.length} HAZARDS · ${active} ACTIVE` +
      (red ? ` · ${red} RED` : "") + (orange ? ` · ${orange} ORANGE` : "");
  }

  function addLayers() {
    if (!map || map.getSource("hazards-geo")) return;
    map.addSource("hazards-geo", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "hazards-dots", type: "circle", source: "hazards-geo",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2,
          ["+", 3, ["*", ["get", "rank"], 1.4]], 6,
          ["+", 5, ["*", ["get", "rank"], 2.2]], 9,
          ["+", 8, ["*", ["get", "rank"], 3.2]]],
        "circle-color": ["get", "color"],
        "circle-opacity": 0.78,
        "circle-stroke-color": "rgba(8,4,6,.85)",
        "circle-stroke-width": 1,
      },
    });
    map.on("click", "hazards-dots", (e) => {
      const f = e.features && e.features[0];
      if (!f || !f.properties || !f.properties.h) return;
      new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "340px" })
        .setLngLat(f.geometry.coordinates).setHTML(card(f.properties.h)).addTo(map);
    });
    map.on("mouseenter", "hazards-dots", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "hazards-dots", () => { map.getCanvas().style.cursor = ""; });
  }

  /* --------------------------------------------------------------- loading -- */

  async function load() {
    const to = new Date();
    const from = new Date(to.getTime() - WINDOW_DAYS * 864e5);
    const url = `${SOURCE_URL}?fromDate=${isoDate(from)}&toDate=${isoDate(to)}`;
    const doc = await Sources.fetchJSON(url, 900);
    state.events = normalizeGdacs(doc);
    state.at = Date.now();
    state.error = "";
  }

  async function refreshAll() {
    try {
      await load();
    } catch (e) {
      state.error = String((e && e.message) || e || "unavailable");
      console.warn("hazards: GDACS", e);
    }
    pushData();
    const stamp = state.at ? ` Last sweep ${new Date(state.at).toISOString().slice(0, 16).replace("T", " ")}Z.` : "";
    setChip(chipText(),
      "Global disaster alerts from GDACS (EC JRC / UN OCHA), last " + WINDOW_DAYS + " days. " +
      "Alert colours and levels are the publisher's." + stamp);
  }

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      if (chip()) chip().classList.add("hidden");
      if (map.getLayer("hazards-dots")) map.removeLayer("hazards-dots");
      if (map.getSource("hazards-geo")) map.removeSource("hazards-geo");
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
    if (state.on && map && !map.getSource("hazards-geo")) {
      addLayers();
      pushData();
    }
  }

  function openList() {
    if (typeof Contacts === "undefined" || !state.events.length) return;
    Contacts.open(`GLOBAL HAZARDS · ${state.events.length} GDACS EVENTS`,
      state.events.map((h) => ({
        h,
        label: `${h.icon} ${h.alert.toUpperCase()} · ${h.name}`,
        detail: `${h.typeLabel}${h.country ? " · " + h.country : ""}${h.from ? " · " + h.from : ""}`,
      })), ({ h }) => map.flyTo({ center: [h.lon, h.lat], zoom: 6, speed: 1.4 }));
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, openList, normalizeGdacs, alertRank, alertColor,
    safeLink, card, features, chipText, _state: state };
})();
