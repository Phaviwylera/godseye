/* TRANSIT — live metro, light rail, tram and bus networks.
 *
 * Every network here is a feed the operator publishes openly for riders. Two kinds
 * of feed are supported and they are labelled differently in the UI:
 *
 *   positions — live vehicle coordinates (OneBusAway, Umo IQ)
 *   arrivals  — live arrival predictions with no vehicle coordinates; the vehicle is
 *               drawn at the stop it is next due at (TfL, BART)
 *
 * Rail line geometry and stations load once per session; only vehicle positions are
 * polled. Nothing is fabricated: a network whose feed fails is reported as
 * unavailable rather than filled in with guesses.
 */
const Transit = (() => {
  let map = null;
  let enabled = false;
  let timer = null;
  let bound = false;
  let requestId = 0;
  let registry = [];
  let vehicles = [];
  let lines = [];
  let stations = [];
  let selected = null;
  let capped = 0;
  const history = new Map();      // vehicle key -> [[lon, lat, ms], ...]
  const staticDone = new Set();   // feeds whose lines + stations are loaded

  const REFRESH_MS = 60000;
  const HISTORY_MS = 30 * 60 * 1000;
  const MAX_FEATURES = 2500;
  const DEFAULT_COLOR = { rail: '#8be9fa', tram: '#41efc2', bus: '#d9b56d' };

  const chip = () => document.getElementById('transit-chip');
  const button = () => document.getElementById('btn-transit');
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

  function modeFor(feed, fallback) {
    return feed && feed.mode ? feed.mode : (fallback || 'bus');
  }

  function colorFor(feed, value) {
    const hex = normColor(value);
    if (hex !== '#7ee0ff') return hex;
    return DEFAULT_COLOR[modeFor(feed)] || DEFAULT_COLOR.bus;
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

  /* ------------------------------------------------------- OBA (Puget Sound) */

  function modeFromRouteType(type) {
    if (type === 3) return 'bus';
    if (type === 0) return 'tram';
    return 'rail';
  }

  function parseObaRoutes(payload, feed) {
    const modes = new Set((feed && feed.modes) || [0, 1, 2]);
    return asArray(payload && payload.data && payload.data.list)
      .filter((route) => modes.has(Number(route.type)))
      .map((route) => ({
        id: String(route.id),
        name: String(route.nullSafeShortName || route.shortName || route.longName || route.id),
        description: String(route.description || route.longName || ''),
        color: normColor(route.color),
        type: Number(route.type),
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

  function obaTrain(item, feed, route, trip, stop, now) {
    const status = item.status || item.tripStatus;
    if (!status) return null;
    const pos = status.position || status.lastKnownLocation || item.location;
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return null;
    const vehicleId = String(status.vehicleId || item.vehicleId || '');
    const observed = Number(status.lastUpdateTime || status.lastLocationUpdateTime) || now;
    return {
      key: `${feed.id}:${route.id}:${vehicleId || item.tripId}`,
      feed: feed.id,
      network: feed.network,
      operator: feed.operator,
      city: feed.city,
      kind: 'positions',
      // A feed's declared mode wins: Sound Transit's Link is GTFS type 0 (light rail) but
      // is a metro train, so it must not be drawn as a tram.
      mode: route.type === 3 ? 'bus' : modeFor(feed, modeFromRouteType(route.type)),
      lineId: route.id,
      lineName: route.name,
      color: readable(route.color),
      lon: pos.lon,
      lat: pos.lat,
      heading: Number.isFinite(status.orientation) ? Number(status.orientation) : 0,
      speed: null,
      dest: (trip && trip.tripHeadsign) || route.description || '',
      nextStop: stop ? tidyStopName(stop.name) : '',
      etaSec: Number.isFinite(status.nextStopTimeOffset) ? Math.round(status.nextStopTimeOffset) : null,
      delaySec: Number.isFinite(status.scheduleDeviation) ? Math.round(status.scheduleDeviation) : null,
      vehicle: vehicleId,
      observed,
      attribution: feed.attribution,
    };
  }

  /* trips-for-route: one call per rail route, used where the network is small. */
  function parseObaTrips(payload, feed, route) {
    const references = (payload && payload.data && payload.data.references) || {};
    const trips = new Map(asArray(references.trips).map((t) => [String(t.id), t]));
    const stops = new Map(asArray(references.stops).map((s) => [String(s.id), s]));
    const out = [];
    const now = Date.now();
    for (const item of asArray(payload && payload.data && payload.data.list)) {
      const trip = trips.get(String(item.tripId));
      const status = item.status || item.tripStatus;
      const stop = stops.get(String((status && (status.nextStop || status.closestStop)) || ''));
      const vehicle = obaTrain(item, feed, route, trip, stop, now);
      if (vehicle) out.push(vehicle);
    }
    return out;
  }

  /* vehicles-for-agency: one call per agency, used for bus fleets. */
  function parseObaVehicles(payload, feed, routes) {
    const references = (payload && payload.data && payload.data.references) || {};
    const trips = new Map(asArray(references.trips).map((t) => [String(t.id), t]));
    const stops = new Map(asArray(references.stops).map((s) => [String(s.id), s]));
    const out = [];
    const now = Date.now();
    for (const item of asArray(payload && payload.data && payload.data.list)) {
      const trip = trips.get(String(item.tripId));
      const routeId = (trip && String(trip.routeId)) || String(item.tripId || '').split('_').slice(0, 2).join('_');
      const route = routes.get(routeId);
      if (!route) continue;                       // not a route this feed tracks
      const status = item.tripStatus || item.status;
      const stop = stops.get(String((status && (status.nextStop || status.closestStop)) || ''));
      const vehicle = obaTrain(item, feed, route, trip, stop, now);
      if (vehicle) out.push(vehicle);
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
    const now = Date.now();
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
        mode: lineId === 'tram' ? 'tram' : modeFor(feed),
        lineId,
        lineName: (line && line.name) || String((item && item.lineName) || lineId),
        color: (line && line.color) || DEFAULT_COLOR[modeFor(feed)],
        lon: stop.lon,
        lat: stop.lat,
        heading: 0,
        speed: null,
        dest: tidyStopName(item && item.destinationName),
        nextStop: stop.name,
        etaSec,
        delaySec: null,
        vehicle,
        platform: String((item && item.platformName) || ''),
        where: String((item && item.currentLocation) || ''),
        observed: Date.parse((item && item.timestamp) || '') || now,
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
            mode: modeFor(feed),
            lineId: (route && route.number) || String((estimate && estimate.color) || ''),
            lineName: route ? route.name : String((estimate && estimate.color) || 'BART'),
            color: normColor(estimate && estimate.hexcolor),
            lon: here.lon,
            lat: here.lat,
            heading: 0,
            speed: null,
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

  /* ------------------------------------------------------- Umo IQ (NextBus) */

  function parseUmoRoutes(payload) {
    const out = new Map();
    for (const route of asArray(payload && payload.route)) {
      const tag = String(route.tag || '');
      if (tag) out.set(tag, String(route.title || tag));
    }
    return out;
  }

  function parseUmoVehicles(payload, feed, routeNames, maxAgeSec) {
    const names = routeNames || new Map();
    const out = [];
    const now = Date.now();
    for (const item of asArray(payload && payload.vehicle)) {
      if (item.lat == null || item.lon == null) continue;     // Number(null) is 0, not NaN
      const lat = Number(item.lat);
      const lon = Number(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const age = Number(item.secsSinceReport);
      if (!Number.isFinite(age)) continue;
      if (Number.isFinite(maxAgeSec) && age > maxAgeSec) continue;      // a bus that stopped reporting is gone
      const routeTag = String(item.routeTag || '');
      const tram = feed.tramPrefix && routeTag.length === 3 && routeTag.startsWith(feed.tramPrefix);
      const mode = tram ? 'tram' : modeFor(feed);
      const speed = Number(item.speedKmHr);
      out.push({
        key: `${feed.id}:${item.id || routeTag}:${lon}:${lat}`,
        feed: feed.id,
        network: feed.network,
        operator: feed.operator,
        city: feed.city,
        kind: 'positions',
        mode,
        lineId: routeTag,
        lineName: names.get(routeTag) || (routeTag ? `Route ${routeTag}` : feed.network),
        color: DEFAULT_COLOR[mode] || DEFAULT_COLOR.bus,
        lon,
        lat,
        heading: Number(item.heading) || 0,
        speed: Number.isFinite(speed) ? Math.round(speed) : null,
        dest: String(item.dirTag || '').replace(/^[^_]*_[^_]*_/, '') || '',
        nextStop: '',
        etaSec: null,
        delaySec: null,
        vehicle: String(item.id || ''),
        observed: now - age * 1000,
        attribution: feed.attribution,
      });
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
    const response = await fetch('data/transit.json', { cache: 'no-store' });
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
      else if (feed.adapter === 'umo') await umoStatic(feed);
    } catch (e) {
      staticDone.delete(feed.id);   // let the next tick retry instead of leaving the network half-drawn
      throw e;
    }
  }

  async function obaRoutes(feed) {
    if (feed._routes && feed._routes.length) return feed._routes;
    const routes = [];
    for (const agency of feed.agencies || []) {
      const data = await getJson(
        `${feed.base}/routes-for-agency/${encodeURIComponent(agency)}.json?key=${encodeURIComponent(feed.key)}`, feed.cors);
      for (const route of parseObaRoutes(data, feed)) routes.push(route);
    }
    feed._routes = routes;
    feed._routeIndex = new Map(routes.map((route) => [route.id, route]));
    return routes;
  }

  async function obaStatic(feed) {
    await obaRoutes(feed);
    if (feed.strategy === 'agency') return;        // bus fleets: no line geometry to draw
    for (const route of feed._routes) {
      let parsed = null;
      try {
        const data = await getJson(
          `${feed.base}/stops-for-route/${encodeURIComponent(route.id)}.json?key=${encodeURIComponent(feed.key)}`, feed.cors);
        parsed = parseObaStops(data, feed, route);
      } catch (e) { parsed = null; }
      const coords = (parsed && parsed.lines) || [];
      if (coords.length) {
        lines.push({ feed: feed.id, id: route.id, name: route.name, color: readable(route.color), coords });
      }
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
        if (coords) {
          lines.push({ feed: feed.id, id: route.number, name: route.name || `Route ${route.number}`,
            color: readable(route.color), coords: [coords] });
        }
      } catch (e) { /* skip this route's geometry */ }
    }
    for (const station of stationList) {
      pushStation(feed, { id: station.abbr, name: station.name, lon: station.lon, lat: station.lat },
        '', feed.network, DEFAULT_COLOR.rail);
    }
  }

  async function umoStatic(feed) {
    try {
      const data = await getJson(`${feed.base}?command=routeList&a=${encodeURIComponent(feed.agency)}`, feed.cors);
      feed._routeNames = parseUmoRoutes(data);
    } catch (e) { feed._routeNames = new Map(); }
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
      const routes = feed._routes || [];
      const out = [];
      if (feed.strategy === 'agency') {
        for (const agency of feed.agencies || []) {
          try {
            const data = await getJson(
              `${feed.base}/vehicles-for-agency/${encodeURIComponent(agency)}.json?key=${encodeURIComponent(feed.key)}`, feed.cors);
            for (const vehicle of parseObaVehicles(data, feed, feed._routeIndex)) out.push(vehicle);
          } catch (e) { /* one agency failing must not hide the others */ }
        }
      } else {
        for (const route of routes) {
          try {
            const data = await getJson(
              `${feed.base}/trips-for-route/${encodeURIComponent(route.id)}.json?key=${encodeURIComponent(feed.key)}`, feed.cors);
            for (const vehicle of parseObaTrips(data, feed, route)) out.push(vehicle);
          } catch (e) { /* one route failing must not hide the others */ }
        }
      }
      if (!out.length) throw new Error('no vehicles reported');
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
    if (feed.adapter === 'umo') {
      const data = await getJson(
        `${feed.base}?command=vehicleLocations&a=${encodeURIComponent(feed.agency)}&t=0`, feed.cors);
      return parseUmoVehicles(data, feed, feed._routeNames, feed.maxAgeSec);
    }
    return [];
  }

  async function refresh() {
    if (!enabled) return;
    const id = ++requestId;
    status('◇ TRANSIT CONNECTING…');
    await loadRegistry().catch(() => []);
    const results = await Promise.all(registry.map(async (feed) => {
      try {
        await loadStatic(feed);
        const items = await refreshFeed(feed);
        feed._error = null;
        feed._count = items.length;
        return { feed, items };
      } catch (e) {
        feed._error = String((e && e.message) || e || 'unavailable');
        feed._count = 0;
        return { feed, items: [] };
      }
    }));
    if (!enabled || id !== requestId) return;
    vehicles = results.reduce((all, result) => all.concat(result.items), []);
    const stamp = Date.now();
    for (const vehicle of vehicles) {
      if (vehicle.kind !== 'positions') continue;
      const trail = (history.get(vehicle.key) || []).filter((point) => stamp - point[2] < HISTORY_MS);
      const last = trail[trail.length - 1];
      if (!last || last[0] !== vehicle.lon || last[1] !== vehicle.lat) trail.push([vehicle.lon, vehicle.lat, stamp]);
      history.set(vehicle.key, trail);
    }
    for (const key of [...history.keys()]) {
      if (!vehicles.some((vehicle) => vehicle.key === key)) history.delete(key);
    }
    render();
  }

  /* ------------------------------------------------------------- rendering */

  function drawRail(colour) {
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

  function drawRoad(colour, tram) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.translate(20, 20);
    ctx.shadowColor = colour;
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#04121a';
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2.2;
    const w = tram ? 6 : 7;
    const h = tram ? 15 : 13;
    ctx.beginPath();
    ctx.moveTo(-w, -h + 3);
    ctx.quadraticCurveTo(-w, -h, -w + 3, -h);
    ctx.lineTo(w - 3, -h);
    ctx.quadraticCurveTo(w, -h, w, -h + 3);
    ctx.lineTo(w, h - 2);
    ctx.quadraticCurveTo(w, h, w - 3, h);
    ctx.lineTo(-w + 3, h);
    ctx.quadraticCurveTo(-w, h, -w, h - 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = colour;
    ctx.fillRect(-w + 2.5, -h + 4, (w - 2.5) * 2, 4);
    ctx.fillRect(-w + 2.5, 1, (w - 2.5) * 2, 3.5);
    if (tram) {                       // a tram carries a pole; a bus does not
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(3, -h - 5);
      ctx.stroke();
    }
    return ctx.getImageData(0, 0, 40, 40);
  }

  function iconId(mode, colour) {
    return 'ge-transit-' + mode + '-' + normColor(colour).slice(1);
  }

  /* Sprites live on the style, so they must be re-added after every style change. */
  function ensureIcon(mode, colour) {
    const hex = normColor(colour);
    const id = iconId(mode, hex);
    if (map && !map.hasImage(id)) {
      map.addImage(id, mode === 'rail' ? drawRail(hex) : drawRoad(hex, mode === 'tram'), { pixelRatio: 2 });
    }
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

  /* Keep the map honest but responsive: past the cap, draw the vehicles nearest the view. */
  function drawnVehicles() {
    if (vehicles.length <= MAX_FEATURES) {
      capped = 0;
      return vehicles;
    }
    const center = map ? map.getCenter() : { lng: 0, lat: 0 };
    capped = vehicles.length;
    return [...vehicles].sort((a, b) =>
      (Math.abs(a.lon - center.lng) + Math.abs(a.lat - center.lat))
      - (Math.abs(b.lon - center.lng) + Math.abs(b.lat - center.lat))).slice(0, MAX_FEATURES);
  }

  function vehicleFeatures() {
    const now = Date.now();
    return drawnVehicles().map((vehicle) => ({
      type: 'Feature',
      properties: {
        key: vehicle.key, feed: vehicle.feed, line: vehicle.lineName, color: vehicle.color,
        mode: vehicle.mode, icon: iconId(vehicle.mode, vehicle.color),
        heading: Number.isFinite(vehicle.heading) ? vehicle.heading : 0,
        age: Math.max(0, Math.round((now - vehicle.observed) / 1000)),
        dest: vehicle.dest,
      },
      geometry: { type: 'Point', coordinates: [vehicle.lon, vehicle.lat] },
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
    for (const vehicle of drawnVehicles()) ensureIcon(vehicle.mode, vehicle.color);
    map.getSource('transit-lines')?.setData({ type: 'FeatureCollection', features: lineFeatures() });
    map.getSource('transit-stations')?.setData({ type: 'FeatureCollection', features: stationFeatures() });
    map.getSource('transit-vehicles')?.setData({ type: 'FeatureCollection', features: vehicleFeatures() });
    map.getSource('transit-trail')?.setData({ type: 'FeatureCollection', features: trailFeatures() });
  }

  function status(text) {
    const node = chip();
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('hidden', !enabled);
  }

  function countBy(predicate) {
    return vehicles.filter(predicate).length;
  }

  function render() {
    restore();
    const ok = registry.filter((feed) => !feed._error && (feed._count || 0) > 0);
    const lineCount = new Set(lines.map((line) => line.id)).size;
    if (!vehicles.length) {
      status('◇ TRANSIT FEEDS UNAVAILABLE');
      if (chip()) {
        chip().title = registry.map((feed) => `${feed.city}: ${feed._error || 'no vehicles reported'}`).join(' · ')
          || 'No transit feed responded.';
      }
      return;
    }
    const trains = countBy((v) => v.mode !== 'bus');
    const buses = countBy((v) => v.mode === 'bus');
    status(`◇ ${vehicles.length} VEHICLES · ${ok.length}/${registry.length} NETWORKS`);
    if (!chip()) return;
    const rows = registry.map((feed) => {
      const count = feed._count || 0;
      const detail = feed._error ? `unavailable (${feed._error})` : `${count} live`;
      return `${feed.city} — ${feed.network}: ${detail}`;
    });
    const notes = [];
    if (capped) notes.push(`Drawing the ${MAX_FEATURES} vehicles nearest the view of ${capped} reported.`);
    const tfl = registry.find((feed) => feed.adapter === 'tfl' && feed._status);
    if (tfl) {
      const bad = [...tfl._status.entries()]
        .filter(([, value]) => Number.isFinite(value.severity) && value.severity < 10)
        .map(([id, value]) => `${id}: ${value.status}`)
        .slice(0, 4);
      if (bad.length) notes.push(`TfL service: ${bad.join(' · ')}`);
    }
    notes.push(`${trains} rail/tram · ${buses} bus · ${lineCount} lines`);
    notes.push('Networks marked arrivals show the stop a vehicle is next due at, not a GPS position.');
    notes.push(...registry.map((feed) => `${feed.city} data: ${feed.attribution}`));
    chip().title = rows.concat(notes).join('\n');
  }

  function restore() {
    if (!enabled || !map) return;
    for (const source of ['transit-lines', 'transit-stations', 'transit-vehicles', 'transit-trail']) {
      if (!map.getSource(source)) map.addSource(source, { type: 'geojson', data: empty() });
    }
    if (!map.getLayer('transit-line-casing')) map.addLayer({
      id: 'transit-line-casing', type: 'line', source: 'transit-lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#04121a', 'line-width': 5.5, 'line-opacity': 0.75 },
    });
    if (!map.getLayer('transit-lines')) map.addLayer({
      id: 'transit-lines', type: 'line', source: 'transit-lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.4, 'line-opacity': 0.95 },
    });
    if (!map.getLayer('transit-trail')) map.addLayer({
      id: 'transit-trail', type: 'line', source: 'transit-trail',
      paint: { 'line-color': '#9afbe9', 'line-width': 2, 'line-opacity': 0.8, 'line-dasharray': [2, 2] },
    });
    if (!map.getLayer('transit-stations')) map.addLayer({
      id: 'transit-stations', type: 'circle', source: 'transit-stations', minzoom: 10.5,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10.5, 1.6, 14, 3.4],
        'circle-color': '#0a1f2a', 'circle-stroke-color': '#8fe9ff', 'circle-stroke-width': 1.1,
      },
    });
    if (!map.getLayer('transit-station-labels')) map.addLayer({
      id: 'transit-station-labels', type: 'symbol', source: 'transit-stations', minzoom: 13,
      layout: {
        'text-field': ['get', 'name'], 'text-size': 10, 'text-offset': [0, 1.1],
        'text-allow-overlap': false, 'text-font': ['Open Sans Regular'],
      },
      paint: { 'text-color': '#bfe9f7', 'text-halo-color': '#04121a', 'text-halo-width': 1.8 },
    });
    if (!map.getLayer('transit-vehicles')) map.addLayer({
      id: 'transit-vehicles', type: 'symbol', source: 'transit-vehicles',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.32, 9, 0.6, 12, 0.9, 15, 1.2],
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
      },
      paint: {
        'icon-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 180, 0.75, 600, 0.4],
      },
    });
    paint();
    bind();
  }

  /* --------------------------------------------------------- interaction */

  function etaText(vehicle) {
    if (vehicle.etaSec == null) return '';
    if (vehicle.etaSec <= 20) return 'arriving now';
    if (vehicle.etaSec < 60) return `${vehicle.etaSec}s`;
    return `${Math.round(vehicle.etaSec / 60)} min`;
  }

  function ageText(vehicle) {
    const seconds = Math.max(0, Math.round((Date.now() - vehicle.observed) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 90) return '1 min ago';
    return `${Math.round(seconds / 60)} min ago`;
  }

  function popupFor(vehicle) {
    const box = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${vehicle.lineName}${vehicle.dest ? ` → ${vehicle.dest}` : ''}`;
    const detail = document.createElement('div');
    const bits = [];
    if (vehicle.nextStop) bits.push(vehicle.nextStop);
    const eta = etaText(vehicle);
    if (eta) bits.push(eta);
    if (vehicle.platform) bits.push(vehicle.platform);
    if (vehicle.speed != null) bits.push(`${vehicle.speed} km/h`);
    bits.push(ageText(vehicle));
    detail.textContent = bits.join(' · ');
    const meta = document.createElement('div');
    meta.textContent = `${vehicle.operator} · ${vehicle.city}`
      + (vehicle.vehicle ? ` · unit ${vehicle.vehicle}` : '')
      + (vehicle.delaySec ? ` · ${vehicle.delaySec > 0 ? '+' : ''}${Math.round(vehicle.delaySec / 60)} min vs schedule` : '');
    box.append(title, detail, meta);
    if (vehicle.where) {
      const where = document.createElement('div');
      where.textContent = vehicle.where;
      box.append(where);
    }
    const note = document.createElement('div');
    note.textContent = vehicle.kind === 'positions'
      ? 'Live position reported by the operator feed.'
      : 'Drawn at the stop this vehicle is next due at — this feed publishes arrival predictions, not vehicle coordinates.';
    box.append(note);
    const credit = document.createElement('div');
    credit.textContent = vehicle.attribution;
    box.append(credit);
    return box;
  }

  function stationPopup(station) {
    const box = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = station.name;
    box.append(title);
    const due = vehicles
      .filter((vehicle) => vehicle.feed === station.feed && vehicle.nextStop === station.name)
      .sort((a, b) => (a.etaSec == null ? 1e9 : a.etaSec) - (b.etaSec == null ? 1e9 : b.etaSec))
      .slice(0, 4);
    if (due.length) {
      for (const vehicle of due) {
        const row = document.createElement('div');
        row.textContent = `${vehicle.lineName} → ${vehicle.dest || '—'} · ${etaText(vehicle) || 'due'}`;
        box.append(row);
      }
    } else {
      const none = document.createElement('div');
      none.textContent = station.lineName ? station.lineName : 'Nothing due in the current sample.';
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
    map.on('click', 'transit-vehicles', (event) => {
      const feature = event.features && event.features[0];
      if (!feature) return;
      const vehicle = vehicles.find((item) => item.key === feature.properties.key);
      if (!vehicle) return;
      selected = vehicle.key;
      paint();
      new maplibregl.Popup({ maxWidth: '320px' })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(popupFor(vehicle))
        .addTo(map);
    });
    map.on('click', 'transit-stations', (event) => {
      const feature = event.features && event.features[0];
      if (!feature) return;
      const station = stations.find((item) => item.feed === feature.properties.feed && item.id === feature.properties.id);
      if (!station) return;
      new maplibregl.Popup({ maxWidth: '300px' })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(stationPopup(station))
        .addTo(map);
    });
    for (const layer of ['transit-vehicles', 'transit-stations']) {
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
      status('◇ TRANSIT CONNECTING…');
      try {
        await loadRegistry();
      } catch (e) {
        enabled = false;
        button()?.classList.remove('active');
        status('◇ TRANSIT REGISTRY UNAVAILABLE');
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
      vehicles = [];
      capped = 0;
      history.clear();
      chip()?.classList.add('hidden');
      Contacts.close();
      for (const layer of ['transit-vehicles', 'transit-station-labels', 'transit-stations',
        'transit-trail', 'transit-lines', 'transit-line-casing']) {
        if (map && map.getLayer(layer)) map.removeLayer(layer);
      }
      for (const source of ['transit-vehicles', 'transit-stations', 'transit-lines', 'transit-trail']) {
        if (map && map.getSource(source)) map.removeSource(source);
      }
    }
    return enabled;
  }

  function openList() {
    if (!enabled) return;
    const center = map.getCenter();
    const rows = [...vehicles].sort((a, b) =>
      (Math.abs(a.lon - center.lng) + Math.abs(a.lat - center.lat))
      - (Math.abs(b.lon - center.lng) + Math.abs(b.lat - center.lat)));
    Contacts.open(`${vehicles.length} VEHICLES · LIVE TRANSIT`, rows.map((vehicle) => ({
      label: `${vehicle.lineName}${vehicle.dest ? ` → ${vehicle.dest}` : ''}`,
      detail: `${vehicle.city} · ${vehicle.mode}${vehicle.nextStop ? ` · ${vehicle.nextStop}` : ''}`
        + `${etaText(vehicle) ? ` · ${etaText(vehicle)}` : ''} · ${vehicle.operator}`,
      vehicle,
    })), (row) => {
      const vehicle = row.vehicle;
      selected = vehicle.key;
      paint();
      map.easeTo({ center: [vehicle.lon, vehicle.lat], zoom: Math.max(map.getZoom(), 12), duration: 650, essential: true });
    });
  }

  function init(instance) { map = instance; }

  return {
    init, toggle, restore, refresh, openList,
    decodePolyline, parseLineStrings, readable, normColor, tidyStopName, etaText, ageText,
    parseObaRoutes, parseObaStops, parseObaTrips, parseObaVehicles, modeFromRouteType,
    parseTflSequence, parseTflStatus, parseTflArrivals,
    parseBartStations, parseBartRoutes, parseBartRouteInfo, parseBartEtd,
    parseUmoRoutes, parseUmoVehicles,
  };
})();
