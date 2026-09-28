/* The open feeds added for worldwide coverage: Boston MBTA, Finland Digitraffic,
 * transport.opendata.ch, iRail Belgium and a generic GTFS-Realtime reader.
 *
 * Every fixture here is the shape each operator's own documentation publishes. The GTFS-RT
 * one is built byte by byte, because a protobuf reader that is only ever tested against
 * itself proves nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const Transit = runInNewContext(
  readFileSync(new URL('../js/transit.js', import.meta.url), 'utf8') + '\nTransit;', {});
const registry = JSON.parse(readFileSync(new URL('../data/transit.json', import.meta.url), 'utf8'));
const feed = (id) => registry.feeds.find((f) => f.id === id);
const NOW = Date.parse('2026-09-28T12:00:00.000Z');

/* ------------------------------------------------------------------- MBTA -- */

test('MBTA JSON:API becomes positioned buses and trains, and stale vehicles are dropped', () => {
  const f = feed('mbta');
  assert.equal(f.adapter, 'mbta');
  const payload = {
    data: [
      { id: 'y1234', type: 'vehicle',
        attributes: { latitude: 42.3519, longitude: -71.0554, bearing: 210, speed: 12.4,
          direction_id: 0, label: 'Y1234', updated_at: '2026-09-28T11:59:30Z', current_status: 'IN_TRANSIT_TO' },
        relationships: { route: { data: { id: 'Green-B' } }, stop: { data: { id: '70149' } } } },
      { id: 'y5678', type: 'vehicle',
        attributes: { latitude: 42.3301, longitude: -71.1077, bearing: 90, speed: 21,
          direction_id: 1, label: '1234', updated_at: '2026-09-28T11:59:40Z' },
        relationships: { route: { data: { id: 'Red' } }, stop: { data: { id: '70083' } } } },
      { id: 'stale', type: 'vehicle',
        attributes: { latitude: 42.34, longitude: -71.06, updated_at: '2026-09-28T11:20:00Z' },
        relationships: { route: { data: { id: '1' } } } },
      { id: 'nowhere', type: 'vehicle',
        attributes: { latitude: 0, longitude: 0, updated_at: '2026-09-28T11:59:40Z' },
        relationships: { route: { data: { id: '1' } } } },
    ],
    included: [
      { type: 'route', id: 'Green-B', attributes: { type: 0, name: 'Green Line B', color: '00843D',
        direction_names: ['Boston College', 'Government Center'] } },
      { type: 'route', id: 'Red', attributes: { type: 1, name: 'Red Line', color: 'DA291C',
        direction_names: ['Ashmont', 'Alewife'] } },
      { type: 'route', id: '1', attributes: { type: 3, name: '1', color: 'FFC72C' } },
      { type: 'stop', id: '70149', attributes: { name: 'Kenmore', latitude: 42.3489, longitude: -71.0952 } },
      { type: 'stop', id: '70083', attributes: { name: 'Park Street', latitude: 42.3564, longitude: -71.0622 } },
    ],
  };
  const out = Transit.parseMbtaVehicles(payload, f, NOW);
  assert.equal(out.length, 2, 'the 40-minute-old vehicle and the 0,0 one are refused');
  const green = out.find((v) => v.lineName === 'Green Line B');
  assert.equal(green.mode, 'tram', 'a GTFS route type 0 is drawn as a tram');
  assert.equal(green.dest, 'Boston College', 'the direction name comes from the included route');
  assert.equal(green.nextStop, 'Kenmore');
  assert.equal(green.speed, Math.round(12.4 * 1.60934), 'mph is converted to the km/h the UI shows');
  assert.equal(green.color, '#00843d');
  assert.equal(out.find((v) => v.lineName === 'Red Line').mode, 'rail');
  assert.equal(out.find((v) => v.lineName === 'Red Line').dest, 'Alewife');
  assert.ok(out.every((v) => v.kind === 'positions' && v.attribution));
});

/* ---------------------------------------------------------- Digitraffic (FI) -- */

test('Digitraffic trains are placed at the station they actually reached, with the real delay', () => {
  const f = feed('fi-rail');
  const table = Transit.digitrafficStations([
    { stationShortCode: 'HKI', name: 'Helsinki central station', longitude: 24.9426, latitude: 60.1719 },
    { stationShortCode: 'PSL', name: 'Pasila', longitude: 24.9332, latitude: 60.1987 },
    { stationShortCode: 'TKL', name: 'Tikkurila', longitude: 25.0441, latitude: 60.2926 },
    { stationShortCode: 'TKU', name: 'Turku central station', longitude: 22.2554, latitude: 60.4518 },
  ]);
  assert.equal(table.get('HKI').lon, 24.9426);
  const payload = [
    { trainNumber: 51, departureDate: '2026-09-28', operatorShortCode: 'VR', trainType: 'IC',
      commuterLineID: null, runningCurrently: true, cancelled: false,
      timeTableRows: [
        { trainStopping: true, type: 'DEPARTURE', stationShortCode: 'HKI', station: 'HKI',
          scheduledTime: '2026-09-28T11:00:00.000Z', actualTime: '2026-09-28T11:44:00.000Z' },
        { trainStopping: true, type: 'ARRIVAL', stationShortCode: 'PSL', station: 'PSL',
          scheduledTime: '2026-09-28T11:49:00.000Z', actualTime: '2026-09-28T11:55:00.000Z' },
        { trainStopping: true, type: 'DEPARTURE', stationShortCode: 'PSL', station: 'PSL',
          scheduledTime: '2026-09-28T12:05:00.000Z', actualTime: null },
        { trainStopping: true, type: 'ARRIVAL', stationShortCode: 'TKL', station: 'TKL',
          scheduledTime: '2026-09-28T12:10:00.000Z', actualTime: null },
        { trainStopping: true, type: 'ARRIVAL', stationShortCode: 'TKU', station: 'TKU',
          scheduledTime: '2026-09-28T13:00:00.000Z', actualTime: null },
      ] },
    { trainNumber: 99, departureDate: '2026-09-28', trainType: 'P', runningCurrently: true, cancelled: true,
      timeTableRows: [{ stationShortCode: 'HKI', actualTime: '2026-09-28T11:50:00.000Z' }] },
    { trainNumber: 100, departureDate: '2026-09-28', trainType: 'S', runningCurrently: true,
      timeTableRows: [{ stationShortCode: 'UNKNOWN', station: 'UNKNOWN',
        actualTime: '2026-09-28T11:50:00.000Z' }] },
  ];
  const out = Transit.parseDigitrafficTrains(payload, f, table, NOW);
  assert.equal(out.length, 1, 'a cancelled train is not drawn and neither is a station nobody can locate');
  const train = out[0];
  assert.equal(train.atStation, 'Pasila', 'the last station the feed says it actually reached');
  assert.equal(train.lon, 24.9332);
  assert.equal(train.nextStop, 'Tikkurila', 'the next station it calls at, not the one it is leaving twice');
  assert.equal(train.dest, 'Turku central station', 'dest stays the terminus, as elsewhere in this layer');
  assert.equal(train.delaySec, 360, 'actual minus scheduled, straight from the feed');
  assert.equal(train.vehicle, '51');
  assert.equal(train.mode, 'rail');
  assert.equal(train.kind, 'station');
  assert.match(train.where, /6 min late/);

  // The same train, with station coordinates embedded instead of a table to join against.
  const embedded = Transit.parseDigitrafficTrains([{
    trainNumber: 52, trainType: 'IC', runningCurrently: true,
    timeTableRows: [{ stationShortCode: 'HKI',
      station: { name: 'Helsinki central station', longitude: 24.9426, latitude: 60.1719 },
      scheduledTime: '2026-09-28T11:57:00.000Z', actualTime: '2026-09-28T11:57:00.000Z' }],
  }], f, new Map(), NOW);
  assert.equal(embedded.length, 1, 'an embedded station needs no table');
  assert.equal(embedded[0].atStation, 'Helsinki central station');
  assert.equal(embedded[0].delaySec, 0);
});

/* --------------------------------------------------- transport.opendata.ch -- */

test('the bundled Digitraffic table is a substantial local station index', () => {
  const f = feed('fi-rail');
  const snapshot = JSON.parse(readFileSync(new URL('../data/fi-stations.json', import.meta.url), 'utf8'));
  const table = Transit.digitrafficStations(snapshot);
  assert.ok(table.size >= 100, 'the published snapshot is large enough to replace a per-session metadata fetch');
  assert.equal(table.get('HKI').name, 'Helsinki asema');
  assert.equal(f.stations, 'data/fi-stations.json');
  assert.equal(Object.hasOwn(f, 'stationsSource'), false, 'the browser has no remote station-table fallback');
});

test('Swiss boards keep only the next few departures and drop the ones already gone', () => {
  const f = feed('ch-rail');
  const station = { id: '8503000', name: 'Zürich HB', coordinate: { type: 'WGS84', x: 8.5402, y: 47.3782 } };
  const tramStop = { id: '8503006', name: 'Zürich Stadelhofen', coordinate: { type: 'WGS84', x: 8.5489, y: 47.3666 } };
  const entry = (n, category, to, minutes, delay, platform, at = station) => ({
    name: category, category, number: String(n), operator: { name: 'SBB' }, to, delay, platform,
    station: at, departure: new Date(NOW + minutes * 60000).toISOString(),
  });
  const payload = { stationboard: [
    entry(724, 'IC', 'Bern', 4, 2, '7'),
    entry(1812, 'IR', 'Luzern', 9, 0, '12'),
    entry(33, 'S', 'Wetzikon', 14, 0, '42'),
    entry(8, 'IC', 'Geneva', 21, 0, '9'),          // fourth at this station: not drawn
    entry(1, 'T', 'Zürich, Bahnhofstrasse', 6, 0, 'A', tramStop),   // another station: its own cap
    entry(2, 'IC', 'Basel', -20, 0, '3'),         // left twenty minutes ago
    { name: 'IC', category: 'IC', number: '999', station: { name: 'nowhere', coordinate: {} },
      departure: new Date(NOW + 60000).toISOString() },   // no coordinates: refused
  ] };
  const out = Transit.parseOpendataChStationboard(payload, f, NOW);
  assert.equal(out.length, 4, 'three per station plus the tram');
  assert.equal(out.filter((v) => v.dest === 'Basel').length, 0, 'a departure that already left is gone');
  assert.ok(out.some((v) => v.lineName === 'T1'), 'the cap is per station, so the tram at another stop survives');
  const ic = out.find((v) => v.lineName === 'IC724');
  assert.equal(ic.lon, 8.5402);
  assert.equal(ic.lat, 47.3782, 'x is longitude and y is latitude in this API');
  assert.equal(ic.delaySec, 120);
  assert.equal(ic.etaSec, 4 * 60 + 120, 'the delay is part of when it actually leaves');
  assert.equal(ic.platform, 'platform 7');
  assert.equal(ic.atStation, 'Zürich HB');
  assert.equal(ic.kind, 'arrivals');
  assert.equal(out.find((v) => v.lineName === 'T1').mode, 'tram');
  assert.equal(out.filter((v) => v.atStation === 'Zürich HB').length, 3);
  assert.ok(out.every((v) => v.observed === NOW), 'a board is not an observation: it is stamped when read');
});

test('board rows are capped per station rather than stacked on one pixel', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ atStation: i < 8 ? 'A' : 'B', i }));
  const kept = Transit.keepPerStation(rows, 3);
  assert.equal(kept.length, 4, 'three at A and one at B');
  assert.equal(kept.filter((r) => r.atStation === 'B').length, 1);
});

/* ------------------------------------------------------------ iRail (BE) -- */

test('iRail liveboards keep live departures and drop cancelled and departed ones', () => {
  const f = feed('be-rail');
  const payload = {
    station: 'BE.NMBS.008813003',
    stationinfo: { name: 'Brussels-South', locationX: 4.33653, locationY: 50.83571 },
    departures: { number: '4', departure: [
      { id: '0', delay: '180', station: 'Antwerpen-Centraal', time: String((NOW + 300000) / 1000),
        vehicle: 'BE.NMBS.IC1234', vehicleinfo: { name: 'IC1234' },
        platform: '12', platforminfo: { name: '12', normal: 'true' }, canceled: '0' },
      { id: '1', delay: '0', station: 'Liège-Guillemins', time: String((NOW + 600000) / 1000),
        vehicle: 'BE.NMBS.IC4512', vehicleinfo: { name: 'IC4512' }, platform: '8', canceled: '1' },
      { id: '2', delay: '0', station: 'Gent', time: String((NOW - 900000) / 1000),
        vehicle: 'BE.NMBS.IC9999', vehicleinfo: { name: 'IC9999' }, platform: '3', canceled: '0' },
    ] },
  };
  const out = Transit.parseIrailLiveboard(payload, f, NOW);
  assert.equal(out.length, 1, 'the cancelled and the long-gone service are not drawn');
  const train = out[0];
  assert.equal(train.lineName, 'IC1234');
  assert.equal(train.lineId, 'IC');
  assert.equal(train.dest, 'Antwerpen-Centraal');
  assert.equal(train.atStation, 'Brussels-South');
  assert.equal(train.lon, 4.33653);
  assert.equal(train.delaySec, 180);
  assert.equal(train.etaSec, 300 + 180);
  assert.equal(train.platform, 'platform 12');
  assert.equal(train.mode, 'rail');
});

/* ---------------------------------------------------- static rail geometry -- */

test('MBTA rail shapes and stops retain only configured rail lines and valid station dots', () => {
  const f = feed('mbta');
  const parsed = Transit.parseMbtaStatic({ data: [
    { attributes: { polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
      relationships: { route: { data: { id: 'Red' } } } },
    { attributes: { polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
      relationships: { route: { data: { id: '1' } } } }, // bus route: deliberately absent from staticRoutes
  ] }, { data: [
    { id: 'place-alfcl', attributes: { name: 'Alewife', longitude: -71.2076, latitude: 42.3954 } },
    { id: 'bad', attributes: { name: 'Bad coordinate', longitude: 'not-a-number', latitude: 42 } },
  ] }, f);
  assert.equal(parsed.lines.length, 1, 'bus geometry is not folded into the rail snapshot');
  assert.equal(parsed.lines[0].id, 'Red');
  assert.deepEqual([...parsed.lines[0].coords[0]], [-120.2, 38.5], 'MBTA encoded shape is decoded as lon/lat');
  assert.equal(parsed.stations.length, 1);
  assert.equal(parsed.stations[0].name, 'Alewife');
});

test('Swiss pass lists and Belgian iRail vias form published line segments and station dots', () => {
  const swiss = Transit.parseOpendataChConnection({ connections: [{
    from: { station: { id: '8503000', name: 'Zürich HB', coordinate: { x: 8.5402, y: 47.3782 } } },
    journey: { name: 'IC 1', passList: [{ station: { id: '8507000', name: 'Bern', coordinate: { x: 7.439, y: 46.948 } } }] },
    to: { station: { id: '8501120', name: 'Lausanne', coordinate: { x: 6.629, y: 46.517 } } },
  }] }, { id: 'ch-fixture', name: 'Zürich–Lausanne', color: '#005ca9' });
  assert.deepEqual(JSON.parse(JSON.stringify(swiss.coords)), [[8.5402, 47.3782], [7.439, 46.948], [6.629, 46.517]]);
  assert.equal(swiss.stations.length, 3);
  assert.equal(swiss.name, 'Zürich–Lausanne');

  const belgian = Transit.parseIrailConnection({ connection: [{
    departure: { stationinfo: { id: 'be-brussels', name: 'Brussels-South', locationX: 4.3365, locationY: 50.8357 } },
    vias: { via: [{ stationinfo: { id: 'be-leuven', name: 'Leuven', locationX: 4.7009, locationY: 50.8823 } }] },
    arrival: { stationinfo: { id: 'be-liege', name: 'Liège-Guillemins', locationX: 5.5668, locationY: 50.6246 } },
  }] }, { id: 'be-fixture', name: 'Brussels–Liège', color: '#005ca9' });
  assert.deepEqual(JSON.parse(JSON.stringify(belgian.coords)), [[4.3365, 50.8357], [4.7009, 50.8823], [5.5668, 50.6246]]);
  assert.equal(belgian.stations.length, 3);
  const dots = Transit.parseIrailStations({ station: [
    { id: 'be-brussels', name: 'Brussels-South', locationX: 4.3365, locationY: 50.8357 },
    { id: 'bad', name: 'Bad', locationX: 'none', locationY: 50 },
  ] });
  assert.equal(dots.length, 1, 'invalid station-list records cannot create a dot at an invented location');
});

test('the compact static GTFS format supplies GCRTA geometry and station dots', () => {
  const f = feed('gcrta-bus');
  const parsed = Transit.parseGtfsStatic({ lines: [
    { id: '66', name: 'Red Line', color: '#BA0C2F', coords: [[-81.837, 41.411], [-81.694, 41.497]] },
    { id: '', name: 'Discarded', coords: [[-81, 41], [-80, 42]] },
  ], stations: [
    { id: 'airport', name: 'Airport Station', lon: -81.837, lat: 41.411 },
    { id: 'bad', name: 'Broken station', lon: null, lat: 41 },
  ] }, f);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].color, '#ba0c2f');
  assert.equal(parsed.stations.length, 1);
  assert.equal(parsed.stations[0].id, 'airport');
});

test('the geometry registry covers the configured MBTA, Swiss, Belgian and GCRTA rail layers', () => {
  const mbta = feed('mbta');
  const swiss = feed('ch-rail');
  const belgian = feed('be-rail');
  const gcrta = feed('gcrta-bus');
  assert.ok(mbta.staticRoutes.length >= 4);
  assert.ok(swiss.geometry.length >= 4 && swiss.geometry.every((pair) => swiss.stations.includes(pair.from) && swiss.stations.includes(pair.to)));
  assert.ok(belgian.geometry.length >= 4 && belgian.geometry.every((pair) => belgian.stations.includes(pair.from) && belgian.stations.includes(pair.to)));
  assert.match(gcrta.static, /^data\/gcrta-static\.json$/);
  const snapshot = JSON.parse(readFileSync(new URL('../data/gcrta-static.json', import.meta.url), 'utf8'));
  assert.ok(snapshot.lines.length >= 3 && snapshot.stations.length >= 10, 'the shipped GCRTA snapshot is real map data, not an empty placeholder');
});

/* ------------------------------------------------------- GTFS-Realtime (pb) -- */

const varint = (n) => { const out = []; let v = n; while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } out.push(v); return out; };
const tag = (field, type) => varint(field * 8 + type);
const len = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const text = (field, value) => len(field, [...Buffer.from(value, 'utf8')]);
const num = (field, value) => [...tag(field, 0), ...varint(value)];
const f32 = (field, value) => { const b = Buffer.alloc(4); b.writeFloatLE(value); return [...tag(field, 5), ...b]; };

function vehiclePosition({ lat, lon, bearing = 0, speed = 0, at, routeId = '10', label = 'BUS 1', id = 'veh1', stopId }) {
  return len(4, [
    // TripDescriptor: trip_id (1), start_time (2), start_date (3), route_id (5) — the real
    // field layout; start_time at 2 is there to fail any parser that re-reads it as the route.
    ...len(1, [...text(1, 'trip-1'), ...text(2, '11:28:25'), ...text(3, '20260928'), ...text(5, routeId)]),
    ...len(2, [...text(1, id), ...text(2, label)]),                  // VehicleDescriptor
    ...len(3, [...f32(1, lat), ...f32(2, lon), ...f32(3, bearing), ...f32(5, speed)]),
    ...(stopId ? text(7, stopId) : []),                              // stop_id
    ...num(8, Math.round(at / 1000)),                                // seconds since epoch
    ...num(11, 42),                                                  // occupancy_percentage: never a stop label
  ]);
}
function feedMessage(vehicles, headerAt) {
  return [...len(1, num(3, Math.round(headerAt / 1000))),
    ...vehicles.flatMap((v, i) => len(2, [...text(1, `entity-${i}`), ...vehiclePosition(v)]))];
}

test('the protobuf reader pulls vehicle positions out of a hand-built GTFS-RT feed', () => {
  const f = feed('gcrta-bus');
  assert.equal(f.adapter, 'gtfsrt');
  const bytes = new Uint8Array(feedMessage([
    { lat: 41.4993, lon: -81.6944, bearing: 275.5, speed: 8.3, at: NOW - 15000, routeId: '22', label: 'BUS 4412', stopId: 'STOP-1041' },
    { lat: 41.505, lon: -81.7, at: NOW - 40000, routeId: '9', label: 'BUS 9001' },
    { lat: 0, lon: 0, at: NOW - 5000 },                                        // a null island: refused
    { lat: 41.5, lon: -81.7, at: NOW - 20 * 60000, routeId: '5' },             // twenty minutes old: refused
  ], NOW));

  const out = Transit.parseGtfsrtFeed(bytes, f, NOW);
  assert.equal(out.length, 2, 'null island and a twenty-minute-old report are both refused');
  const bus = out.find((v) => v.vehicle === 'BUS 4412');
  assert.equal(bus.lineId, '22', 'route_id is field 5, not the start_time at field 2');
  assert.equal(bus.nextStop, 'STOP-1041', 'stop_id is field 7, not the occupancy at field 11');
  assert.equal(bus.dest, '', 'a trip_id is an internal job number, never a destination label');
  assert.equal(bus.mode, 'bus');
  assert.equal(bus.kind, 'positions');
  assert.equal(bus.heading, 275.5 > 275 && bus.heading < 276 ? bus.heading : 275.5);
  assert.ok(Math.abs(bus.heading - 275.5) < 0.1, `float32 bearing survives: ${bus.heading}`);
  assert.ok(Math.abs(bus.lat - 41.4993) < 1e-4, `float32 latitude survives: ${bus.lat}`);
  assert.equal(bus.speed, Math.round(8.3 * 3.6), 'm/s becomes the km/h the UI shows');
  assert.equal(bus.key, 'gtfsrt:gcrta-bus:veh1');
  assert.equal(out.find((v) => v.vehicle === 'BUS 9001').heading, 0, 'no bearing is not an invented bearing');
});

test('fleet labels are trimmed and a route-less bus falls back to the feed badge', () => {
  const f = feed('delhi-dtc');
  assert.equal(f.badge, 'DTC');
  let bytes = new Uint8Array(feedMessage([
    { lat: 28.6139, lon: 77.209, at: NOW - 5000, routeId: ' 244 ', label: ' DL1PD4567' }, // OTD really ships padded labels
  ], NOW));
  let [bus] = Transit.parseGtfsrtFeed(bytes, f, NOW);
  assert.equal(bus.vehicle, 'DL1PD4567', 'whitespace in fleet labels must not leak into the UI');
  assert.equal(bus.lineId, '244');
  assert.equal(bus.lineName, '244');
  // a vendor that sends no route strings at all: entity with a vehicle but a bare TripDescriptor
  const bare = new Uint8Array([...len(1, num(3, Math.round(NOW / 1000))),
    ...len(2, [...text(1, 'e1'), ...len(4, [
      ...len(1, [...text(1, 'job-7755')]),
      ...len(3, [...f32(1, 28.62), ...f32(2, 77.21)]),
      ...num(8, Math.round((NOW - 9000) / 1000)),
    ])])]);
  [bus] = Transit.parseGtfsrtFeed(bare, f, NOW);
  assert.equal(bus.lineId, '');
  assert.equal(bus.lineName, 'DTC', 'route-less vehicles badge as the fleet, not a blank or a clock');
  assert.equal(bus.key, 'gtfsrt:delhi-dtc:job-7755', 'the trip_id still anchors identity, never the label');
});

test('the protobuf reader refuses a truncated or empty feed instead of drawing garbage', () => {
  const f = feed('gcrta-bus');
  assert.throws(() => Transit.parseGtfsrtFeed(new Uint8Array(0), f, NOW), /empty realtime payload/);
  const good = feedMessage([{ lat: 41.5, lon: -81.7, at: NOW }], NOW);
  assert.throws(() => Transit.parseGtfsrtFeed(new Uint8Array(good.slice(0, good.length - 3)), f, NOW),
    /truncated/, 'a half-written frame must not become a fleet');
  // A feed whose vehicles carry no Position at all is a real shape and simply draws nothing.
  const noPosition = [...len(1, num(3, 1)), ...len(2, [...text(1, 'e1')])];
  // length, not deepEqual: the array is built in the module's own realm
  assert.equal(Transit.parseGtfsrtFeed(new Uint8Array(noPosition), f, NOW).length, 0);
  // Unknown fields must be skipped, not fatal: the format is allowed to grow.
  const unknown = [...len(1, num(3, 1)), ...len(2, [...text(1, 'e1'), ...vehiclePosition({ lat: 41.5, lon: -81.7, at: NOW }), ...num(9, 7)])];
  assert.equal(Transit.parseGtfsrtFeed(new Uint8Array(unknown), f, NOW).length, 1);
});

test('the wire-format primitives decode the cases that are easy to get wrong', () => {
  assert.deepEqual([...Transit.pbVarint(new Uint8Array([0]), 0)], [0, 1]);
  assert.deepEqual([...Transit.pbVarint(new Uint8Array([300 & 0x7f | 0x80, 300 >> 7]), 0)], [300, 2]);
  // A 64-bit varint: precision is documented as approximate, but the value must still parse.
  const big = [...varint(1759046400)];
  assert.deepEqual([...Transit.pbVarint(new Uint8Array(big), 0)], [1759046400, big.length]);
  const fields = Transit.pbFields(new Uint8Array([...text(2, 'hi'), ...f32(1, 1.5), ...num(3, 9)]));
  assert.equal(fields.length, 3);
  assert.throws(() => Transit.pbFields(new Uint8Array([tag(1, 2), 9, 1])), /truncated/);
  assert.throws(() => Transit.pbFields(new Uint8Array([tag(1, 7)])), /unsupported wire type 7/);
});

/* ------------------------------------------- keyless worldwide GTFS-RT batch --
 * Atlanta, Edmonton, the Dutch national feed and Rapid KL are the same shape as
 * Cleveland: one keyless VehiclePositions URL each, no per-agency code. Delhi is the
 * same again but behind a free registered key, so it ships with the SIGNUP marker
 * already used by 511ny and must be skipped until a real key replaces it.
 */
test('the expansion feeds are plain gtfsrt positions feeds over keyless HTTPS', () => {
  for (const id of ['atlanta-marta', 'edmonton-ets', 'nl-ovapi', 'my-rapid-kl']) {
    const f = feed(id);
    assert.ok(f, `${id} must be registered`);
    assert.equal(f.adapter, 'gtfsrt');
    assert.equal(f.kind, 'positions');
    assert.equal(f.mode, 'bus');
    assert.match(f.base, /^https:\/\//, `${id}: keyless feeds this layer fetched live are HTTPS`);
    assert.ok(!Transit.needsKey(f), `${id} must not carry the signup placeholder`);
    assert.ok(f.attribution && f.page && f.operator && f.city, `${id} needs full attribution`);
    assert.match(f.note, /no key|free|keyless/i, `${id}: the note must say why it needs no key`);
    assert.equal(f.static, undefined, `${id}: unbundled feeds draw positions only, no invented geometry`);
  }
  assert.match(feed('atlanta-marta').base, /TMGTFSRealTimeWebService.*vehiclepositions\.pb$/i);
  assert.match(feed('edmonton-ets').base, /TMGTFSRealTimeWebService.*VehiclePositions\.pb$/i);
  assert.equal(feed('nl-ovapi').base, 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb');
  assert.match(feed('my-rapid-kl').base, /^https:\/\/api\.data\.gov\.my\/gtfs-realtime\/vehicle-position\/prasarana\?category=rapid-bus-kl$/);
  // The Dutch feed is the national one: heavy enough that its update budget must be doubled.
  assert.ok(feed('nl-ovapi').budgetSec > feed('edmonton-ets').budgetSec,
    'a multi-megabyte national payload must not be re-read as often as a city feed');
});

test('Delhi carries a registered operator key and is live from the first sweep', () => {
  const f = feed('delhi-dtc');
  assert.ok(f, 'Delhi must be registered');
  assert.equal(f.adapter, 'gtfsrt');
  assert.equal(f.kind, 'positions');
  assert.match(f.base, /^https:\/\/otd\.delhi\.gov\.in\/api\/realtime\/VehiclePositions\.pb\?key=[A-Za-z0-9]{16,}$/,
    'the realtime URL is fixed and holds a real authorised key, not the SIGNUP marker');
  assert.ok(!Transit.needsKey(f), 'a real key must not be treated as the placeholder');
  assert.ok(f.signup && /otd\.delhi\.gov\.in/.test(f.signup), 'the registry must still say where a key comes from');
  assert.match(f.note, /DMRC|Metro/i, 'the note must record that no Delhi Metro live feed exists');
  assert.match(f.note, /never substitute simulated/i,
    'and that simulated trains must never stand in for that missing feed');
  assert.equal(Transit.needsKey({ base: 'https://x.example/feed.pb?key=SIGNUP' }), true);
  assert.equal(Transit.needsKey({ base: 'https://x.example/feed.pb?key=a1b2c3' }), false);
  assert.equal(Transit.needsKey({ base: 'https://x.example/feed.pb' }), false);
  assert.equal(Transit.needsKey(null), false);
});

test('a keyless-pending feed would be skipped by the sweep instead of failing forever', () => {
  /* render() counts networks against the registry MINUS pending ones; refresh() polls
   * nothing while SIGNUP sits in the URL. Both behaviours live off the exported needsKey
   * seam, so the whole mechanism is: pending feeds are discoverable but inert. */
  const f = feed('delhi-dtc');
  const pending = Object.assign({}, f, { base: f.base.replace(/key=[A-Za-z0-9]{16,}$/, 'key=SIGNUP') });
  assert.ok(Transit.needsKey(pending), 'reverting to the placeholder puts the feed back to sleep');
  assert.ok(!Transit.needsKey(f), 'and restoring the key wakes it again — that is the whole upgrade path');
});
