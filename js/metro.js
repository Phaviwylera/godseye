/* METRO — live metro / urban-rail networks: line geometry, stations and trains.
 *
 * Every network here is a feed the operator publishes openly for riders.
 * Two kinds of feed are supported and they are labelled differently in the UI:
 *
 *   positions — live vehicle coordinates (OneBusAway: Sound Transit Link light rail)
 *   arrivals  — live arrival predictions with no vehicle coordinates; a train is
 *               drawn at the station it is next due at (TfL, BART)
 *
 * Line geometry and station positions are fetched once per session; only the
 * train positions are polled. Nothing is fabricated: a network whose feed fails
 * is reported as unavailable rather than filled in with guesses.
 */
const Metro = (() => {
  let map = null;
  let enabled = false;
  let timer = null;
  let bound = false;
  let requestId = 0;
  let registry = [];
  let trains = [];
  let lines = [];
  let stations = [];
  let selected = null;
  const history = new Map();      // train key -> [[lon, lat, ms], ...]
  const staticDone = new Set();   // feeds whose lines + stations are loaded

  const REFRESH_MS = 60000;
  const HISTORY_MS = 30 * 60 * 1000;
  const chip = () => document.getElementById('metro-chip');
  const button = () => document.getElementById('btn-metro');
  const empty = () => ({ type: 'FeatureCollection', features: [] });

  /* ---------------------------------------------------------------- helpers */

  function asArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
  }

  function normColor(value) {
    const raw = String(value == null ? '' : value).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return '#' + raw.toLowerCase();
    if (/^[0-9a-fA-F]{3}$/.test(raw)) return '#' + raw.split('').map((c) => c + c).join('').toLowerCase();
    return '#7ee0ff';
  }

  /* Brand colours such as the Northern line's black would vanish on the dark globe. */
  function readable(hex) {
    const base = normColor(hex);
    const n = parseInt(base.slice(1), 16);
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum >= 0.18) return base;
    const lift = (v) => Math.min(255, Math.round(v + (255 - v) * 0.6));
    r = lift(r); g = lift(g); b = lift(b);
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  function tidyStopName(name) {
    return String(name || '')
      .replace(/\s*(Underground|DLR|Tram|Overground|Elizabeth line|Rail|Metro)\s+Station\s*$/i, '')
      .replace(/\s+(Station|Stop)\s*$/i, '')
      .replace(/\s+Platform\s+\d+\s*$/i, '')
      .trim();
  }

  function decodePolyline(str) {
    const coords = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    const text = String(str || '');
    while (index < text.length) {
      let shift = 0;
      let result = 0;
      let byte;
      do {
        byte = text.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const dLat = result & 1 ? ~(result >> 1) : result >> 1;
      shift = 0;
      result = 0;
      do {
        byte = text.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const dLng = result & 1 ? ~(result >> 1) : result >> 1;
      lat += dLat;
      lng += dLng;
      coords.push([lng * 1e-5, lat * 1e-5]);
    }
    return coords;
  }

  /* TfL hands back route geometry as JSON text: "[[[lon,lat],[lon,lat]]]" */
  function parseLineStrings(value) {
    const out = [];
    for (const item of asArray(value)) {
      let parsed;
      try { parsed = JSON.parse(item); } catch (e) { continue; }
      for (const line of asArray(parsed)) {
        const coords = asArray(line)
          .map((p) => [Number(p && p[0]), Number(p && p[1])])
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (coords.length > 1) out.push(coords);
      }
    }
    return out;
  }

  function toFeatureCollection(items) {
    return { type: 'FeatureCollection', features: items };
  }

  /* ------------------------------------------------------- OBA (Sound Transit) */

  function parseObaRoutes(payload, feed) {
    const modes = new Set((feed && feed.modes) || [0, 1, 2]);
    return asArray(payload && payload.data && payload.data.list)
      .filter((route) => modes.has(Number(route.type)))
      .map((route) => ({
        id: String(route.id),
        name: String(route.nullSafeShortName || route.shortName || route.longName || route.id),
        description: String(route.description || route.longName || ''),
        color: normColor(route.color),
      }));
  }

  function parseObaStops(payload, feed, route) {
    const entry = payload && payload.data && payload.data.entry;
    const coords = [];
    for (const poly of asArray(entry && entry.polylines)) {
      const line = decodePolyline(poly.points);
      if (line.length > 1) coords.push(line);
    }
    const stops = [];
    const seen = new Set();
    for (const stop of asArray(payload && payload.data && payload.data.references && payload.data.references.stops)) {
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
      const id = String(stop.id);
      if (seen.has(id)) continue;
      seen.add(id);
      stops.push({ id, name: tidyStopName(stop.name), lon: stop.lon, lat: stop.lat });
    }
    return { lines: coords, stations: stops, routeId: route && route.id };
  }

  function parseObaTrips(payload, feed, route) {
    const references = (payload && payload.data && payload.data.references) || {};
    const trips = new Map(asArray(references.trips).map((t) => [String(t.id), t]));
    const stops = new Map(asArray(references.stops).map((s) => [String(s.id), s]));
    const out = [];
    for (const item of asArray(payload && payload.data && payload.data.list)) {
      const status = item && item.status;
      if (!status) continue;
      const pos = status.position || status.lastKnownLocation;
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) continue;
      const trip = trips.get(String(item.tripId));
      const stop = stops.get(String(status.nextStop || status.closestStop));
      const vehicleId = String(status.vehicleId || item.tripId || '');
      out.push({
        key: `${feed.id}:${route.id}:${vehicleId}`,
        feed: feed.id,
        network: feed.network,
        operator: feed.operator,
        city: feed.city,
        kind: 'positions',
        lineId: route.id,
        lineName: route.name,
        color: route.color,
        lon: pos.lon,
        lat: pos.lat,
        heading: Number.isFinite(status.orientation) ? Number(status.orientation) : 0,
        dest: (trip && trip.tripHeadsign) || route.description || '',
        nextStop: stop ? tidyStopName(stop.name) : '',
        etaSec: Number.isFinite(status.nextStopTimeOffset) ? Math.round(status.nextStopTimeOffset) : null,
        delaySec: Number.isFinite(status.scheduleDeviation) ? Math.round(status.scheduleDeviation) : null,
        vehicle: vehicleId,
        observed: Number(status.lastUpdateTime || status.lastLocationUpdateTime) || Date.now(),
        attribution: feed.attribution,
      });
    }
    return out;
  }

  /* --------------------------------------------------------- TfL (London) */

  function parseTflSequence(payload, feed, line) {
    const coords = parseLineStrings(payload && payload.lineStrings);
    const stops = [];
    const seen = new Set();
    for (const sequence of asArray(payload && payload.stopPointSequences)) {
      for (const stop of asArray(sequence && sequence.stopPoint)) {
        if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
        const id = String(stop.id || stop.stationId || stop.name);
        if (seen.has(id)) continue;
        seen.add(id);
        stops.push({ id, name: tidyStopName(stop.name), lon: stop.lon, lat: stop.lat });
      }
    }
    return { lines: coords, stations: stops, lineId: line && line.id };
  }

  function parseTflStatus(payload) {
    const out = new Map();
    for (const line of asArray(payload)) {
      const statuses = asArray(line && line.lineStatuses);
      if (!statuses.length) continue;
      let worst = statuses[0];
      let reason = '';
      for (const status of statuses) {
        const severity = Number(status && status.statusSeverity);
        if (Number.isFinite(severity) && severity < Number(worst && worst.statusSeverity)) worst = status;
        if (!reason && status && status.reason) reason = String(status.reason);
      }
      out.set(String(line.id), {
        severity: Number(worst && worst.statusSeverity),
        status: String((worst && worst.statusSeverityDescription) || ''),
        reason: reason || String((worst && worst.statusSeverityDescription) || ''),
      });
    }
    return out;
  }

  function parseTflArrivals(payload, feed, stopIndex, lineMeta) {
    const stops = stopIndex || new Map();
    const meta = lineMeta || new Map();
    const best = new Map();
    for (const item of asArray(payload)) {
      const stopId = String((item && item.naptanId) || '');
      const stop = stops.get(stopId);
      if (!stop) continue;                       // never place a train at a station we cannot locate
      const lineId = String((item && item.lineId) || '');
      const line = meta.get(lineId);
      const vehicle = String((item && item.vehicleId) || '');
      const eta = Number(item && item.timeToStation);
      const etaSec = Number.isFinite(eta) ? Math.round(eta) : null;
      const key = vehicle ? `v:${vehicle}` : `p:${(item && item.id) || stopId}:${lineId}`;
      const previous = best.get(key);
      if (previous && !(etaSec != null && (previous.etaSec == null || etaSec < previous.etaSec))) continue;
      best.set(key, {
        key: `${feed.id}:${key}`,
        feed: feed.id,
        network: feed.network,
        operator: feed.operator,
        city: feed.city,
        kind: 'arrivals',
        lineId,
        lineName: (line && line.name) || String((item && item.lineName) || lineId),
        color: (line && line.color) || '#7ee0ff',
        lon: stop.lon,
        lat: stop.lat,
        heading: 0,
        dest: tidyStopName(item && item.destinationName),
        nextStop: stop.name,
        etaSec,
        delaySec: null,
        vehicle,
        platform: String((item && item.platformName) || ''),
        where: String((item && item.currentLocation) || ''),
        observed: Date.parse((item && item.timestamp) || '') || Date.now(),
        attribution: feed.attribution,
      });
    }
    return [...best.values()];
  }

  /* --------------------------------------------------------- BART (Bay Area) */

  function parseBartStations(payload) {
    const out = [];
    for (const station of asArray(payload && payload.root && payload.root.stations && payload.root.stations.station)) {
      const lat = Number(station && station.gtfs_latitude);
      const lon = Number(station && station.gtfs_longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push({ abbr: String(station.abbr || station.name), name: String(station.name || station.abbr), lon, lat });
    }
    return out;
  }

  function parseBartRoutes(payload) {
    return asArray(payload && payload.root && payload.root.routes && payload.root.routes.route)
      .map((route) => ({
        number: String(route.number != null ? route.number : route.routeID || ''),
        abbr: String(route.abbr || ''),
        name: String(route.name || ''),
        colorName: String(route.color || '').toUpperCase(),
        color: normColor(route.hexcolor),
      }))
      .filter((route) => route.number);
  }

  function parseBartRouteInfo(payload, feed, route, stopIndex) {
    const abbrevs = asArray(payload && payload.root && payload.root.routes && payload.root.routes.route
      && payload.root.routes.route.config && payload.root.routes.route.config.station);
    const coords = [];
    for (const abbr of abbrevs) {
      const station = stopIndex.get(String(abbr));
      if (station) coords.push([station.lon, station.lat]);
    }
    return coords.length > 1 ? coords : null;
  }

  function parseBartEtd(payload, feed, stopIndex, routeIndex, maxMinutes) {
    const now = Date.now();
    const stations = stopIndex || new Map();
    const routes = routeIndex || new Map();
    const out = [];
    for (const station of asArray(payload && payload.root && payload.root.station)) {
      const here = stations.get(String(station && station.abbr));
      if (!here) continue;
      for (const etd of asArray(station && station.etd)) {
        const destination = String((etd && (etd.destination || etd.abbreviation)) || '');
        for (const estimate of asArray(etd && etd.estimate)) {
          const raw = estimate && estimate.minutes;
          const minutes = String(raw).toLowerCase() === 'leaving' ? 0 : Number(raw);
          if (!Number.isFinite(minutes)) continue;
          if (Number.isFinite(maxMinutes) && minutes > maxMinutes) continue;
          const route = routes.get(String((estimate && estimate.color) || '').toUpperCase());
          const delay = Number(estimate && estimate.delay);
          out.push({
            key: `${feed.id}:${here.abbr}:${etd && etd.abbreviation}:${estimate && estimate.platform}:${minutes}`,
            feed: feed.id,
            network: feed.network,
            operator: feed.operator,
            city: feed.city,
            kind: 'arrivals',
            lineId: (route && route.number) || String((estimate && estimate.color) || ''),
            lineName: route ? route.name : String((estimate && estimate.color) || 'BART'),
            color: normColor(estimate && estimate.hexcolor),
            lon: here.lon,
            lat: here.lat,
            heading: 0,
            dest: destination,
            nextStop: here.name,
            etaSec: Math.round(minutes * 60),
            delaySec: Number.isFinite(delay) && delay > 0 ? delay : null,
            vehicle: '',
            platform: estimate && estimate.platform ? `Platform ${estimate.platform}` : '',
            where: '',
            observed: now,
            attribution: feed.attribution,
          });
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- networking */

  async function getJson(url, direct) {
    if (direct) {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (response.ok) return await response.json();
      } catch (e) { /* fall through to the same relay the camera feeds use */ }
    }
    const relay = await fetch('/api/fetch?url=' + encodeURIComponent(url), { cache: 'no-store' });
    if (!relay.ok) throw new Error('unavailable');
    return await relay.json();
  }

  async function loadRegistry() {
    if (registry.length) return registry;
    const response = await fetch('data/metro.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('registry unavailable');
    const json = await response.json();
    registry = asArray(json.feeds).map((feed) => Object.assign({ _stops: new Map(), _routes: [], _status: null }, feed));
    return registry;
  }

  /* --------------------------------------------------- static line geometry */

  async function loadStatic(feed) {
    if (staticDone.has(feed.id)) return;
    staticDone.add(feed.id);
    try {
      if (feed.adapter === 'oba') await obaStatic(feed);
      else if (feed.adapter === 'tfl') await tflStatic(feed);
      else if (feed.adapter === 'bart') await bartStatic(feed);
    } catch (e) {
      staticDone.delete(feed.id);   // let the next tick retry instead of leaving the network half-drawn
      throw e;
    }
  }

  async function obaStatic(feed) {
    const routes = [];
    for (const agency of feed.agencies || []) {
      const data = await getJson(
        `${feed.base}/routes-for-agency/${encodeURIComponent(agency)}.json?key=${encodeURIComponent(feed.key)}`, feed.cors);
      for (const route of parseObaRoutes(data, feed)) routes.push(route);
    }
    feed._routes = routes;
    for (const route of routes) {
      let parsed = null;
      try {
        const data = await getJson(
          `${feed.base}/stops-for-route/${encodeURIComponent(route.id)}.json?key=${encodeURIComponent(feed.key)}`, feed.cors);
        parsed = parseObaStops(data, feed, route);
      } catch (e) { parsed = null; }
      const coords = (parsed && parsed.lines) || [];
      if (coords.length) lines.push({ feed: feed.id, id: route.id, name: route.name, color: readable(route.color), coords });
      for (const stop of (parsed && parsed.stations) || []) {
        feed._stops.set(stop.id, stop);
        pushStation(feed, stop, route.id, route.name, readable(route.color));
      }
    }
  }

  async function tflStatic(feed) {
    const meta = new Map((feed.lines || []).map((line) => [line.id, { name: line.name, color: readable(line.color) }]));
    try {
      const status = await getJson(
        `${feed.base}/Line/Mode/${encodeURIComponent((feed.modes || []).join(','))}/Status`, feed.cors);
      feed._status = parseTflStatus(status);
    } catch (e) { feed._status = null; }
    const queue = (feed.lines || []).slice();
    const worker = async () => {
      while (queue.length) {
        const line = queue.shift();
        if (!line) return;
        const colour = readable(line.color);
        try {
          const data = await getJson(
            `${feed.base}/Line/${encodeURIComponent(line.id)}/Route/Sequence/inbound`, feed.cors);
          const parsed = parseTflSequence(data, feed, line);
          const coords = parsed.lines.length ? parsed.lines
            : [parsed.stations.map((stop) => [stop.lon, stop.lat])];
          if (coords.length) lines.push({ feed: feed.id, id: line.id, name: line.name, color: colour, coords });
          for (const stop of parsed.stations) {
            feed._stops.set(stop.id, stop);
            pushStation(feed, stop, line.id, line.name, colour);
          }
        } catch (e) { /* a line that will not load simply is not drawn */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  async function bartStatic(feed) {
    const stopsPayload = await getJson(
      `${feed.base}/stn.aspx?cmd=stns&key=${encodeURIComponent(feed.key)}&json=y`, feed.cors);
    const stationList = parseBartStations(stopsPayload);
    feed._stops = new Map(stationList.map((station) => [station.abbr, station]));
    const routesPayload = await getJson(
      `${feed.base}/route.aspx?cmd=routes&key=${encodeURIComponent(feed.key)}&json=y`, feed.cors);
    const routes = parseBartRoutes(routesPayload);
    feed._routes = routes;
    feed._routeByColor = new Map(routes.map((route) => [route.colorName, route]));
    for (const route of routes) {
      try {
        const info = await getJson(
          `${feed.base}/route.aspx?cmd=routeinfo&route=${encodeURIComponent(route.number)}&key=${encodeURIComponent(feed.key)}&json=y`,
          feed.cors);
        const coords = parseBartRouteInfo(info, feed, route, feed._stops);
        if (coords) lines.push({ feed: feed.id, id: route.number, name: route.name || `Route ${route.number}`, color: readable(route.color), coords: [coords] });
      } catch (e) { /* skip this route's geometry */ }
    }
    for (const station of stationList) {
      pushStation(feed, { id: station.abbr, name: station.name, lon: station.lon, lat: station.lat },
        '', feed.network, '#7ee0ff');
    }
  }

  function pushStation(feed, stop, lineId, lineName, colour) {
    const existing = stations.find((s) => s.feed === feed.id && s.id === stop.id);
    if (existing) return;
    stations.push({
      feed: feed.id, id: stop.id, name: stop.name, lon: stop.lon, lat: stop.lat,
      lineId, lineName, color: colour, network: feed.network, operator: feed.operator,
    });
  }

  /* ---------------------------------------------------------- live refresh */

  async function refreshFeed(feed) {
    if (feed.adapter === 'oba') {
      const out = [];
      for (const route of feed._routes || []) {
        try {
          const data = await getJson(
            `${feed.base}/trips-for-route/${encodeURIComponent(route.id)}.json?key=${encodeURIComponent(feed.key)}`, feed.cors);
          for (const train of parseObaTrips(data, feed, route)) out.push(train);
        } catch (e) { /* one route failing must not hide the others */ }
      }
      if (!out.length) throw new Error('no rail trips');
      return out;
    }
    if (feed.adapter === 'tfl') {
      const ids = (feed.lines || []).map((line) => line.id).join(',');
      const meta = new Map((feed.lines || []).map((line) => [line.id, { name: line.name, color: readable(line.color) }]));
      const data = await getJson(`${feed.base}/Line/${ids}/Arrivals`, feed.cors);
      return parseTflArrivals(data, feed, feed._stops, meta);
    }
    if (feed.adapter === 'bart') {
      const data = await getJson(
        `${feed.base}/etd.aspx?cmd=etd&orig=ALL&key=${encodeURIComponent(feed.key)}&json=y`, feed.cors);
      return parseBartEtd(data, feed, feed._stops, feed._routeByColor, feed.maxMinutes);
    }
    return [];
  }

  async function refresh() {
    if (!enabled) return;
    const id = ++requestId;
    status('◇ METRO CONNECTING…');
    await loadRegistry().catch(() => []);
    const results = await Promise.all(registry.map(async (feed) => {
      try {
        await loadStatic(feed);
        const items = await refreshFeed(feed);
        feed._error = null;
        return { feed, items };
      } catch (e) {
        feed._error = String((e && e.message) || e || 'unavailable');
        return { feed, items: [] };
      }
    }));
    if (!enabled || id !== requestId) return;
    trains = results.reduce((all, result) => all.concat(result.items), []);
    const stamp = Date.now();
    for (const train of trains) {
      const trail = (history.get(train.key) || []).filter((point) => stamp - point[2] < HISTORY_MS);
      const last = trail[trail.length - 1];
      if (!last || last[0] !== train.lon || last[1] !== train.lat) trail.push([train.lon, train.lat, stamp]);
      history.set(train.key, trail);
    }
    for (const key of [...history.keys()]) {
      if (!trains.some((train) => train.key === key)) history.delete(key);
    }
    render();
  }

  /* ------------------------------------------------------------- rendering */

  function trainIcon(colour) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.translate(20, 20);
    ctx.shadowColor = colour;
    ctx.shadowBlur = 7;
    ctx.fillStyle = '#04121a';
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(7, -3);
    ctx.lineTo(7, 9);
    ctx.lineTo(3, 15);
    ctx.lineTo(-3, 15);
    ctx.lineTo(-7, 9);
    ctx.lineTo(-7, -3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = colour;
    ctx.fillRect(-4, -6, 8, 5);
    ctx.fillRect(-4, 1, 8, 5);
    return ctx.getImageData(0, 0, 40, 40);
  }

  function iconId(colour) {
    return 'ge-metro-' + normColor(colour).slice(1);
  }

  /* Sprites live on the style, so they must be re-added after every style change. */
  function ensureIcon(colour) {
    const hex = normColor(colour);
    const id = iconId(hex);
    if (map && !map.hasImage(id)) map.addImage(id, trainIcon(hex), { pixelRatio: 2 });
    return id;
  }

  function lineFeatures() {
    const features = [];
    for (const line of lines) {
      for (const coords of line.coords || []) {
        if (coords.length < 2) continue;
        features.push({
          type: 'Feature',
          properties: { feed: line.feed, id: line.id, name: line.name, color: line.color },
          geometry: { type: 'LineString', coordinates: coords },
        });
      }
    }
    return features;
  }

  function stationFeatures() {
    return stations.map((station) => ({
      type: 'Feature',
      properties: {
        feed: station.feed, id: station.id, name: station.name,
        lineName: station.lineName, network: station.network, operator: station.operator,
      },
      geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
    }));
  }

  function trainFeatures() {
    return trains.map((train) => ({
      type: 'Feature',
      properties: {
        key: train.key, feed: train.feed, line: train.lineName, color: train.color,
        icon: iconId(train.color),
        heading: Number.isFinite(train.heading) ? train.heading : 0, dest: train.dest,
      },
      geometry: { type: 'Point', coordinates: [train.lon, train.lat] },
    }));
  }

  function trailFeatures() {
    const trail = selected ? history.get(selected) || [] : [];
    if (trail.length < 2) return [];
    return [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: trail.map((point) => [point[0], point[1]]) },
    }];
  }

  function paint() {
    if (!map) return;
    for (const train of trains) ensureIcon(train.color);
    map.getSource('metro-lines')?.setData(toFeatureCollection(lineFeatures()));
    map.getSource('metro-stations')?.setData(toFeatureCollection(stationFeatures()));
    map.getSource('metro-trains')?.setData(toFeatureCollection(trainFeatures()));
    map.getSource('metro-trail')?.setData(toFeatureCollection(trailFeatures()));
  }

  function status(text) {
    const node = chip();
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('hidden', !enabled);
  }

  function render() {
    restore();
    const ok = registry.filter((feed) => !feed._error && trains.some((train) => train.feed === feed.id));
    const parts = ok.map((feed) => {
      const count = trains.filter((train) => train.feed === feed.id).length;
      return `${feed.city} ${count}`;
    });
    const lineCount = new Set(lines.map((line) => line.id)).size;
    if (!trains.length) {
      status('◇ METRO FEEDS UNAVAILABLE');
      if (chip()) {
        chip().title = registry.map((feed) => `${feed.city}: ${feed._error || 'no trains reported'}`).join(' · ')
          || 'No metro feed responded.';
      }
      return;
    }
    status(`◇ ${trains.length} TRAINS · ${parts.join(' · ')}`);
    if (chip()) {
      chip().title = `${trains.length} live trains across ${ok.length}/${registry.length} networks · ${lineCount} lines\n`
        + registry.map((feed) => `${feed.city} — ${feed.attribution}`).join('\n')
        + '\nNetworks marked arrivals show the station a train is next due at, not a GPS position.';
    }
  }

  function restore() {
    if (!enabled || !map) return;
    for (const source of ['metro-lines', 'metro-stations', 'metro-trains', 'metro-trail']) {
      if (!map.getSource(source)) map.addSource(source, { type: 'geojson', data: empty() });
    }
    if (!map.getLayer('metro-line-casing')) map.addLayer({
      id: 'metro-line-casing', type: 'line', source: 'metro-lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#04121a', 'line-width': 5.5, 'line-opacity': 0.75 },
    });
    if (!map.getLayer('metro-lines')) map.addLayer({
      id: 'metro-lines', type: 'line', source: 'metro-lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.4, 'line-opacity': 0.95 },
    });
    if (!map.getLayer('metro-trail')) map.addLayer({
      id: 'metro-trail', type: 'line', source: 'metro-trail',
      paint: { 'line-color': '#9afbe9', 'line-width': 2, 'line-opacity': 0.8, 'line-dasharray': [2, 2] },
    });
    if (!map.getLayer('metro-stations')) map.addLayer({
      id: 'metro-stations', type: 'circle', source: 'metro-stations', minzoom: 10.5,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10.5, 1.6, 14, 3.4],
        'circle-color': '#0a1f2a', 'circle-stroke-color': '#8fe9ff', 'circle-stroke-width': 1.1,
      },
    });
    if (!map.getLayer('metro-station-labels')) map.addLayer({
      id: 'metro-station-labels', type: 'symbol', source: 'metro-stations', minzoom: 13,
      layout: {
        'text-field': ['get', 'name'], 'text-size': 10, 'text-offset': [0, 1.1],
        'text-allow-overlap': false, 'text-font': ['Open Sans Regular'],
      },
      paint: { 'text-color': '#bfe9f7', 'text-halo-color': '#04121a', 'text-halo-width': 1.8 },
    });
    if (!map.getLayer('metro-trains')) map.addLayer({
      id: 'metro-trains', type: 'symbol', source: 'metro-trains',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 11, 0.85, 15, 1.15],
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
      },
    });
    paint();
    bind();
  }

  /* --------------------------------------------------------- interaction */

  function etaText(train) {
    if (train.etaSec == null) return 'no prediction';
    if (train.etaSec <= 20) return 'arriving now';
    if (train.etaSec < 60) return `${train.etaSec}s`;
    return `${Math.round(train.etaSec / 60)} min`;
  }

  function popupFor(train) {
    const box = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${train.lineName} → ${train.dest || '—'}`;
    const detail = document.createElement('div');
    detail.textContent = train.nextStop
      ? `${train.nextStop} · ${etaText(train)}${train.platform ? ` · ${train.platform}` : ''}`
      : etaText(train);
    const meta = document.createElement('div');
    meta.textContent = `${train.operator} · ${train.city} · ${train.vehicle ? `unit ${train.vehicle} · ` : ''}`
      + `updated ${new Date(train.observed).toLocaleTimeString()}`
      + (train.delaySec ? ` · ${train.delaySec > 0 ? '+' : ''}${Math.round(train.delaySec / 60)} min vs schedule` : '');
    box.append(title, detail, meta);
    if (train.where) {
      const where = document.createElement('div');
      where.textContent = train.where;
      box.append(where);
    }
    const note = document.createElement('div');
    note.textContent = train.kind === 'positions'
      ? 'Live GPS position reported by the operator feed.'
      : 'Drawn at the station this train is next due at — this feed publishes arrival predictions, not vehicle coordinates.';
    box.append(note);
    const credit = document.createElement('div');
    credit.textContent = train.attribution;
    box.append(credit);
    return box;
  }

  function stationPopup(station) {
    const box = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = station.name;
    box.append(title);
    const due = trains
      .filter((train) => train.feed === station.feed && train.nextStop === station.name)
      .sort((a, b) => (a.etaSec == null ? 1e9 : a.etaSec) - (b.etaSec == null ? 1e9 : b.etaSec))
      .slice(0, 4);
    if (due.length) {
      for (const train of due) {
        const row = document.createElement('div');
        row.textContent = `${train.lineName} → ${train.dest || '—'} · ${etaText(train)}`;
        box.append(row);
      }
    } else {
      const none = document.createElement('div');
      none.textContent = station.lineName ? station.lineName : 'No trains due in the current sample.';
      box.append(none);
    }
    const credit = document.createElement('div');
    credit.textContent = station.operator || '';
    box.append(credit);
    return box;
  }

  function bind() {
    if (bound || !map) return;
    bound = true;
    map.on('click', 'metro-trains', (event) => {
      const feature = event.features && event.features[0];
      if (!feature) return;
      const train = trains.find((item) => item.key === feature.properties.key);
      if (!train) return;
      selected = train.key;
      paint();
      new maplibregl.Popup({ maxWidth: '320px' })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(popupFor(train))
        .addTo(map);
    });
    map.on('click', 'metro-stations', (event) => {
      const feature = event.features && event.features[0];
      if (!feature) return;
      const station = stations.find((item) => item.feed === feature.properties.feed && item.id === feature.properties.id);
      if (!station) return;
      new maplibregl.Popup({ maxWidth: '300px' })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(stationPopup(station))
        .addTo(map);
    });
    for (const layer of ['metro-trains', 'metro-stations']) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = 'grab'; });
    }
  }

  /* ------------------------------------------------------------- controls */

  async function toggle() {
    enabled = !enabled;
    button()?.classList.toggle('active', enabled);
    button()?.setAttribute('aria-pressed', String(enabled));
    if (enabled) {
      status('◇ METRO CONNECTING…');
      try {
        await loadRegistry();
      } catch (e) {
        enabled = false;
        button()?.classList.remove('active');
        status('◇ METRO REGISTRY UNAVAILABLE');
        return false;
      }
      restore();
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    } else {
      requestId++;
      clearInterval(timer);
      timer = null;
      selected = null;
      trains = [];
      history.clear();
      chip()?.classList.add('hidden');
      Contacts.close();
      for (const layer of ['metro-trains', 'metro-station-labels', 'metro-stations', 'metro-trail', 'metro-lines', 'metro-line-casing']) {
        if (map && map.getLayer(layer)) map.removeLayer(layer);
      }
      for (const source of ['metro-trains', 'metro-stations', 'metro-lines', 'metro-trail']) {
        if (map && map.getSource(source)) map.removeSource(source);
      }
    }
    return enabled;
  }

  function openList() {
    if (!enabled) return;
    const center = map.getCenter();
    const rows = [...trains].sort((a, b) =>
      (Math.abs(a.lon - center.lng) + Math.abs(a.lat - center.lat))
      - (Math.abs(b.lon - center.lng) + Math.abs(b.lat - center.lat)));
    Contacts.open(`${trains.length} TRAINS · LIVE METRO`, rows.map((train) => ({
      label: `${train.lineName} → ${train.dest || '—'}`,
      detail: `${train.city} · ${train.nextStop || 'en route'}${train.nextStop ? ` · ${etaText(train)}` : ''} · ${train.operator}`,
      train,
    })), (row) => {
      const train = row.train;
      selected = train.key;
      paint();
      map.easeTo({ center: [train.lon, train.lat], zoom: Math.max(map.getZoom(), 11), duration: 650, essential: true });
    });
  }

  function init(instance) { map = instance; }

  return {
    init, toggle, restore, refresh, openList,
    decodePolyline, parseLineStrings, readable, normColor, tidyStopName,
    parseObaRoutes, parseObaStops, parseObaTrips,
    parseTflSequence, parseTflStatus, parseTflArrivals,
    parseBartStations, parseBartRoutes, parseBartRouteInfo, parseBartEtd,
    etaText,
  };
})();
