/* GOD'S EYE — layer state: the live layers named in a link.
 *
 * Every persistent map layer is a button in the tools panel. This module turns
 * those buttons into a short, stable vocabulary so a view can be linked with
 * `?layers=quakes,news,aurora` and restored on the next visit. It also accepts
 * the aliases used by the public GodsEYE dashboard URL (maritime, live_news,
 * earthquakes, day_night, ...) so a link naming a layer we ship does something
 * useful instead of silently doing nothing.
 *
 * Pure: no DOM and no network. app.js owns the buttons.
 */
const Layers = (() => {
  /* Canonical order is the order used in a shared link. It also keeps links
   * stable when two active layers finish loading in a different order. */
  const LIST = [
    { slug: "air", id: "btn-air", label: "Aircraft", aliases: ["sdk_air"] },
    { slug: "ships", id: "btn-vessels", label: "AIS vessels", aliases: ["maritime", "sdk_sea"] },
    { slug: "transit", id: "btn-transit", label: "Transit vehicles", aliases: [] },
    { slug: "airports", id: "btn-airports", label: "Airports", aliases: [] },
    { slug: "quakes", id: "btn-quakes", label: "Earthquakes", aliases: ["earthquakes"] },
    { slug: "events", id: "btn-events", label: "Storms, fires, volcanoes", aliases: [] },
    { slug: "news", id: "btn-news", label: "Geolocated news", aliases: ["live_news", "news_intel"] },
    { slug: "conflict", id: "btn-conflict", label: "Conflict events", aliases: [] },
    { slug: "hazards", id: "btn-hazards", label: "Disaster alerts", aliases: ["global_incidents"] },
    { slug: "outages", id: "btn-outages", label: "Internet outages", aliases: [] },
    { slug: "markets", id: "btn-markets", label: "Prediction markets", aliases: [] },
    { slug: "infra", id: "btn-infra", label: "Power, ports, cables", aliases: ["cables"] },
    { slug: "companies", id: "btn-companies", label: "Company HQs", aliases: [] },
    { slug: "countries", id: "btn-countries", label: "Country boundaries", aliases: [] },
    { slug: "radar", id: "btn-radar", label: "Weather radar", aliases: [] },
    { slug: "iss", id: "btn-iss", label: "ISS tracker", aliases: [] },
    { slug: "satellites", id: "btn-satellites", label: "Satellites", aliases: [] },
    { slug: "day-night", id: "btn-night", label: "Day/night terminator", aliases: ["day_night"] },
    { slug: "aurora", id: "btn-aurora", label: "Aurora forecast", aliases: ["space_weather"] },
  ];

  const BY_SLUG = new Map();
  for (const layer of LIST) {
    BY_SLUG.set(layer.slug, layer);
    for (const alias of layer.aliases) BY_SLUG.set(alias, layer);
  }

  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  function resolve(value) {
    return BY_SLUG.get(clean(value)) || null;
  }

  function fromId(id) {
    return LIST.find((layer) => layer.id === id) || null;
  }

  /* Read the first `layers=` pair by hand: URLSearchParams is unavailable in
   * the bare VM used by the tests, and a malformed escape must not throw. */
  function parse(search) {
    const raw = String(search || "").replace(/^\?/, "");
    let value = "";
    for (const part of raw.split("&")) {
      if (!part) continue;
      const at = part.indexOf("=");
      const key = at < 0 ? part : part.slice(0, at);
      if (key !== "layers") continue;
      const encoded = at < 0 ? "" : part.slice(at + 1);
      try { value = decodeURIComponent(encoded.replace(/\+/g, " ")); }
      catch { value = encoded; }
      break;
    }
    return canonical(value.split(/[,|]/).map((token) => token.trim()));
  }

  function canonical(slugs) {
    const wanted = new Set();
    for (const value of slugs || []) {
      const layer = resolve(value);
      if (layer) wanted.add(layer.slug);
    }
    return LIST.filter((layer) => wanted.has(layer.slug)).map((layer) => layer.slug);
  }

  /* Only named layers are written. An empty list removes the parameter, so a
   * plain visit keeps a clean address bar. */
  function query(slugs) {
    return canonical(slugs).join(",");
  }

  function label(slug) {
    const layer = resolve(slug);
    return layer ? layer.label : "";
  }

  return { LIST, resolve, fromId, parse, query, label, canonical };
})();
