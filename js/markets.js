/* GOD'S EYE — MARKETS layer: live Polymarket prediction markets.
 *
 * Data: Polymarket's public Gamma API (gamma-api.polymarket.com) — keyless,
 * the same open feed traders use. The layer shows the top active markets by
 * 24 h volume, flags the ones moving fast (a transparent momentum flag, not
 * a model), and pins on the map the markets that are bound to a real place
 * (data/markets-geo.json, a curated recurring-topic table — extend it as new
 * recurring market categories appear). Everything else stays in the list.
 *
 * Ground rules, same as every other layer: real operator data only, source
 * cited in every card, no invented positions, no financial advice.
 */
const Markets = (() => {
  let map = null;
  const state = { on: false, markets: [], geoTable: null, loadedAt: 0, timer: null, loading: false };

  const API = "https://gamma-api.polymarket.com/markets?limit=300&active=true&closed=false";
  const REFRESH_MS = 10 * 60 * 1000;      // 10 minutes — well inside the feed's own update cadence
  const RELAY_WINDOW_SEC = 600;           // visitors share one upstream call per window

  /* ------------------------------------------------------------------ pure -- */

  /** Gamma market array -> normalised list sorted by 24 h volume, descending.
   *  Malformed rows (no price, no volume) are dropped, never patched to zero. */
  function normalize(raw) {
    const out = [];
    for (const m of raw || []) {
      if (!m || typeof m !== "object" || m.closed || !m.active) continue;
      let yes = Number(null);
      try {
        const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
        const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        const i = outcomes.indexOf("Yes");
        if (i < 0 || prices == null) continue;
        yes = Number(prices[i]);
      } catch { continue; }
      if (!Number.isFinite(yes) || yes < 0 || yes > 1) continue;
      const vol24 = Number(m.volume24hr ?? m.volume24hrClob ?? 0) || 0;
      const liq = Number(m.liquidityNum ?? m.liquidity ?? 0) || 0;
      const delta = Number(m.oneWeekPriceChange);
      const ends = m.endDateIso || m.endDate || "";
      out.push({
        id: String(m.id),
        question: String(m.question || m.slug || "market"),
        slug: String(m.slug || ""),
        yes,
        delta: Number.isFinite(delta) ? delta : null,
        vol24,
        liq,
        ends: String(ends).slice(0, 10),
        image: m.image || m.icon || "",
        url: "https://polymarket.com/market/" + (m.questionID || m.id),
      });
    }
    out.sort((a, b) => b.vol24 - a.vol24);
    return out;
  }

  /** Transparent momentum flag — it is deliberately simple and labelled as such:
   *  a market counts as "moving" when its price shifted at least 5 points in a
   *  week while 24 h volume is at least $100k. Information, not advice. */
  function signalFor(m) {
    const hot = Number.isFinite(m.delta) && Math.abs(m.delta) >= 0.05 && m.vol24 >= 100000;
    return { hot, dir: m.delta > 0 ? "up" : m.delta < 0 ? "down" : "flat" };
  }

  /** First curated place whose topic regex matches the market question. */
  function geoMatch(question, table) {
    const q = String(question || "").toLowerCase();
    if (!q) return null;
    for (const row of table || []) {
      if (row.re && new RegExp(row.re, "i").test(q)) {
        return { name: row.name, lon: Number(row.lon), lat: Number(row.lat), zoom: Number(row.zoom) || 10 };
      }
    }
    return null;
  }

  function fmtVol(v) {
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + Math.round(v / 1e3) + "k";
    return "$" + Math.round(v);
  }

  /** Safe HTML for the map popup. Every user-controlled string is escaped. */
  function cardHTML(m) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
    const sig = signalFor(m);
    const move = sig.hot
      ? `<span class="mk-mv">${sig.dir === "up" ? "▲" : "▼"} MOVING · 1W ${sig.dir === "up" ? "+" : ""}${(m.delta * 100).toFixed(0)}pts</span>`
      : "";
    return `<div class="mk-card">
      <div class="mk-q">${esc(m.question)}</div>
      <div class="mk-row"><b>${(m.yes * 100).toFixed(1)}%</b> yes ${move}</div>
      <div class="mk-row dim">24h ${esc(fmtVol(m.vol24))} · ends ${esc(m.ends || "—")}</div>
      <div class="mk-row dim">Source: Polymarket (public market data) · information, not advice</div>
      <a class="mk-link" href="${esc(m.url)}" target="_blank" rel="noopener">MARKET ↗</a>
    </div>`;
  }

  /* ------------------------------------------------------------------- DOM -- */

  function chip() { return document.getElementById("markets-chip"); }

  function setChip(text, title) {
    const c = chip();
    if (!c) return;
    c.classList.remove("hidden");
    c.textContent = text;
    if (title) c.title = title;
  }

  function addLayers() {
    if (map.getSource("markets-geo")) return;
    map.addSource("markets-geo", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "markets-dots",
      type: "circle",
      source: "markets-geo",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2.5, 6, 4, 9, 7],
        "circle-color": "#ffc457",
        "circle-stroke-color": "rgba(10,8,4,.9)",
        "circle-stroke-width": 1,
        "circle-opacity": 0.92,
      },
    });
    map.on("click", "markets-dots", (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      new maplibregl.Popup({ closeButton: true, closeOnClick: true })
        .setLngLat(f.geometry.coordinates)
        .setHTML(cardHTML(f.properties.market))
        .addTo(map);
    });
    map.on("mouseenter", "markets-dots", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "markets-dots", () => { map.getCanvas().style.cursor = ""; });
  }

  function refreshData() {
    return Sources.fetchJSON(API, RELAY_WINDOW_SEC).then((raw) => {
      state.markets = normalize(raw);
      state.loadedAt = Date.now();
      const geoRows = state.markets.filter((m) => geoMatch(m.question, state.geoTable));
      const src = map.getSource("markets-geo");
      if (src) src.setData({
        type: "FeatureCollection",
        features: geoRows.map((m) => {
          const g = geoMatch(m.question, state.geoTable);
          return { type: "Feature", properties: { market: m, place: g.name },
            geometry: { type: "Point", coordinates: [g.lon, g.lat] } };
        }),
      });
      setChip(`⊙ ${state.markets.length} MARKETS · ${geoRows.length} PLACED`,
        "Top Polymarket markets by 24 h volume. Dots mark markets tied to a real place. Refreshes every 10 minutes. Information and analysis — not financial advice.");
      return state.markets;
    });
  }

  async function loadGeoTable() {
    if (state.geoTable) return state.geoTable;
    const r = await fetch("data/markets-geo.json");
    if (!r.ok) throw new Error("markets geo table " + r.status);
    const doc = await r.json();
    state.geoTable = Array.isArray(doc.table) ? doc.table : [];
    return state.geoTable;
  }

  async function toggle() {
    if (!map) throw new Error("map not ready");
    if (state.on) {
      state.on = false;
      chip().classList.add("hidden");
      if (map.getLayer("markets-dots")) map.removeLayer("markets-dots");
      if (map.getSource("markets-geo")) map.removeSource("markets-geo");
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      return false;
    }
    state.on = true;
    if (!state.geoTable) await loadGeoTable();
    await refreshData();
    addLayers();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (state.on && !state.loading) {
        state.loading = true;
        refreshData().catch(() => {
          setChip("⊙ MARKETS · UPDATE FAILED", "Last good data is still shown.");
        }).finally(() => { state.loading = false; });
      }
    }, REFRESH_MS);
    return true;
  }

  function restore() {
    if (state.on && map && state.markets.length && !map.getSource("markets-geo")) {
      addLayers();
      refreshData().catch(() => {});
    }
  }

  function openList() {
    if (!state.markets.length) {
      setChip("⊙ MARKETS · LOADING…");
      return;
    }
    const rows = state.markets.slice(0, 100).map((m) => {
      const sig = signalFor(m);
      return {
        m,
        label: m.question.length > 64 ? m.question.slice(0, 61) + "…" : m.question,
        detail: `${(m.yes * 100).toFixed(1)}% yes · 24h ${fmtVol(m.vol24)}${sig.hot ? " · MOVING" : ""}`,
      };
    });
    Contacts.open("PREDICTION MARKETS — Polymarket", rows, ({ m }) => {
      const g = geoMatch(m.question, state.geoTable);
      if (g) {
        map.flyTo({ center: [g.lon, g.lat], zoom: g.zoom, duration: 1200 });
        new maplibregl.Popup({ closeButton: true })
          .setLngLat([g.lon, g.lat])
          .setHTML(cardHTML(m))
          .addTo(map);
      } else {
        window.open(m.url, "_blank", "noopener");
      }
    });
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, openList, normalize, signalFor, geoMatch, cardHTML, fmtVol, _state: state };
})();
