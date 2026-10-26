/* GOD'S EYE — POINT CONTEXT: what the public feeds already held around a point.
 *
 * The camera catalogue is local; every other group is read from a layer that
 * is already on screen (GDACS, USGS, NWS, NASA FIRMS, UCDP, GDELT, ADS-B, AIS).
 * Nothing is fetched for a point, nothing is interpolated, and a layer that is
 * off is named as off instead of being shown as an empty world.
 *
 * The only computed value is the geodesic distance from the point the
 * publisher reported to the point the operator asked about. A camera near a
 * fire is not a camera looking at it; the panel says so.
 */
const Context = (() => {
  const RADII = [25, 100, 250];
  const DEFAULT_RADIUS = 100;
  const MAX_ROWS = 8;

  let map = null;
  const state = { open: false, lat: 0, lon: 0, label: "", radiusKm: DEFAULT_RADIUS };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

  /* ------------------------------------------------------------------ pure -- */

  const rad = Math.PI / 180;

  function haversineKm(lat1, lon1, lat2, lon2) {
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function fmtKm(km) {
    if (!Number.isFinite(km)) return "?";
    if (km < 1) return Math.round(km * 1000) + " m";
    if (km < 10) return (Math.round(km * 10) / 10) + " km";
    return Math.round(km) + " km";
  }

  /** Nearest items inside the radius, each carrying `km`. Input order is not trusted. */
  function nearby(items, lat, lon, radiusKm, limit = MAX_ROWS) {
    const out = [];
    for (const item of items || []) {
      const ilat = Number(item && item.lat);
      const ilon = Number(item && item.lon);
      if (!Number.isFinite(ilat) || !Number.isFinite(ilon)) continue;
      const km = haversineKm(lat, lon, ilat, ilon);
      if (km <= radiusKm) out.push(Object.assign({}, item, { km }));
    }
    out.sort((a, b) => a.km - b.km);
    return out.slice(0, limit);
  }

  function countInside(items, lat, lon, radiusKm) {
    let n = 0;
    for (const item of items || []) {
      const km = haversineKm(lat, lon, Number(item && item.lat), Number(item && item.lon));
      if (km <= radiusKm) n++;
    }
    return n;
  }

  /**
   * Group the sources around one point. `sources` is injected so this stays
   * testable without a browser: each group is an array of {lat, lon, ...}.
   */
  function scan(lat, lon, radiusKm, sources) {
    const src = sources || {};
    const radius = Number.isFinite(Number(radiusKm)) ? Number(radiusKm) : DEFAULT_RADIUS;
    const groups = {};
    for (const key of ["cameras", "aircraft", "vessels", "hazards", "quakes", "storms",
      "fires", "conflicts", "news"]) {
      groups[key] = nearby(src[key], lat, lon, radius);
      groups[key + "Total"] = countInside(src[key], lat, lon, radius);
    }
    groups.airport = src.airport || null;
    groups.layers = src.layers || {};
    return groups;
  }

  function buttonHTML(lat, lon, label) {
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return "";
    return `<button type="button" class="ev-ctx" data-ctx-lat="${la}" data-ctx-lon="${lo}"` +
      ` data-ctx-label="${esc(label || "")}" title="Show public cameras and live layers around this point">` +
      `⌖ AREA CONTEXT</button>`;
  }

  function sectionLines(title, rows, describe) {
    if (!rows.length) return [];
    return [title + " (" + rows.length + ")", ...rows.map((row) => "- " + describe(row))];
  }

  /** Plain-text brief for the clipboard; same groups the panel draws. */
  function plainText(groups, lat, lon, radiusKm, now) {
    const g = groups || {};
    const when = new Date(now == null ? Date.now() : now).toISOString().replace(/\.\d{3}Z$/, "Z");
    const lines = [
      "GOD'S EYE — AREA CONTEXT",
      Number(lat).toFixed(4) + ", " + Number(lon).toFixed(4) + " · radius " + radiusKm + " km",
      "generated " + when,
      "",
    ];
    lines.push(...sectionLines("PUBLIC CAMERAS", g.cameras || [], (c) =>
      fmtKm(c.km) + " · " + (c.label || c.id) + (c.detail ? " · " + c.detail : "")));
    lines.push(...sectionLines("ACTIVE HAZARDS", g.hazards || [], (h) =>
      fmtKm(h.km) + " · " + (h.label || "hazard") + (h.detail ? " · " + h.detail : "")));
    lines.push(...sectionLines("EARTHQUAKES (24 H)", g.quakes || [], (q) =>
      fmtKm(q.km) + " · " + (q.label || "earthquake") + (q.detail ? " · " + q.detail : "")));
    lines.push(...sectionLines("STORMS & FIRES", (g.storms || []).concat(g.fires || []), (e) =>
      fmtKm(e.km) + " · " + (e.label || "event") + (e.detail ? " · " + e.detail : "")));
    lines.push(...sectionLines("CONFLICT EVENTS", g.conflicts || [], (c) =>
      fmtKm(c.km) + " · " + (c.label || "event") + (c.detail ? " · " + c.detail : "")));
    lines.push(...sectionLines("GEOLOCATED NEWS", g.news || [], (n) =>
      fmtKm(n.km) + " · " + (n.label || "headline")));
    lines.push(...sectionLines("AIRCRAFT", g.aircraft || [], (a) =>
      fmtKm(a.km) + " · " + (a.label || "aircraft") + (a.detail ? " · " + a.detail : "")));
    lines.push(...sectionLines("VESSELS", g.vessels || [], (v) =>
      fmtKm(v.km) + " · " + (v.label || "vessel") + (v.detail ? " · " + v.detail : "")));
    if (g.airport) lines.push("NEAREST MAJOR AIRPORT", "- " + g.airport.code + " · " + g.airport.name +
      " · " + fmtKm(g.airport.km), "");
    lines.push("Sources: camera catalogue; GDACS; USGS; NOAA/NWS; NASA FIRMS; UCDP; GDELT; ADS-B; AIS.");
    lines.push("Publisher positions, geodesic distances. A nearby camera is not necessarily aimed at this point.");
    return lines.join("\n");
  }

  /* --------------------------------------------------------------- sources -- */

  /* Classic scripts declare modules as top-level `const`, so they are lexical
   * globals rather than properties of `window`. `typeof NAME` is the one test
   * that is safe when the module is absent (bare `NAME` would throw). */
  function moduleState(name, get) {
    try {
      if (name === "Intel" && typeof Intel !== "undefined") return get(Intel);
      if (name === "Vessels" && typeof Vessels !== "undefined") return get(Vessels);
      if (name === "Hazards" && typeof Hazards !== "undefined") return get(Hazards);
      if (name === "Events" && typeof Events !== "undefined") return get(Events);
      if (name === "Conflict" && typeof Conflict !== "undefined") return get(Conflict);
      if (name === "News" && typeof News !== "undefined") return get(News);
    } catch { /* a module that failed to boot is reported as off */ }
    return null;
  }

  function readSources() {
    const cameras = [];
    const cams = window.GE_CAMS || {};
    for (const id of Object.keys(cams)) {
      const cam = cams[id];
      if (!cam) continue;
      cameras.push({
        id,
        lat: Number(cam.lat),
        lon: Number(cam.lon),
        label: cam.name || id,
        detail: [cam.place, cam.region, cam.country].filter(Boolean).join(" · "),
        stype: cam.stype || "",
        live: cam.live,
      });
    }

    const layers = {};
    const aircraft = [];
    const intelState = moduleState("Intel", (mod) => mod.state);
    layers.air = !!(intelState && intelState.air);
    if (layers.air && intelState && Array.isArray(intelState.airFeatures)) {
      for (const feature of intelState.airFeatures) {
        const coordinates = feature && feature.geometry && feature.geometry.coordinates;
        if (!Array.isArray(coordinates)) continue;
        const p = feature.properties || {};
        aircraft.push({
          lat: Number(coordinates[1]),
          lon: Number(coordinates[0]),
          label: p.callsign || p.hex || "aircraft",
          detail: [p.type, p.alt != null ? p.alt + " ft" : "",
            p.gs != null ? p.gs + " kt" : "", p.reg].filter(Boolean).join(" · "),
        });
      }
    }

    const vessels = [];
    const shipsBtn = document.getElementById("btn-vessels");
    layers.ships = !!(shipsBtn && shipsBtn.classList.contains("active"));
    const vesselList = moduleState("Vessels", (mod) =>
      (typeof mod.list === "function" ? mod.list() : null));
    if (Array.isArray(vesselList)) {
      for (const v of vesselList) {
        vessels.push({
          lat: Number(v.lat),
          lon: Number(v.lon),
          label: v.name || ("MMSI " + v.mmsi),
          detail: [v.speed != null ? v.speed + " kn" : "", v.ofac ? "OFAC designation" : ""]
            .filter(Boolean).join(" · "),
        });
      }
    }

    const hazards = [];
    const hazardState = moduleState("Hazards", (mod) => mod._state);
    layers.hazards = !!(hazardState && hazardState.on);
    if (layers.hazards) {
      for (const h of hazardState.events || []) hazards.push({
        lat: Number(h.lat), lon: Number(h.lon), label: h.name,
        detail: [h.alert + " alert", h.typeLabel, h.country].filter(Boolean).join(" · "),
        report: h.report,
      });
    }

    const quakes = [];
    layers.quakes = !!(intelState && intelState.quakes);
    if (layers.quakes && intelState && Array.isArray(intelState.quakeFeatures)) {
      for (const feature of intelState.quakeFeatures) {
        const coordinates = feature && feature.geometry && feature.geometry.coordinates;
        if (!Array.isArray(coordinates)) continue;
        const p = feature.properties || {};
        const mag = Number(p.mag);
        quakes.push({
          lat: Number(coordinates[1]), lon: Number(coordinates[0]),
          label: (Number.isFinite(mag) ? "M" + mag.toFixed(1) + " · " : "") + (p.place || "earthquake"),
          detail: p.time ? new Date(p.time).toISOString().slice(0, 16).replace("T", " ") + "Z" : "",
          url: p.url,
        });
      }
    }

    const storms = [];
    const fires = [];
    const eventState = moduleState("Events", (mod) => mod._state);
    layers.events = !!(eventState && eventState.on);
    if (layers.events) {
      for (const s of eventState.storms || []) storms.push({
        lat: Number(s.lat), lon: Number(s.lon), label: s.event,
        detail: [s.severity, s.issued ? String(s.issued).slice(0, 16).replace("T", " ") : ""]
          .filter(Boolean).join(" · "),
      });
      for (const f of eventState.fires || []) fires.push({
        lat: Number(f.lat), lon: Number(f.lon), label: "Fire hotspot",
        detail: [f.bright != null ? f.bright.toFixed(1) + " K" : "",
          f.date || "", f.time ? f.time.slice(0, 2) + ":" + f.time.slice(2) + " UTC" : ""]
          .filter(Boolean).join(" · "),
      });
    }

    const conflicts = [];
    const conflictState = moduleState("Conflict", (mod) => mod._state);
    layers.conflict = !!(conflictState && conflictState.on);
    if (layers.conflict) {
      for (const ev of conflictState.events || []) conflicts.push({
        lat: Number(ev[2]), lon: Number(ev[1]),
        label: (ev[3] || "Unknown country") + (ev[4] ? " · " + ev[4] : ""),
        detail: [ev[0], Conflict.kindOf(ev), ev[6] ? ev[6] + " reported killed" : "no reported deaths"]
          .filter(Boolean).join(" · "),
      });
    }

    const news = [];
    const newsState = moduleState("News", (mod) => mod._state);
    layers.news = !!(newsState && newsState.on);
    if (layers.news) {
      for (const item of newsState.items || []) news.push({
        lat: Number(item.lat), lon: Number(item.lon), label: item.title,
        detail: [item.severity ? "severity " + item.severity.level + "/10" : "",
          item.severity ? item.severity.label : ""].filter(Boolean).join(" · "),
        url: item.url,
      });
    }

    let airport = null;
    const nearest = moduleState("Intel", (mod) =>
      (typeof mod.nearestAirport === "function" ? mod.nearestAirport : null));
    if (typeof nearest === "function") {
      try { airport = nearest(Number(state.lon), Number(state.lat)); } catch { airport = null; }
    }

    return { cameras, aircraft, vessels, hazards, quakes, storms, fires, conflicts, news, airport, layers };
  }

  /* ------------------------------------------------------------------- DOM -- */

  function row(label, detail, km, options) {
    const opts = options || {};
    const tag = opts.tag ? `<span class="ctx-tag">${esc(opts.tag)}</span>` : "";
    const kmText = km == null ? "" : `<span class="ctx-km">${fmtKm(km)}</span>`;
    return `<li class="ctx-item"${opts.id ? ` data-cam-id="${esc(opts.id)}"` : ""}${opts.href ? ` data-href="${esc(opts.href)}"` : ""}>` +
      kmText + `<div><div class="ctx-label">${esc(label)}</div>` +
      (detail ? `<div class="ctx-detail">${esc(detail)}</div>` : "") + "</div>" + tag + "</li>";
  }

  function section(title, rows, note) {
    if (!rows.length) return "";
    return `<section class="ctx-section"><h5>${esc(title)} <span>${rows.length}</span></h5>` +
      `<ul>${rows.join("")}</ul>` +
      (note ? `<div class="ctx-note">${esc(note)}</div>` : "") + "</section>";
  }

  function empty(title, text) {
    return `<section class="ctx-section ctx-empty"><h5>${esc(title)}</h5>` +
      `<div class="ctx-note">${esc(text)}</div></section>`;
  }

  function render(groups) {
    const body = document.getElementById("context-body");
    if (!body) return;
    const g = groups;
    const radius = state.radiusKm;
    const parts = [];

    if (g.cameras.length) {
      parts.push(section("PUBLIC CAMERAS", g.cameras.map((c) => row(c.label, c.detail, c.km, {
        id: c.id, tag: c.stype || "",
      })), "Publisher positions. " + g.camerasTotal + " catalogued camera" +
        (g.camerasTotal === 1 ? "" : "s") + " within " + radius + " km — the nearest may not be aimed here."));
    } else {
      parts.push(empty("PUBLIC CAMERAS", "No camera in the public catalogue within " + radius +
        " km. That is a catalogue coverage gap, not an absence of cameras."));
    }

    if (!g.layers.hazards) parts.push(empty("ACTIVE HAZARDS", "HAZARDS layer is off."));
    else if (g.hazards.length) parts.push(section("ACTIVE HAZARDS", g.hazards.map((h) =>
      row(h.label, h.detail, h.km)), "GDACS alert level is the publisher's."));
    else parts.push(empty("ACTIVE HAZARDS", "No active GDACS alert within " + radius + " km."));

    if (!g.layers.quakes) parts.push(empty("EARTHQUAKES", "QUAKES layer is off."));
    else if (g.quakes.length) parts.push(section("EARTHQUAKES · 24 H", g.quakes.map((q) =>
      row(q.label, q.detail, q.km, { href: q.url })), "USGS magnitude 2.5+ in the last 24 hours."));
    else parts.push(empty("EARTHQUAKES", "No USGS M2.5+ event within " + radius + " km in the last 24 hours."));

    const weather = g.storms.map((s) => row(s.label, s.detail, s.km))
      .concat(g.fires.map((f) => row(f.label, f.detail, f.km, { tag: "FIRE" })));
    if (!g.layers.events) parts.push(empty("STORMS & FIRES", "EVENTS layer is off."));
    else if (weather.length) parts.push(section("STORMS & FIRES", weather,
      "NWS alerts are US-only; FIRMS detects thermal signals, not necessarily wildfires."));
    else parts.push(empty("STORMS & FIRES", "No NWS alert or FIRMS hotspot within " + radius + " km."));

    if (g.layers.conflict) {
      if (g.conflicts.length) parts.push(section("CONFLICT EVENTS", g.conflicts.map((c) =>
        row(c.label, c.detail, c.km)), "UCDP/PRIO GED classification; no frontlines are drawn."));
      else parts.push(empty("CONFLICT EVENTS", "No recorded UCDP event within " + radius + " km."));
    }

    if (g.layers.news) {
      if (g.news.length) parts.push(section("GEOLOCATED NEWS", g.news.map((n) =>
        row(n.label, n.detail, n.km, { href: n.url })), "GDELT geocoding; severity is a headline keyword score."));
      else parts.push(empty("GEOLOCATED NEWS", "No geolocated GDELT headline within " + radius + " km."));
    }

    if (g.layers.air) {
      if (g.aircraft.length) parts.push(section("AIRCRAFT", g.aircraft.map((a) =>
        row(a.label, a.detail, a.km)), "ADS-B positions as reported, including estimated ones."));
      else parts.push(empty("AIRCRAFT", "No aircraft reported within " + radius + " km."));
    }

    if (g.layers.ships) {
      if (g.vessels.length) parts.push(section("VESSELS", g.vessels.map((v) =>
        row(v.label, v.detail, v.km)), "AIS observations may be minutes old and cover selected corridors."));
      else parts.push(empty("VESSELS", "No vessel reported within " + radius + " km."));
    }

    if (g.airport) {
      parts.push(section("NEAREST MAJOR AIRPORT", [row(g.airport.name, g.airport.code, g.airport.km)],
        "Bundled major-airport list, straight-line distance."));
    }

    if (!g.layers.air || !g.layers.ships) {
      parts.push(`<div class="ctx-note">Live aircraft and ships appear here when the AIR and SHIPS layers are on.</div>`);
    }

    body.innerHTML = parts.join("");
    body.querySelectorAll("li[data-cam-id]").forEach((li) => {
      li.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("ge-open-cam", { detail: li.dataset.camId }));
        close();
      });
    });
    body.querySelectorAll("li[data-href]").forEach((li) => {
      li.classList.add("ctx-linked");
      li.addEventListener("click", () => window.open(li.dataset.href, "_blank", "noopener,noreferrer"));
    });

    const meta = document.getElementById("context-meta");
    if (meta) {
      const bits = [state.lat.toFixed(4) + ", " + state.lon.toFixed(4), radius + " km radius"];
      if (state.label) bits.unshift(state.label);
      bits.push(new Date().toISOString().slice(11, 16) + "Z");
      meta.textContent = bits.join(" · ");
    }
  }

  function refresh() {
    if (!state.open) return;
    render(scan(state.lat, state.lon, state.radiusKm, readSources()));
  }

  function open(lat, lon, label) {
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    state.open = true;
    state.lat = Math.max(-90, Math.min(90, la));
    state.lon = ((lo + 540) % 360) - 180;
    state.label = String(label || "");
    const modal = document.getElementById("context-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refresh();
  }

  function close() {
    state.open = false;
    const modal = document.getElementById("context-modal");
    if (modal) modal.classList.add("hidden");
  }

  function setRadius(km) {
    const value = Number(km);
    if (!RADII.includes(value)) return;
    state.radiusKm = value;
    document.querySelectorAll("[data-ctx-radius]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.ctxRadius) === value);
    });
    refresh();
  }

  function copyBrief() {
    const text = plainText(scan(state.lat, state.lon, state.radiusKm, readSources()),
      state.lat, state.lon, state.radiusKm);
    const button = document.getElementById("context-copy");
    const done = () => { if (button) { button.textContent = "COPIED"; setTimeout(() => { button.textContent = "COPY BRIEF"; }, 1400); } };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); done(); } catch { /* the panel still shows the brief */ }
    area.remove();
  }

  function attach() {
    document.addEventListener("click", (event) => {
      const button = event.target && event.target.closest && event.target.closest("[data-ctx-lat]");
      if (!button) return;
      event.preventDefault();
      open(button.dataset.ctxLat, button.dataset.ctxLon, button.dataset.ctxLabel);
    });
  }

  function init(instance) {
    map = instance;
    const closeBtn = document.getElementById("context-close");
    if (closeBtn) closeBtn.onclick = close;
    const modal = document.getElementById("context-modal");
    if (modal) modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
    const copyBtn = document.getElementById("context-copy");
    if (copyBtn) copyBtn.onclick = copyBrief;
    document.querySelectorAll("[data-ctx-radius]").forEach((btn) => {
      btn.addEventListener("click", () => setRadius(btn.dataset.ctxRadius));
    });
    const scanBtn = document.getElementById("btn-context-scan");
    if (scanBtn) scanBtn.onclick = () => {
      if (!map) return;
      const centre = map.getCenter();
      open(centre.lat, centre.lng, "map centre");
    };
    if (map && typeof map.on === "function") {
      map.on("contextmenu", (event) => {
        if (!event || !event.lngLat) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        open(event.lngLat.lat, event.lngLat.lng, "map point");
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) close();
    });
    attach();
  }

  return {
    init, open, close, refresh, setRadius, copyBrief, readSources,
    scan, nearby, countInside, haversineKm, fmtKm, plainText, buttonHTML,
    RADII, DEFAULT_RADIUS, _state: state,
  };
})();
