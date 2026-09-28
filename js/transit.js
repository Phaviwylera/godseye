/* TRANSIT — live metro, light rail, tram and bus networks.
 *
 * Every network here is a feed the operator publishes openly for riders. Three kinds
 * of feed are supported and they are labelled differently in the UI:
 *
 *   positions — live vehicle coordinates (OneBusAway, Umo IQ)
 *   arrivals  — live arrival predictions with no vehicle coordinates; the vehicle is
 *               drawn at the stop it is next due at (TfL, BART)
 *   station   — the operator publishes which station a train is at, with no coordinates
 *               at all; the train is drawn at that station (Seoul)
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
  /* Every operator feed this layer knows how to read. A registry entry naming anything else
   * is skipped rather than half-drawn. */
  const ADAPTERS = ['oba', 'tfl', 'bart', 'umo', 'seoul', 'mbta', 'digitraffic', 'gtfsrt', 'opendata-ch', 'irail'];

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

  /* ------------------------------------------------------------ Seoul (Korea) --
   * The Seoul open API reports which station a train is at and nothing else — no GPS,
   * no bearing — so a train is drawn at the coordinate of that station, taken from a
   * static Wikidata extract in data/kr-stations.json. A train at a station the table
   * does not know is skipped rather than placed at a guess.
   */

  const SEOUL_STATUS = { 0: 'arriving at', 1: 'stopped at', 2: 'departed', 3: 'last reported at' };
  let krStations = null;

  /* recptnDt is KST wall clock with no zone marker: read it as +09:00 or every age shown is wrong. */
  function parseKst(value) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/
      .exec(String(value == null ? '' : value).trim());
    if (!parts) return NaN;
    return Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}+09:00`);
  }

  /* "대흥(서강대앞)" — the feed carries an alias in brackets. Try the whole name, then the
   * name without the alias, then the alias: whichever one Wikidata labels the station by. */
  function seoulStationCandidates(name) {
    const raw = String(name == null ? '' : name).trim();
    const alias = /\(([^)]*)\)/.exec(raw);
    const candidates = [raw, raw.replace(/\([^)]*\)/g, '').trim()];
    if (alias) candidates.push(alias[1].trim());
    return candidates.filter(Boolean);
  }

  function seoulLookup(table, name) {
    if (!table) return null;
    for (const candidate of seoulStationCandidates(name)) {
      const key = candidate.replace(/\s+/g, '').replace(/역$/, '');
      const hit = table.get(key);
      if (hit) return { name: candidate, lon: hit[0], lat: hit[1] };
    }
    return null;
  }

  function parseSeoulPositions(payload, feed, table, now, meta) {
    const rows = payload && Array.isArray(payload.realtimePositionList) ? payload.realtimePositionList : null;
    if (!rows) {
      const info = (payload && payload.errorMessage) || payload || {};
      const code = String(info.code || '').trim();
      // INFO-200 means "nothing on this line right now"; anything else is the feed failing.
      if (code && code !== 'INFO-000' && code !== 'INFO-200') {
        throw new Error(code === 'INFO-300' || code === 'ERROR-337' ? 'daily request limit reached' : `feed returned ${code}`);
      }
      return [];
    }
    const maxAge = Number.isFinite(feed.maxAgeSec) ? feed.maxAgeSec : 900;
    const index = meta || new Map();
    const out = [];
    for (const row of rows) {
      const here = seoulLookup(table, row.statnNm);
      if (!here) continue;                            // no coordinate for this station, so no marker
      const observed = parseKst(row.recptnDt);
      if (!Number.isFinite(observed)) continue;
      const age = (now - observed) / 1000;
      if (age < -120 || age > maxAge) continue;       // future-dated is clock skew, not a live train
      const line = index.get(String(row.subwayId || '')) || index.get(String(row.subwayNm || '')) || null;
      out.push({
        key: `${feed.id}:${row.subwayNm || ''}:${row.trainNo || ''}`,
        feed: feed.id,
        network: feed.network,
        operator: feed.operator,
        city: feed.city,
        kind: 'station',
        mode: 'rail',
        lineId: String(row.subwayId || row.subwayNm || ''),
        lineName: (line && line.name) || String(row.subwayNm || '').trim() || feed.network,
        color: readable((line && line.color) || DEFAULT_COLOR.rail),
        lon: here.lon,
        lat: here.lat,
        heading: 0,                                   // the feed publishes no bearing; do not invent one
        speed: null,
        dest: String(row.statnTnm || '').replace(/\([^)]*\)/g, '').trim(),
        nextStop: '',
        atStation: here.name,
        etaSec: null,
        delaySec: null,
        vehicle: String(row.trainNo || ''),
        express: String(row.directAt) === '1',
        lastTrain: String(row.lstcarAt) === '1',
        where: `${SEOUL_STATUS[String(row.trainSttus)] || 'reported at'} ${here.name}`,
        observed,
        attribution: feed.attribution,
      });
    }
    return out;
  }

  async function loadKrStations(feed) {
    if (krStations) return krStations;
    const url = (feed && feed.stations) || 'data/kr-stations.json';
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('station table unavailable');
    const payload = await response.json();
    const raw = (payload && payload.stations) || {};
    const table = new Map();
    for (const key of Object.keys(raw)) {
      const point = raw[key];
      if (!Array.isArray(point) || point.length < 2) continue;
      const lon = Number(point[0]);
      const lat = Number(point[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
      const name = String(key).replace(/\s+/g, '');
      if (name && !table.has(name)) table.set(name, [lon, lat]);
    }
    if (!table.size) throw new Error('station table empty');
    krStations = table;
    return table;
  }

  async function seoulStatic(feed) {
    const table = await loadKrStations(feed);
    if (feed._stationsDone) return;
    feed._stationsDone = true;
    for (const entry of table) {
      pushStation(feed, { id: `kr:${entry[0]}`, name: entry[0], lon: entry[1][0], lat: entry[1][1] },
        '', feed.network, DEFAULT_COLOR.rail);
    }
  }

  /* --------------------------------------------------- budgeted polling ------
   * Every quota-limited feed in this layer shares one discipline, because they all spend
   * somebody's key: a target (a line, a station, an endpoint) is re-read at most once per
   * budgetSec, sweeps run on the app's own tick and cost nothing when nothing is due, a
   * failed target is retried at pollSec and then with a doubling gap capped at budgetSec, and
   * a failed poll holds the last good rows instead of emptying the map.
   *
   * Three numbers in data/transit.json are therefore one contract, asserted in tests:
   *   pollSec   how often the feed is swept
   *   budgetSec how often a single target may be re-read upstream
   *   maxAgeSec how long a report stays on the map before it is refused as stale
   * with maxAgeSec >= budgetSec + pollSec and targets × 86400 / budgetSec <= dailyBudget.
   */
  function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // Number(null) and Number('') are zero, which would put a malformed station on
  // the Gulf of Guinea. Coordinates must be explicitly present before coercion.
  function coordinate(value) {
    if (value == null || (typeof value === 'string' && !value.trim())) return NaN;
    return Number(value);
  }

  async function budgetedSweep(feed, targets, read, defaults) {
    const list = (targets || []).map((target) => String(target));
    if (!list.length) throw new Error('no targets configured');
    const pollSec = Math.max(1, finite(feed.pollSec, defaults.pollSec));
    const budgetSec = Math.max(pollSec, finite(feed.budgetSec, defaults.budgetSec));
    const maxAgeSec = finite(feed.maxAgeSec, defaults.maxAgeSec);
    if (!feed._byTarget) feed._byTarget = new Map();
    if (!feed._poll) feed._poll = new Map();             // target -> { at, fails }
    const now = Date.now();

    const due = (target) => {
      const state = feed._poll.get(target);
      if (!state) return true;
      /* A dead target is not hammered: the gap doubles per consecutive failure (pollSec, 2×,
       * 4×) up to budgetSec, so a dead key costs no more than a live one, while a transient
       * blip is retried on the very next sweep. */
      const gap = state.fails ? Math.min(budgetSec, pollSec * 2 ** Math.min(state.fails - 1, 2)) : budgetSec;
      return now - state.at >= gap * 1000;
    };
    /* The first sweep reads every target so the network appears at once; after that only the
     * targets whose budget has elapsed are read. */
    const queue = feed._byTarget.size ? list.filter(due) : list.slice();

    let attempted = 0;
    let answered = 0;
    let failure = '';
    if (queue.length) {
      await Promise.all(queue.map(async (target) => {
        attempted++;
        try {
          const rows = asArray(await read(target, now));
          feed._byTarget.set(target, { rows, at: now });
          feed._poll.set(target, { at: now, fails: 0 });
          answered++;
        } catch (e) {
          const state = feed._poll.get(target) || { at: 0, fails: 0 };
          feed._poll.set(target, { at: now, fails: state.fails + 1 });
          failure = String((e && e.message) || e || 'unavailable');
        }
      }));
    }

    const maxAge = maxAgeSec * 1000;
    const out = [];
    for (const bucket of feed._byTarget.values()) {
      for (const row of bucket.rows) {
        if (now - (Number.isFinite(row.observed) ? row.observed : bucket.at) <= maxAge) out.push(row);
      }
    }
    /* No target answered this sweep: that is a failure, never a silent success assembled out of
     * leftover rows — a dead key must not be able to advertise a fleet it has not reported. */
    if (attempted && !answered) {
      feed._held = { reason: failure || 'unavailable', since: (feed._held && feed._held.since) || now };
    } else if (answered) {
      feed._held = null;
      feed._lastOk = now;
    }
    if (!out.length) {
      throw new Error(failure || (attempted ? 'nothing reported right now' : 'no live report'));
    }
    return out;
  }

  /* The portal caps this API at 1,000 requests a day on a key every visitor shares. */
  const SEOUL_DEFAULTS = { pollSec: 600, budgetSec: 1500, maxAgeSec: 2400 };

  function parseSeoulBatch(payload, feed, table, now, meta) {
    const replies = payload && payload.lines;
    if (!replies || typeof replies !== 'object') throw new Error('batch unavailable');
    const rows = [];
    const failures = [];
    for (const line of asArray(feed.lines)) {
      const reply = replies[String(line.id)];
      if (!reply) { failures.push('batch omitted a line'); continue; }
      if (reply.error) { failures.push(String(reply.error)); continue; }
      try {
        rows.push(...parseSeoulPositions(reply.data, feed, table, now, meta));
      } catch (e) {
        failures.push(String((e && e.message) || e || 'unavailable'));
      }
    }
    // INFO-200 is a successful "nothing running" response, so only an actual
    // error makes a wholly empty batch fail and retain previous rows.
    if (!rows.length && failures.length) throw new Error(failures[0]);
    return rows;
  }

  async function refreshSeoul(feed) {
    const table = await loadKrStations(feed);
    const list = asArray(feed.lines);
    const meta = new Map(list.map((line) => [String(line.id), line]));
    /* One browser request fans out inside the bounded relay endpoint.  The endpoint
     * owns the fixed public line list (no caller URL/key), while its per-line Blob
     * cache still enforces Seoul's 1,500-second upstream budget site-wide. */
    return budgetedSweep(feed, ['seoul-batch'],
      (_target, now) => getSeoulBatch().then((data) => parseSeoulBatch(data, feed, table, now, meta)), SEOUL_DEFAULTS);
  }

  /* --------------------------------------------------- MBTA (Boston, USA) ---
   * api-v3.mbta.com needs no key and no signup: one call returns GPS positions for every
   * subway, light-rail and bus vehicle the agency is running, JSON:API shaped, with the route
   * and stop records included alongside.
   */
  const MBTA_DEFAULTS = { pollSec: 60, budgetSec: 60, maxAgeSec: 600 };

  function parseMbtaVehicles(payload, feed, now) {
    const included = new Map();
    for (const item of asArray(payload && payload.included)) {
      if (item && item.type) included.set(`${item.type}:${item.id}`, item);
    }
    const related = (vehicle, kind) => {
      const ref = vehicle && vehicle.relationships && vehicle.relationships[kind];
      const data = ref && ref.data;
      return (data && !Array.isArray(data) && included.get(`${kind}:${data.id}`)) || null;
    };
    const maxAge = finite(feed.maxAgeSec, MBTA_DEFAULTS.maxAgeSec) * 1000;
    const out = [];
    for (const vehicle of asArray(payload && payload.data)) {
      if (!vehicle || vehicle.type !== 'vehicle') continue;
      const attr = vehicle.attributes || {};
      const lat = Number(attr.latitude);
      const lon = Number(attr.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const observed = Date.parse(attr.updated_at || '');
      if (!Number.isFinite(observed) || now - observed > maxAge) continue;  // a vehicle that stopped reporting is gone
      const route = related(vehicle, 'route');
      const routeAttr = (route && route.attributes) || {};
      const stop = related(vehicle, 'stop');
      const stopAttr = (stop && stop.attributes) || {};
      const mode = modeFromRouteType(Number(routeAttr.type));
      out.push({
        key: `mbta:${vehicle.id}`,
        feed: feed.id,
        network: feed.network,
        operator: feed.operator,
        city: feed.city,
        kind: 'positions',
        mode,
        lineId: String(routeAttr.id || (route && route.id) || ''),
        lineName: String(routeAttr.name || routeAttr.long_name || (route && route.id) || feed.network),
        color: readable(routeAttr.color),
        lon,
        lat,
        heading: Number.isFinite(Number(attr.bearing)) ? Number(attr.bearing) : 0,
        speed: Number.isFinite(Number(attr.speed)) ? Math.round(Number(attr.speed) * 1.60934) : null,  // mph -> km/h
        dest: String(routeAttr.direction_names && routeAttr.direction_names[Number(attr.direction_id) || 0] || ''),
        nextStop: String(stopAttr.name || ''),
        etaSec: null,
        delaySec: null,
        vehicle: String(attr.label || vehicle.id || ''),
        where: `reported by MBTA${stopAttr.name ? ` at ${stopAttr.name}` : ''}`,
        observed,
        attribution: feed.attribution,
      });
    }
    return out;
  }

  /* MBTA exposes rail shapes as encoded polylines and stops as JSON:API records.
   * Keep bus geometry out of this one-time request; GPS vehicles still cover every route. */
  function parseMbtaStatic(shapesPayload, stopsPayload, feed) {
    const routes = new Map(asArray(feed.staticRoutes).map((route) => [String(route.id), route]));
    const linesOut = [];
    for (const shape of asArray(shapesPayload && shapesPayload.data)) {
      const attr = (shape && shape.attributes) || {};
      const rel = shape && shape.relationships && shape.relationships.route;
      const routeId = String((rel && rel.data && rel.data.id) || attr.route_id || '');
      const route = routes.get(routeId);
      const coords = decodePolyline(attr.polyline || attr.path || '');
      if (!route || coords.length < 2) continue;
      linesOut.push({ id: routeId, name: route.name || routeId, color: readable(route.color), coords });
    }
    const stationsOut = [];
    const seen = new Set();
    for (const stop of asArray(stopsPayload && stopsPayload.data)) {
      const attr = (stop && stop.attributes) || {};
      const lon = coordinate(attr.longitude), lat = coordinate(attr.latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const id = String(stop.id || `${lon}:${lat}`);
      if (seen.has(id)) continue;
      seen.add(id);
      stationsOut.push({ id, name: String(attr.name || id), lon, lat });
    }
    return { lines: linesOut, stations: stationsOut };
  }

  async function mbtaStatic(feed) {
    const routeIds = asArray(feed.staticRoutes).map((route) => route.id).filter(Boolean);
    if (!routeIds.length) return;
    const filter = routeIds.map(encodeURIComponent).join(',');
    const [shapes, stopsPayload] = await Promise.all([
      getJson(`${feed.base}/shapes?filter[route]=${filter}&page[limit]=1000`, feed.cors, 86400),
      getJson(`${feed.base}/stops?filter[route]=${filter}&page[limit]=1000`, feed.cors, 86400),
    ]);
    const parsed = parseMbtaStatic(shapes, stopsPayload, feed);
    for (const line of parsed.lines) {
      lines.push({ feed: feed.id, id: line.id, name: line.name, color: line.color, coords: [line.coords] });
    }
    for (const station of parsed.stations) {
      pushStation(feed, station, '', feed.network, DEFAULT_COLOR.rail);
    }
  }

  /* ------------------------------------------- Digitraffic rail (Finland) ---
   * rata.digitraffic.fi is the Finnish Transport Agency's open rail API: every train running
   * in the country, keyless, with the timetable rows it has actually passed and the delay
   * against schedule. It publishes station names, not coordinates, so positions come from the
   * agency's station table — the same arrangement as Seoul.
   */
  const DIGITRAFFIC_DEFAULTS = { pollSec: 60, budgetSec: 60, maxAgeSec: 900 };

  function digitrafficStationOf(row, table) {
    const station = row && row.station;
    if (station && typeof station === 'object') {
      const lon = Number(station.longitude);
      const lat = Number(station.latitude);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        return { name: String(station.name || row.stationShortCode || '').trim(), lon, lat };
      }
    }
    for (const code of [row && row.stationShortCode, station && station.stationShortCode, station]) {
      const hit = code && typeof code === 'string' ? table && table.get(code) : null;
      if (hit) return hit;
    }
    return null;
  }

  /* Index the station table under every identifier the feed might join on. */
  function digitrafficStations(payload) {
    const table = new Map();
    const add = (key, value) => {
      const name = String(key == null ? '' : key).trim();
      if (name && !table.has(name)) table.set(name, value);
    };
    for (const station of asArray((payload && payload.stations) || payload)) {
      const lon = Number(station && station.longitude);
      const lat = Number(station && station.latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
      const value = { name: String(station.stationName || station.name || station.stationShortCode || '').trim(), lon, lat };
      add(station.stationShortCode, value);
      add(station.shortCode, value);
      add(station.stationUICCode, value);
      add(station.name, value);
    }
    return table;
  }

  function parseDigitrafficTrains(payload, feed, table, now) {
    const maxAge = finite(feed.maxAgeSec, DIGITRAFFIC_DEFAULTS.maxAgeSec) * 1000;
    const out = [];
    for (const train of asArray(payload)) {
      if (!train || train.cancelled || train.runningCurrently === false) continue;
      const rows = asArray(train.timeTableRows).filter((row) => row && row.trainStopping !== false);
      let here = null;
      for (const row of rows) {
        if (!row.actualTime) continue;                 // the feed says what really happened, not what was planned
        const observed = Date.parse(row.actualTime);
        if (!Number.isFinite(observed)) continue;
        if (here && observed < here.observed) continue;
        const station = digitrafficStationOf(row, table);
        if (!station) continue;
        here = { row, station, observed };
      }
      if (!here || now - here.observed > maxAge) continue;
      const scheduled = Date.parse(here.row.scheduledTime || '');
      const delay = Number.isFinite(scheduled) ? Math.round((here.observed - scheduled) / 1000) : null;
      const index = rows.indexOf(here.row);
      const next = rows.slice(index + 1)
        .find((row) => row.actualTime == null && !row.cancelled
          && String(row.stationShortCode || '') !== String(here.row.stationShortCode || '')) || null;
      const nextStation = next ? digitrafficStationOf(next, table) : null;
      const last = rows.length ? digitrafficStationOf(rows[rows.length - 1], table) : null;
      const lineName = String(train.commuterLineID || train.trainType || train.trainNumber || feed.network);
      out.push({
        key: `fi:${train.trainNumber}:${train.departureDate || ''}`,
        feed: feed.id,
        network: feed.network,
        operator: feed.operator,
        city: feed.city,
        kind: 'station',
        mode: 'rail',
        lineId: String(train.commuterLineID || train.trainType || 'train'),
        lineName,
        color: readable(DEFAULT_COLOR.rail),
        lon: here.station.lon,
        lat: here.station.lat,
        heading: 0,                                     // the feed publishes no bearing; do not invent one
        speed: null,
        dest: last ? last.name : (nextStation ? nextStation.name : ''),   // dest is the terminus, as elsewhere in this layer
        nextStop: nextStation ? nextStation.name : '',
        atStation: here.station.name,
        etaSec: null,
        delaySec: delay,
        vehicle: String(train.trainNumber || ''),
        where: `at ${here.station.name}${delay != null && delay > 60 ? ` · ${Math.round(delay / 60)} min late` : ''}`,
        observed: here.observed,
        attribution: feed.attribution,
      });
    }
    return out;
  }

  async function digitrafficStatic(feed) {
    if (feed._stationsDone) return;
    let table = new Map();
    try {
      // This snapshot is deliberately the sole metadata source: do not make every viewer
      // re-download Digitraffic's large station table when a local file is unavailable.
      const bundled = feed.stations || 'data/fi-stations.json';
      const response = await fetch(bundled, { cache: 'default' });
      if (!response.ok) throw new Error('bundled station table unavailable');
      table = digitrafficStations(await response.json());
    } catch (e) {
      /* Without the table a train is only drawn if the train feed itself carries station
       * coordinates, which digitrafficStationOf accepts: missing static data costs coverage,
       * never an unbounded metadata request or a guessed position. */
      table = new Map();
    }
    feed._stations = table;
    feed._stationsDone = true;
    const drawn = new Set();
    for (const station of table.values()) {
      const id = `fi:${station.lon}:${station.lat}`;
      if (drawn.has(id)) continue;
      drawn.add(id);
      pushStation(feed, { id, name: station.name, lon: station.lon, lat: station.lat },
        '', feed.network, DEFAULT_COLOR.rail);
    }
  }

  /* ----------------------------------------- transport.opendata.ch (Switzerland) --
   * The Swiss open-data transport API is keyless and covers the whole country's rail, tram
   * and bus departures with the live delay. It publishes no vehicle coordinates, so this is
   * an arrivals feed: a marker is a scheduled departure at the station it leaves from.
   */
  const BOARD_DEFAULTS = { pollSec: 60, budgetSec: 300, maxAgeSec: 900 };

  /* One board can list a dozen departures for the same platform: keep the next few so the
   * layer stays readable and the map does not stack identical dots. */
  function keepPerStation(rows, limit) {
    const per = new Map();
    const out = [];
    for (const row of rows) {
      const n = (per.get(row.atStation) || 0) + 1;
      per.set(row.atStation, n);
      if (n <= limit) out.push(row);
    }
    return out;
  }

  function parseOpendataChStationboard(payload, feed, now) {
    const rows = [];
    for (const entry of asArray(payload && payload.stationboard)) {
      const station = entry && entry.station;
      const coord = station && station.coordinate;
      const lon = Number(coord && coord.x);             // opendata.ch: x is longitude, y is latitude
      const lat = Number(coord && coord.y);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const departure = Date.parse(entry.departure || '');
      const delaySec = Math.round(finite(entry.delay, 0) * 60);
      if (Number.isFinite(departure) && departure + delaySec * 1000 < now - 120000) continue;   // already gone
      const name = String((entry.category || '') + (entry.number || '')).trim();
      rows.push({
        key: `ch:${station && station.id}:${name}:${Number.isFinite(departure) ? departure : ''}`,
        feed: feed.id,
        network: feed.network,
        operator: feed.operator,
        city: feed.city,
        kind: 'arrivals',
        mode: feed.mode === 'bus' ? 'bus' : (/^(T|B|BUS)$/i.test(String(entry.category || '')) ? 'tram' : 'rail'),
        lineId: String(entry.category || 'train'),
        lineName: name || feed.network,
        color: readable(DEFAULT_COLOR.rail),
        lon,
        lat,
        heading: 0,
        speed: null,
        dest: String(entry.to || ''),
        nextStop: '',
        atStation: String((station && station.name) || '').trim(),
        etaSec: Number.isFinite(departure) ? Math.max(0, Math.round((departure + delaySec * 1000 - now) / 1000)) : null,
        platform: String(entry.platform || '').trim() ? `platform ${entry.platform}` : '',
        delaySec: delaySec || null,
        vehicle: name,
        where: `due at ${(station && station.name) || 'the station'}`,
        observed: now,                                  // a schedule is not an observation: the board was read now
        attribution: feed.attribution,
      });
    }
    return keepPerStation(rows, finite(feed.perStation, 3));
  }

  /* ------------------------------------------------------- iRail (Belgium) --
   * api.irail.be is the open interface to SNCB/NMBS: keyless live boards with the delay,
   * the platform and the station coordinates.
   */
  function parseIrailLiveboard(payload, feed, now) {
    const info = (payload && payload.stationinfo) || {};
    const boardLon = Number(info.locationX);
    const boardLat = Number(info.locationY);
    const board = String(info.name || payload && payload.station || '').trim();
    const departures = (payload && payload.departures && payload.departures.departure)
      || (payload && payload.arrivals && payload.arrivals.arrival) || [];
    const rows = [];
    for (const entry of asArray(departures)) {
      if (!entry || String(entry.canceled) === '1' || entry.left === '1' || String(entry.left) === '1') continue;
      const lon = Number((entry.stationinfo || {}).locationX ?? boardLon);
      const lat = Number((entry.stationinfo || {}).locationY ?? boardLat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const at = Number(entry.time) * 1000;
      const delaySec = Math.round(finite(entry.delay, 0));
      if (Number.isFinite(at) && at + delaySec * 1000 < now - 120000) continue;
      const vehicle = String(((entry.vehicleinfo || {}).name) || entry.vehicle || '').trim();
      rows.push({
        key: `be:${entry.id || vehicle}:${Number.isFinite(at) ? at : ''}`,
        feed: feed.id,
        network: feed.network,
        operator: feed.operator,
        city: feed.city,
        kind: 'arrivals',
        mode: 'rail',
        lineId: vehicle.split(/\d+/)[0] || 'train',
        lineName: vehicle || feed.network,
        color: readable(DEFAULT_COLOR.rail),
        lon,
        lat,
        heading: 0,
        speed: null,
        dest: String(entry.station || '').trim(),
        nextStop: '',
        atStation: board,
        etaSec: Number.isFinite(at) ? Math.max(0, Math.round((at + delaySec * 1000 - now) / 1000)) : null,
        platform: String((entry.platforminfo || {}).name || entry.platform || '').trim()
          ? `platform ${(entry.platforminfo || {}).name || entry.platform}` : '',
        delaySec: delaySec || null,
        vehicle,
        where: `due at ${board}`,
        observed: now,
        attribution: feed.attribution,
      });
    }
    return keepPerStation(rows, finite(feed.perStation, 3));
  }

  /* ------------------------------------------------ static board geometry --
   * Boards describe departures but not network topology. For Switzerland we use
   * connection journey.passList coordinates; iRail publishes the equivalent vias.
   * These are operator timetable points, never inferred routes. */
  function stationPoint(value) {
    const station = value && (value.station || value.stationinfo || value);
    const coord = station && station.coordinate;
    let lon = coordinate((station && (station.locationX ?? station.longitude)) ?? (coord && coord.x));
    let lat = coordinate((station && (station.locationY ?? station.latitude)) ?? (coord && coord.y));
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    // Some Transport API mirrors label x/y differently; accept only a valid WGS84 pair.
    if (Math.abs(lon) <= 90 && Math.abs(lat) <= 180 && Math.abs(lat) > 90) [lon, lat] = [lat, lon];
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    return { id: String((station && station.id) || (station && station.name) || `${lon}:${lat}`),
      name: String((station && station.name) || '').trim(), lon, lat };
  }

  function distinctStations(points) {
    const out = [], seen = new Set();
    for (const point of points) {
      if (!point || !Number.isFinite(point.lon) || !Number.isFinite(point.lat)) continue;
      const id = point.id || `${point.lon}:${point.lat}`;
      if (seen.has(id)) continue;
      seen.add(id); out.push(point);
    }
    return out;
  }

  function parseOpendataChConnection(payload, pair) {
    const connection = asArray(payload && payload.connections)[0];
    if (!connection) return { coords: [], stations: [] };
    const journey = connection.journey || {};
    const points = [stationPoint(connection.from),
      ...asArray(journey.passList).map((pass) => stationPoint(pass && (pass.station || pass))),
      stationPoint(connection.to)];
    const stationsOut = distinctStations(points);
    return { coords: stationsOut.map((station) => [station.lon, station.lat]), stations: stationsOut,
      id: String((pair && pair.id) || journey.name || 'Swiss rail'),
      name: String((pair && pair.name) || journey.name || 'Swiss rail'),
      color: readable((pair && pair.color) || DEFAULT_COLOR.rail) };
  }

  function parseIrailStations(payload) {
    return distinctStations(asArray((payload && payload.station) || payload)
      .map((station) => stationPoint(station)));
  }

  function parseIrailConnection(payload, pair) {
    const connection = asArray(payload && payload.connection)[0];
    if (!connection) return { coords: [], stations: [] };
    const vias = (connection.vias && connection.vias.via) || [];
    const points = [stationPoint(connection.departure),
      ...asArray(vias).map((via) => stationPoint(via && (via.stationinfo || via.station || via))),
      stationPoint(connection.arrival)];
    const stationsOut = distinctStations(points);
    return { coords: stationsOut.map((station) => [station.lon, station.lat]), stations: stationsOut,
      id: String((pair && pair.id) || (connection.departure && connection.departure.vehicle) || 'Belgian rail'),
      name: String((pair && pair.name) || (connection.departure && connection.departure.vehicle) || 'Belgian rail'),
      color: readable((pair && pair.color) || DEFAULT_COLOR.rail) };
  }

  async function boardStatic(feed) {
    const pairs = asArray(feed.geometry);
    if (feed.adapter === 'irail') {
      try {
        const payload = await getJson(`${feed.base}stations/?format=json&lang=en`, feed.cors, 86400);
        for (const station of parseIrailStations(payload)) {
          pushStation(feed, station, '', feed.network, DEFAULT_COLOR.rail);
        }
      } catch (e) { /* connection vias below can still provide station dots */ }
    }
    await Promise.all(pairs.map(async (pair) => {
      try {
        const url = feed.adapter === 'irail'
          ? `${feed.base}connections/?from=${encodeURIComponent(pair.from)}&to=${encodeURIComponent(pair.to)}&format=json&lang=en`
          : `${feed.base}connections?from=${encodeURIComponent(pair.from)}&to=${encodeURIComponent(pair.to)}&limit=1`;
        const data = await getJson(url, feed.cors, 86400);
        const parsed = feed.adapter === 'irail'
          ? parseIrailConnection(data, pair) : parseOpendataChConnection(data, pair);
        if (parsed.coords.length > 1) {
          lines.push({ feed: feed.id, id: parsed.id, name: parsed.name, color: parsed.color, coords: [parsed.coords] });
        }
        for (const station of parsed.stations) {
          pushStation(feed, station, parsed.id, parsed.name, parsed.color);
        }
      } catch (e) { /* one route request failing never erases a board feed */ }
    }));
  }

  function parseGtfsStatic(payload, feed) {
    const linesOut = asArray(payload && payload.lines).map((line) => ({
      id: String(line && line.id || ''), name: String(line && line.name || ''),
      color: readable(line && line.color || DEFAULT_COLOR[modeFor(feed)]),
      coords: asArray(line && line.coords).filter((point) => Array.isArray(point) &&
        Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))),
    })).filter((line) => line.id && line.coords.length > 1);
    const stationsOut = distinctStations(asArray(payload && payload.stations).map((station) => ({
      id: String(station && station.id || ''), name: String(station && station.name || ''),
      lon: coordinate(station && station.lon), lat: coordinate(station && station.lat),
    })));
    return { lines: linesOut, stations: stationsOut };
  }

  async function gcrtaStatic(feed) {
    const response = await fetch(feed.static || 'data/gcrta-static.json', { cache: 'default' });
    if (!response.ok) throw new Error('GCRTA static table unavailable');
    const parsed = parseGtfsStatic(await response.json(), feed);
    for (const line of parsed.lines) {
      lines.push({ feed: feed.id, id: line.id, name: line.name, color: line.color, coords: [line.coords] });
    }
    for (const station of parsed.stations) pushStation(feed, station, '', feed.network, DEFAULT_COLOR.rail);
  }

  /* -------------------------------------------------- GTFS-Realtime (buses) --
   * GTFS-RT is the format most of the world's bus agencies publish, but it is a protobuf, so
   * this is a small wire-format reader: enough to pull VehiclePosition messages out of a
   * FeedMessage without a schema compiler. Any agency that publishes a keyless
   * VehiclePositions URL can be added to data/transit.json with adapter "gtfsrt".
   */
  const GTFSRT_DEFAULTS = { pollSec: 60, budgetSec: 60, maxAgeSec: 600 };

  function pbVarint(bytes, index) {
    let result = 0;
    let shift = 0;
    let p = index;
    for (;;) {
      if (p >= bytes.length) throw new Error('truncated varint');
      const byte = bytes[p++];
      result += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return [result, p];
      shift += 7;
      if (shift > 63) throw new Error('varint too long');
    }
  }

  function pbFloat32(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, 4);
    return view.getFloat32(0, true);
  }

  function pbDouble(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
    return view.getFloat64(0, true);
  }

  /* Flat field list: protobuf repeats a field by emitting it again, so a repeated field is
   * simply several entries with the same number. */
  function pbFields(bytes) {
    const out = [];
    let i = 0;
    while (i < bytes.length) {
      const [key, afterKey] = pbVarint(bytes, i);
      const field = Math.floor(key / 8);
      const type = key % 8;
      i = afterKey;
      if (type === 0) {
        const [value, next] = pbVarint(bytes, i);
        out.push({ field, type, value });
        i = next;
      } else if (type === 1) {
        if (i + 8 > bytes.length) throw new Error('truncated fixed64');
        out.push({ field, type, value: bytes.subarray(i, i + 8) });
        i += 8;
      } else if (type === 2) {
        const [length, next] = pbVarint(bytes, i);
        if (next + length > bytes.length) throw new Error('truncated length-delimited field');
        out.push({ field, type, value: bytes.subarray(next, next + length) });
        i = next + length;
      } else if (type === 5) {
        if (i + 4 > bytes.length) throw new Error('truncated fixed32');
        out.push({ field, type, value: bytes.subarray(i, i + 4) });
        i += 4;
      } else {
        throw new Error(`unsupported wire type ${type}`);
      }
    }
    return out;
  }

  const PB_DECODER = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  function pbText(bytes) {
    if (PB_DECODER) return PB_DECODER.decode(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
  const pbNum = (fields, n) => {
    for (const f of fields) if (f.field === n) return f.type === 5 ? pbFloat32(f.value) : (f.type === 1 ? pbDouble(f.value) : f.value);
    return null;
  };
  const pbStr = (fields, n) => {
    for (const f of fields) if (f.field === n) return pbText(f.value);
    return null;
  };
  const pbSub = (fields, n) => {
    for (const f of fields) if (f.field === n && f.type === 2) return pbFields(f.value);
    return null;
  };
  const pbAll = (fields, n) => fields.filter((f) => f.field === n && f.type === 2).map((f) => pbFields(f.value));

  function parseGtfsrtFeed(bytes, feed, now) {
    /* Duck-typed on purpose: a Node Buffer, a cross-realm Uint8Array and a plain typed array
       are all valid frames, and `instanceof` says no to two of them. */
    if (!bytes || typeof bytes.length !== 'number' || !bytes.length) throw new Error('empty realtime payload');
    const message = pbFields(bytes);
    const header = pbSub(message, 1);
    const fallback = Number(pbNum(header || [], 3)) * 1000;    // FeedHeader.timestamp, seconds
    const maxAge = finite(feed.maxAgeSec, GTFSRT_DEFAULTS.maxAgeSec) * 1000;
    const out = [];
    for (const entity of pbAll(message, 2)) {
      const position = pbSub(entity, 4);                        // FeedEntity.vehicle
      if (!position) continue;
      const pos = pbSub(position, 3);                           // VehiclePosition.position
      if (!pos) continue;
      const lat = Number(pbNum(pos, 1));
      const lon = Number(pbNum(pos, 2));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const seconds = Number(pbNum(position, 8)) || Number(fallback) / 1000;
      const observed = seconds * 1000;
      if (!Number.isFinite(observed) || now - observed > maxAge) continue;
      const trip = pbSub(position, 1) || [];
      const descriptor = pbSub(position, 2) || [];
      const bearing = Number(pbNum(pos, 3));
      const speed = Number(pbNum(pos, 5));
      const routeId = pbStr(trip, 2) || '';
      out.push({
        key: `gtfsrt:${feed.id}:${pbStr(descriptor, 1) || pbStr(trip, 1) || `${lat},${lon}`}`,
        feed: feed.id,
        network: feed.network,
        operator: feed.operator,
        city: feed.city,
        kind: 'positions',
        mode: feed.mode === 'tram' ? 'tram' : 'bus',
        lineId: routeId,
        lineName: routeId || feed.network,
        color: readable(DEFAULT_COLOR.bus),
        lon,
        lat,
        heading: Number.isFinite(bearing) && bearing >= 0 && bearing < 360 ? bearing : 0,
        speed: Number.isFinite(speed) && speed >= 0 ? Math.round(speed * 3.6) : null,   // m/s -> km/h
        dest: pbStr(trip, 1) || '',
        nextStop: pbStr(position, 11) || '',
        etaSec: null,
        delaySec: null,
        vehicle: pbStr(descriptor, 2) || pbStr(descriptor, 1) || '',
        where: 'Live position from the agency GTFS-Realtime feed.',
        observed,
        attribution: feed.attribution,
      });
    }
    return out;
  }

  async function refreshGtfsrt(feed) {
    const targets = asArray(feed.endpoints && feed.endpoints.length ? feed.endpoints : [feed.base]);
    return budgetedSweep(feed, targets,
      (endpoint, now) => getBinary(endpoint, feed.cors)
        .then((bytes) => parseGtfsrtFeed(bytes, feed, now)), GTFSRT_DEFAULTS);
  }

  async function refreshBoard(feed) {
    const targets = asArray(feed.stations || feed.stops);
    if (!targets.length) throw new Error('no stations configured');
    const read = (target, now) => (feed.adapter === 'irail'
      ? getJson(`${feed.base}liveboard/?station=${encodeURIComponent(target)}&format=json&lang=en`, feed.cors)
        .then((data) => parseIrailLiveboard(data, feed, now))
      : getJson(`${feed.base}stationboard?station=${encodeURIComponent(target)}&limit=${finite(feed.limit, 10)}`, feed.cors)
        .then((data) => parseOpendataChStationboard(data, feed, now)));
    return budgetedSweep(feed, targets, read, BOARD_DEFAULTS);
  }

  /* ------------------------------------------------------------- networking */

  /* `windowSec` asks the relay to answer from its own short-lived cache: that is what turns
   * "every visitor polls the operator" into "every visitor shares one answer per window",
   * which is the only reason a key with a 1,000-request daily cap survives being public. */
  function relayUrl(url, windowSec, binary) {
    let target = '/api/fetch?url=' + encodeURIComponent(url);
    if (Number(windowSec) > 0) target += '&window=' + Math.round(Number(windowSec));
    if (binary) target += '&encoding=base64';
    return target;
  }

  async function getSeoulBatch() {
    const relay = await fetch('/api/transit/seoul', { cache: 'no-store' });
    if (!relay.ok) throw new Error('unavailable');
    return relay.json();
  }

  async function getJson(url, direct, windowSec) {
    if (direct) {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (response.ok) return await response.json();
      } catch (e) { /* fall through to the same relay the camera feeds use */ }
    }
    const relay = await fetch(relayUrl(url, windowSec), { cache: 'no-store' });
    if (!relay.ok) throw new Error('unavailable');
    return await relay.json();
  }

  /* GTFS-Realtime is binary; the relay base64s it so the bytes survive the trip intact. */
  async function getBinary(url, direct) {
    const relay = await fetch(relayUrl(url, 0, true), { cache: 'no-store' });
    if (!relay.ok) throw new Error('unavailable');
    const text = (await relay.text()).trim();
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  async function loadRegistry() {
    if (registry.length) return registry;
    const response = await fetch('data/transit.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('registry unavailable');
    const json = await response.json();
    registry = asArray(json.feeds)
      .filter((feed) => ADAPTERS.includes(feed.adapter))   // an unknown adapter draws nothing but is not a crash
      .map((feed) => Object.assign({ _stops: new Map(), _routes: [], _status: null }, feed));
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
      else if (feed.adapter === 'seoul') await seoulStatic(feed);
      else if (feed.adapter === 'mbta') await mbtaStatic(feed);
      else if (feed.adapter === 'digitraffic') await digitrafficStatic(feed);
      else if (feed.adapter === 'opendata-ch' || feed.adapter === 'irail') await boardStatic(feed);
      else if (feed.adapter === 'gtfsrt' && feed.static) await gcrtaStatic(feed);
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
    if (feed.adapter === 'seoul') return refreshSeoul(feed);
    if (feed.adapter === 'mbta') {
      const url = `${feed.base}/vehicles?page[limit]=${finite(feed.limit, 1000)}&include=route,stop`;
      const data = await getJson(url, feed.cors, finite(feed.windowSec, 30));
      return parseMbtaVehicles(data, feed, Date.now());
    }
    if (feed.adapter === 'digitraffic') {
      const data = await getJson(`${feed.base}trains/latest`, feed.cors, finite(feed.windowSec, 30));
      return parseDigitrafficTrains(data, feed, feed._stations || new Map(), Date.now());
    }
    if (feed.adapter === 'gtfsrt') return refreshGtfsrt(feed);
    if (feed.adapter === 'opendata-ch' || feed.adapter === 'irail') return refreshBoard(feed);
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
      const detail = feed._error
        ? `unavailable (${feed._error})`
        : feed._held
          ? `held (${feed._held.reason}) · ${agoText(feed._lastOk)}`
          : `${count} live${feed.sample ? ' · sample' : ''}`;
      return `${feed.city} — ${feed.network}: ${detail}`;
    });
    const notes = [];
    if (registry.some((feed) => feed._held)) {
      notes.push('A network marked held kept the last sweep its operator accepted: those vehicles are drawn, but they are that old.');
    }
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
    if (registry.some((feed) => feed.kind === 'station')) {
      notes.push('Networks marked station show a train at the station it last reported from, placed with a bundled station list.');
    }
    if (registry.some((feed) => feed.sample)) {
      notes.push('Sampled networks carry only what a rate-limited key returns — a slice of the fleet, not all of it.');
    }
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

  /* How long since a feed last heard from its operator: the honest caption for held rows. */
  function agoText(stamp) {
    if (!Number.isFinite(stamp)) return 'age unknown';
    const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 90) return '1 min ago';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    return `${(seconds / 3600).toFixed(1)} h ago`;
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
      + (vehicle.express ? ' · express' : '')
      + (vehicle.lastTrain ? ' · last train of the night' : '')
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
      : vehicle.kind === 'station'
        ? 'Drawn at the station this train last reported from — the feed publishes station positions, not GPS coordinates.'
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
      .filter((vehicle) => vehicle.feed === station.feed
        && (vehicle.nextStop === station.name || vehicle.atStation === station.name))
      .sort((a, b) => (a.etaSec == null ? 1e9 : a.etaSec) - (b.etaSec == null ? 1e9 : b.etaSec))
      .slice(0, 4);
    if (due.length) {
      for (const vehicle of due) {
        const row = document.createElement('div');
        const when = vehicle.kind === 'station' ? ageText(vehicle) : (etaText(vehicle) || 'due');
        row.textContent = `${vehicle.lineName} → ${vehicle.dest || '—'} · ${when}`;
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
      detail: `${vehicle.city} · ${vehicle.mode}`
        + `${vehicle.nextStop ? ` · ${vehicle.nextStop}` : ''}`
        + `${vehicle.atStation ? ` · at ${vehicle.atStation}` : ''}`
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
    parseKst, parseSeoulPositions, seoulLookup, seoulStationCandidates,
    budgetedSweep, refreshSeoul, parseSeoulBatch, agoText, ADAPTERS, finite,
    parseMbtaVehicles, parseMbtaStatic, parseDigitrafficTrains, digitrafficStations, digitrafficStationOf,
    parseOpendataChStationboard, parseIrailLiveboard, parseOpendataChConnection, parseIrailConnection,
    parseIrailStations, parseGtfsStatic, stationPoint, keepPerStation,
    pbFields, pbVarint, parseGtfsrtFeed,
  };
})();
