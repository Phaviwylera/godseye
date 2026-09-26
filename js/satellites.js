/* Predicted positions from a daily CelesTrak OMM snapshot, propagated with SGP4. */
const Satellites = (() => {
  let map, enabled = false, timer = null, records = [], handlersBound = false;
  const rad = 180 / Math.PI;
  const empty = () => ({ type: "FeatureCollection", features: [] });

  function parseCatalog(data, engine = satellite) {
    if (!data || !Array.isArray(data.records)) throw new Error("Invalid satellite catalog");
    const generated = Date.parse(data.generated);
    if (!Number.isFinite(generated) || Math.abs(Date.now() - generated) > 72 * 3600000) {
      throw new Error("Orbital catalog is older than 72 hours");
    }
    return data.records.flatMap(row => {
      const epoch = Date.parse(row.EPOCH + (/(?:Z|[+-]\d\d:?\d\d)$/.test(row.EPOCH) ? "" : "Z"));
      if (!Number.isFinite(epoch) || Math.abs(Date.now() - epoch) > 14 * 86400000) return [];
      try {
        const satrec = engine.json2satrec(row);
        return [{ name: String(row.OBJECT_NAME || "Satellite"), id: String(row.NORAD_CAT_ID),
          group: row.group === "GPS-OPS" ? "GPS" : "STATION", epoch, satrec }];
      } catch { return []; }
    });
  }

  function positionsAt(items, time = new Date(), engine = satellite) {
    const gmst = engine.gstime(time);
    return { type: "FeatureCollection", features: items.flatMap(item => {
      try {
        const pv = engine.propagate(item.satrec, time);
        if (!pv.position || !Number.isFinite(pv.position.x)) return [];
        const geo = engine.eciToGeodetic(pv.position, gmst);
        const lon = geo.longitude * rad, lat = geo.latitude * rad;
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(geo.height)) return [];
        return [{ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
          properties: { name: item.name, id: item.id, group: item.group,
            altitude: Math.round(geo.height), epoch: new Date(item.epoch).toISOString() } }];
      } catch { return []; }
    }) };
  }

  function update() {
    const source = map && map.getSource("satellites");
    if (!enabled || !source) return;
    const data = positionsAt(records);
    source.setData(data);
    const chip = document.getElementById("sat-chip");
    if (chip) {
      chip.textContent = `◇ ${data.features.length} SATELLITES · PREDICTED`;
      chip.title = "Stations and GPS satellites; positions predicted from CelesTrak orbital elements, not live telemetry.";
    }
  }

  function addLayers() {
    if (!map || !enabled) return;
    if (!map.getSource("satellites")) map.addSource("satellites", { type: "geojson", data: empty() });
    if (!map.getLayer("sat-dots")) map.addLayer({
      id: "sat-dots", type: "circle", source: "satellites",
      paint: { "circle-radius": ["case", ["==", ["get", "group"], "STATION"], 6, 4],
        "circle-color": ["case", ["==", ["get", "group"], "STATION"], "#a5ecff", "#e2ba78"],
        "circle-opacity": 0.9, "circle-stroke-color": "#06151b", "circle-stroke-width": 1.5 },
    });
    if (!handlersBound) {
      handlersBound = true;
      map.on("click", "sat-dots", event => {
        const feature = event.features && event.features[0];
        if (!feature) return;
        const p = feature.properties;
        const box = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = String(p.name);
        box.appendChild(title);
        const details = document.createElement("div");
        details.textContent = `${p.group} · NORAD ${p.id} · ${p.altitude} km altitude`;
        box.appendChild(details);
        const epoch = document.createElement("div");
        epoch.textContent = `Orbital elements: ${p.epoch} · predicted position`;
        box.appendChild(epoch);
        const link = document.createElement("a");
        link.href = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${encodeURIComponent(p.id)}&FORMAT=JSON`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "CelesTrak source ↗";
        box.appendChild(link);
        new maplibregl.Popup({ closeButton: true, maxWidth: "320px" })
          .setLngLat(feature.geometry.coordinates).setDOMContent(box).addTo(map);
      });
      map.on("mouseenter", "sat-dots", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "sat-dots", () => { map.getCanvas().style.cursor = ""; });
    }
    update();
  }

  async function toggle() {
    enabled = !enabled;
    const chip = document.getElementById("sat-chip");
    if (!enabled) {
      clearInterval(timer);
      if (chip) chip.classList.add("hidden");
      if (map.getLayer("sat-dots")) map.setLayoutProperty("sat-dots", "visibility", "none");
      return false;
    }
    if (chip) { chip.classList.remove("hidden"); chip.textContent = "◇ LOADING ORBITS…"; }
    try {
      if (!window.satellite) throw new Error("Orbit calculator unavailable");
      if (!records.length) {
        const response = await fetch("data/satellites.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`Orbital catalog HTTP ${response.status}`);
        records = parseCatalog(await response.json());
      }
      if (!records.length) throw new Error("No recent orbital elements");
      addLayers();
      map.setLayoutProperty("sat-dots", "visibility", "visible");
      clearInterval(timer);
      timer = setInterval(update, 30000);
      return true;
    } catch (error) {
      enabled = false;
      if (chip) { chip.textContent = "◇ ORBITS UNAVAILABLE"; chip.title = error.message; }
      return false;
    }
  }

  function restore() { if (enabled) addLayers(); }
  function init(m) { map = m; }
  return { init, toggle, restore, parseCatalog, positionsAt };
})();
