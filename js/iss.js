/* GOD'S EYE — ISS PASSES: next visible passes of the station over the current
 * view center, computed locally with SGP4 (vendored satellite.js) from the
 * CelesTrak OMM snapshot in data/satellites.json. No live telemetry is claimed:
 * the header says the elements' epoch, and old elements warn.
 *
 * The vendored build exports propagate/gstime/geodeticToEcf/json2satrec; the
 * ECI→ECF rotation and the ENU topocentric step are implemented here (both are
 * the standard fixed rotations) and unit-tested in tests/iss.test.mjs.
 */
const Iss = (() => {
  const DEG = Math.PI / 180;
  let open = false;

  function engine() {
    const e = globalThis.satellite;
    if (!e) throw new Error("satellite.js not loaded");
    return e;
  }

  /* --------------------------------------------------------------- math --- */

  /** ECI (GMST-inertial frame) -> Earth-fixed: rotation about Z by -gmst. */
  function eciToEcf(p, gmst) {
    const c = Math.cos(gmst), s = Math.sin(gmst);
    return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c, z: p.z };
  }

  /** ENU (east/north/up, km) of a satellite relative to an observer. */
  function topocentric(obsEcf, satEcf, lonRad, latRad) {
    const x = satEcf.x - obsEcf.x, y = satEcf.y - obsEcf.y, z = satEcf.z - obsEcf.z;
    const sl = Math.sin(lonRad), cl = Math.cos(lonRad), sa = Math.sin(latRad), ca = Math.cos(latRad);
    return {
      x: -sl * x + cl * y,
      y: -sa * cl * x - sa * sl * y + ca * z,
      z: ca * cl * x + ca * sl * y + sa * z,
    };
  }

  function horizon(enu) {
    return {
      elevation: Math.atan2(enu.z, Math.hypot(enu.x, enu.y)),
      azimuth: Math.atan2(enu.x, enu.y), // from true north, through east
    };
  }

  /** Elevation (radians) of a satrec at time t for observer {lat, lon (deg), heightKm}; null on propagation failure. */
  function elevationAt(satrec, t, obs) { return horizonAt(satrec, t, obs)?.elevation ?? null; }

  function horizonAt(satrec, t, obs) {
    const e = engine();
    // The vendored engine's propagate/gstime type-check `instanceof Date` —
    // a raw ms number is silently misparsed as a year, so always hand it a Date.
    const when = new Date(t);
    const pv = e.propagate(satrec, when);
    if (!pv || !pv.position || !Number.isFinite(pv.position.x)) return null;
    const gmst = e.gstime(when);
    const sat = eciToEcf(pv.position, gmst);
    // geodeticToEcf takes {longitude, latitude, height} in radians/kilometres.
    const o = e.geodeticToEcf({ longitude: obs.lon * DEG, latitude: obs.lat * DEG, height: obs.heightKm });
    return horizon(topocentric(o, sat, obs.lon * DEG, obs.lat * DEG));
  }

  /** Visible passes (max elevation >= minElevDeg) in [from, from+hours].
   *  Step default 20 s — a pass lasts ≤ ~7 min, so peaks are well sampled. */
  function findPasses(satrec, obs, { from, hours = 72, stepSec = 20, minElevDeg = 5 } = {}) {
    const out = [];
    let cur = null;
    const tEnd = from + hours * 3600 * 1000;
    for (let t = from; t <= tEnd; t += stepSec * 1000) {
      const h = horizonAt(satrec, t, obs);
      if (!h) continue;
      if (cur === null && h.elevation >= 0) {
        cur = { start: t, riseAz: h.azimuth, maxEl: h.elevation, maxAt: t, end: t, setAz: null };
      } else if (cur) {
        cur.end = t;
        if (h.elevation > cur.maxEl) { cur.maxEl = h.elevation; cur.maxAt = t; }
        if (h.elevation < 0) {
          cur.setAz = h.azimuth;
          if (cur.maxEl >= minElevDeg * DEG) out.push(cur);
          cur = null;
        }
      }
    }
    if (cur && cur.maxEl >= minElevDeg * DEG) out.push(cur); // still up at window end
    return out.slice(0, 12);
  }

  function compass(azRad) {
    if (azRad == null) return "—";
    let deg = (azRad / DEG) % 360; if (deg < 0) deg += 360;
    const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return pts[Math.round(deg / 22.5) % 16] + " " + Math.round(deg) + "°";
  }

  /* ----------------------------------------------------------------- DOM -- */

  const $ = (s) => document.querySelector(s);
  let satrec = null, epoch = null, obs = null, passes = [], busy = false, lastError = "";

  function setBusy(b) {
    busy = b;
    const body = $("#iss-body");
    if (body) body.classList.toggle("iss-busy", b);
  }

  function fmtWhen(t) {
    return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function render() {
    const body = $("#iss-body");
    const meta = $("#iss-meta");
    if (!body || !meta) return;
    if (lastError) {
      meta.textContent = "unavailable — " + lastError;
      body.replaceChildren(noteRow("No fabricated pass times: the snapshot or the propagator failed, and the layer says so instead of guessing."));
      return;
    }
    if (!satrec) {
      meta.textContent = "no ISS elements in the snapshot";
      body.replaceChildren(noteRow("The CelesTrak snapshot has no ISS (ZARYA) record."));
      return;
    }
    const ageDays = (Date.now() - epoch) / 86400000;
    meta.textContent = `observer ${obs.lat.toFixed(3)}°, ${obs.lon.toFixed(3)}° · SGP4 elements epoch ${new Date(epoch).toISOString().slice(0, 10)}${ageDays > 7 ? " · STALE — passes approximate" : ""}`;
    const rows = [];
    if (!passes.length) rows.push(noteRow("No pass with peak elevation ≥ 5° in the next 72 h from this view center."));
    for (const p of passes) {
      rows.push(noteRow(
        `${fmtWhen(p.start)} · peak ${(p.maxEl / DEG).toFixed(0)}° at ${fmtWhen(p.maxAt)} · ` +
        `~${Math.round((p.end - p.start) / 60000)} min · rise ${compass(p.riseAz)} → set ${compass(p.setAz)}`));
    }
    body.replaceChildren(...rows);
  }

  function noteRow(text) {
    const d = document.createElement("div");
    d.className = "iss-row";
    d.textContent = text;
    return d;
  }

  async function loadElements() {
    const r = await fetch("data/satellites.json");
    if (!r.ok) throw new Error("snapshot unavailable");
    const doc = await r.json();
    const rec = (doc.records || []).find(x => x.OBJECT_NAME === "ISS (ZARYA)");
    if (!rec) throw new Error("no ISS record in snapshot");
    satrec = engine().json2satrec(rec);
    const eRaw = String(rec.EPOCH || "");
    epoch = Date.parse(eRaw + (/(?:Z|[+-]\d\d:\d\d)$/.test(eRaw) ? "" : "Z"));
    if (!Number.isFinite(epoch) || epoch <= 0) throw new Error("elements missing epoch");
  }

  async function compute() {
    if (!mapReady()) return;
    setBusy(true);
    lastError = "";
    try {
      await loadElements();
      const c = currentMap().getCenter();
      obs = { lat: c.lat, lon: c.lng, heightKm: 0.05 };
      passes = findPasses(satrec, obs, { from: Date.now(), hours: 72 });
    } catch (error) {
      lastError = String(error.message || error);
      satrec = null; passes = [];
    }
    setBusy(false);
    render();
  }

  function mapReady() { return !!globalThis.__geMap; }
  function currentMap() { return globalThis.__geMap; }

  function show() {
    open = true;
    const m = $("#iss-modal");
    if (m) m.classList.remove("hidden");
    compute();
  }
  function hide() {
    open = false;
    const m = $("#iss-modal");
    if (m) m.classList.add("hidden");
  }
  function visible() { return open; }

  function init(map) {
    globalThis.__geMap = map;
    const btn = document.getElementById("btn-iss-passes");
    if (btn) btn.onclick = () => (open ? hide() : show());
    const close = $("#iss-close");
    if (close) close.onclick = hide;
    const refresh = $("#iss-refresh");
    if (refresh) refresh.onclick = () => compute();
    $("#iss-modal").addEventListener("click", (e) => { if (e.target.id === "iss-modal") hide(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) hide(); });
  }

  return { init, show, hide, visible, compute, eciToEcf, topocentric, horizon, elevationAt, horizonAt, findPasses, compass, _state: { get satrec() { return satrec; }, get passes() { return passes; } } };
})();
