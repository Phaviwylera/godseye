import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/transit.js', import.meta.url), 'utf8');
const Transit = runInNewContext(source + '\nTransit;', {});

const registry = JSON.parse(readFileSync(new URL('../data/transit.json', import.meta.url), 'utf8'));
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const feed = (id) => registry.feeds.find((f) => f.id === id);

test('registry only declares supported adapters, modes and attribution', () => {
  assert.ok(registry.feeds.length >= 6);
  for (const f of registry.feeds) {
    assert.ok(['oba', 'tfl', 'bart', 'umo', 'seoul'].includes(f.adapter), `unknown adapter ${f.adapter}`);
    assert.ok(['positions', 'arrivals', 'station'].includes(f.kind), `unknown kind ${f.kind}`);
    assert.ok(['rail', 'bus', 'tram'].includes(f.mode), `unknown mode ${f.mode}`);
    for (const key of ['id', 'network', 'operator', 'city', 'attribution', 'page']) {
      assert.ok(f[key], `${f.id} missing ${key}`);
    }
  }
  assert.ok(registry.feeds.some((f) => f.mode === 'bus'), 'the layer must cover buses');
  assert.ok(registry.feeds.filter((f) => f.mode !== 'bus').length >= 3, 'and several rail/tram networks');
});

test('the TRANSIT control and chip exist in the UI', () => {
  assert.match(html, /id="btn-transit"/);
  assert.match(html, /id="transit-chip"/);
  assert.match(html, /js\/transit\.js/);
});

test('polyline and TfL line-string geometry decode to [lon, lat] pairs', () => {
  const coords = Transit.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(coords.length, 3);
  assert.equal(coords[0][0].toFixed(1), '-120.2');
  assert.equal(coords[0][1].toFixed(1), '38.5');
  const lines = Transit.parseLineStrings(['[[[-0.090047,51.513132],[-0.11478,51.503299]]]']);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0][0], -0.090047);
  assert.equal(Transit.parseLineStrings(['not json']).length, 0);
});

test('dark brand colours are lifted so lines stay visible on the globe', () => {
  assert.equal(Transit.readable('#00782A'), '#00782a');
  assert.notEqual(Transit.readable('#000000'), '#000000');   // Northern line black
  assert.equal(Transit.normColor('00782a'), '#00782a');
  assert.equal(Transit.normColor(''), '#7ee0ff');
});

test('GTFS route types map onto rail / tram / bus markers', () => {
  assert.equal(Transit.modeFromRouteType(1), 'rail');
  assert.equal(Transit.modeFromRouteType(2), 'rail');
  assert.equal(Transit.modeFromRouteType(0), 'tram');
  assert.equal(Transit.modeFromRouteType(3), 'bus');
});

test('OneBusAway route list keeps the modes a feed asks for', () => {
  const payload = {
    data: {
      list: [
        { id: '40_100479', nullSafeShortName: '1 Line', color: '28813F', type: 0 },
        { id: '40_SNDR_EV', shortName: 'N Line', color: '9AB6D3', type: 2 },
        { id: '40_594', shortName: '594', color: '2b376e', type: 3 },
      ],
    },
  };
  const rail = Transit.parseObaRoutes(payload, feed('st-rail'));
  assert.deepEqual([...rail.map((r) => r.id)], ['40_100479', '40_SNDR_EV']);
  assert.equal(rail[0].color, '#28813f');
  const buses = Transit.parseObaRoutes(payload, feed('ps-bus'));
  assert.deepEqual([...buses.map((r) => r.id)], ['40_594']);
});

test('OneBusAway trip payload becomes positioned trains with next-stop detail', () => {
  const payload = {
    data: {
      list: [{
        tripId: '40_TLINE_61',
        status: {
          vehicleId: '40_1',
          position: { lat: 47.26, lon: -122.4535 },
          orientation: 282.8,
          nextStop: '40_T19',
          nextStopTimeOffset: 120,
          scheduleDeviation: 37,
          lastUpdateTime: 1700000000000,
        },
      }],
      references: {
        trips: [{ id: '40_TLINE_61', tripHeadsign: 'Tacoma Dome Station' }],
        stops: [{ id: '40_T19', name: 'Convention Center/S 15th St', lat: 47.26, lon: -122.4535 }],
      },
    },
  };
  const route = { id: '40_TLINE', name: 'T Line', color: '#f38b00', type: 0 };
  const items = Transit.parseObaTrips(payload, feed('st-rail'), route);
  assert.equal(items.length, 1);
  const [train] = items;
  assert.equal(train.kind, 'positions');
  assert.equal(train.mode, 'rail', 'a rail feed draws its light-rail routes as trains, not trams');
  assert.equal(train.lat, 47.26);
  assert.equal(train.heading, 282.8);
  assert.equal(train.dest, 'Tacoma Dome Station');
  assert.equal(train.nextStop, 'Convention Center/S 15th St');
  assert.equal(train.etaSec, 120);
  assert.equal(train.delaySec, 37);
});

test('OneBusAway bus fleet payload maps vehicles onto their routes and drops empty ones', () => {
  const routes = new Map([
    ['29_100479', { id: '29_100479', name: 'Route 101', color: '#2b376e', type: 3 }],
  ]);
  const payload = {
    data: {
      list: [
        { vehicleId: '29_9001', tripId: '29_111', tripStatus: {
          position: { lat: 47.9, lon: -122.2 }, orientation: 45, nextStop: '29_5',
          nextStopTimeOffset: 60, scheduleDeviation: -30, lastUpdateTime: 1700000000000 } },
        { vehicleId: '29_9002', tripId: '', tripStatus: null },       // in the yard: nothing to draw
        { vehicleId: '29_9003', tripId: '29_999', tripStatus: {
          position: { lat: 47.95, lon: -122.25 }, orientation: 90, lastUpdateTime: 1700000000000 } },
      ],
      references: {
        trips: [{ id: '29_111', routeId: '29_100479', tripHeadsign: 'Everett Station' }],
        stops: [{ id: '29_5', name: 'Everett Station Bay 2', lat: 47.9, lon: -122.2 }],
      },
    },
  };
  const items = Transit.parseObaVehicles(payload, feed('ps-bus'), routes);
  assert.equal(items.length, 1, 'only the bus with a known route is drawn');
  assert.equal(items[0].mode, 'bus');
  assert.equal(items[0].lineName, 'Route 101');
  assert.equal(items[0].dest, 'Everett Station');
  assert.equal(items[0].delaySec, -30);
  assert.equal(items[0].attribution, feed('ps-bus').attribution);
});

test('TfL route sequence yields geometry plus ordered, tidied stations', () => {
  const payload = {
    lineId: 'waterloo-city',
    lineStrings: ['[[[-0.090047,51.513132],[-0.11478,51.503299]]]'],
    stopPointSequences: [{
      stopPoint: [
        { id: '940GZZLUBNK', name: 'Bank Underground Station', lat: 51.513132, lon: -0.090047 },
        { id: '940GZZLUWLO', name: 'Waterloo Underground Station', lat: 51.503299, lon: -0.11478 },
        { id: '940GZZLUWLO', name: 'Waterloo Underground Station', lat: 51.503299, lon: -0.11478 },
      ],
    }],
  };
  const parsed = Transit.parseTflSequence(payload, feed('tfl'), { id: 'waterloo-city', name: 'Waterloo & City' });
  assert.equal(parsed.lines.length, 1);
  assert.deepEqual([...parsed.stations.map((s) => s.name)], ['Bank', 'Waterloo']);
  assert.deepEqual([...parsed.stations.map((s) => s.id)], ['940GZZLUBNK', '940GZZLUWLO']);
});

test('TfL status keeps the worst severity and its reason', () => {
  const status = Transit.parseTflStatus([{
    id: 'central',
    lineStatuses: [
      { statusSeverity: 10, statusSeverityDescription: 'Good Service' },
      { statusSeverity: 5, statusSeverityDescription: 'Part Closure', reason: 'No service Liverpool Street to Woodford' },
    ],
  }]);
  assert.equal(status.get('central').severity, 5);
  assert.match(status.get('central').reason, /Woodford/);
});

test('TfL arrivals de-duplicate by vehicle, keep the soonest call and drop unknown stops', () => {
  const stops = new Map([['940GZZLUCND', { id: '940GZZLUCND', name: 'Colindale', lat: 51.5, lon: -0.1 }]]);
  const meta = new Map([['northern', { name: 'Northern', color: '#555555' }]]);
  const payload = [
    { vehicleId: '122', naptanId: '940GZZLUCND', lineId: 'northern', timeToStation: 160, destinationName: 'Morden Underground Station', timestamp: '2026-09-27T18:50:32Z' },
    { vehicleId: '122', naptanId: '940GZZLUCND', lineId: 'northern', timeToStation: 640, destinationName: 'Morden Underground Station', timestamp: '2026-09-27T18:50:32Z' },
    { vehicleId: '999', naptanId: '940GZZLUXXX', lineId: 'northern', timeToStation: 30, destinationName: 'Nowhere', timestamp: '2026-09-27T18:50:32Z' },
  ];
  const items = Transit.parseTflArrivals(payload, feed('tfl'), stops, meta);
  assert.equal(items.length, 1, 'unknown stations must be dropped, vehicles merged');
  assert.equal(items[0].etaSec, 160);
  assert.equal(items[0].lineName, 'Northern');
  assert.equal(items[0].mode, 'rail');
  assert.equal(items[0].kind, 'arrivals');
});

test('BART stations and routes parse the API quirks (strings, single objects)', () => {
  const stations = Transit.parseBartStations({
    root: { stations: { station: [
      { name: 'Montgomery St.', abbr: 'MONT', gtfs_latitude: '37.7846', gtfs_longitude: '-122.4079' },
      { name: 'Powell St.', abbr: 'POWL', gtfs_latitude: '37.7845', gtfs_longitude: '-122.4078' },
    ] } },
  });
  assert.equal(stations.length, 2);
  assert.equal(stations[0].lat, 37.7846);

  const routes = Transit.parseBartRoutes({
    root: { routes: { route: [
      { name: "Antioch to SF Int'l Airport SFO/Millbrae", abbr: 'ANTC-MLBR', routeID: 'ROUTE 1', number: '1', color: 'YELLOW', hexcolor: '#FFFF33' },
    ] } },
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].colorName, 'YELLOW');
  assert.equal(routes[0].color, '#ffff33');

  const index = new Map(stations.map((s) => [s.abbr, s]));
  const coords = Transit.parseBartRouteInfo({
    root: { routes: { route: { config: { station: ['MONT', 'POWL'] } } } },
  }, feed('bart'), routes[0], index);
  assert.equal(coords[0][0], -122.4079);
  assert.equal(coords[0][1], 37.7846);
});

test('BART departures become station-snapped trains inside the sampling window', () => {
  const stations = new Map([['MONT', { abbr: 'MONT', name: 'Montgomery St.', lat: 37.7846, lon: -122.4079 }]]);
  const routes = new Map([['YELLOW', { number: '1', name: 'Antioch to SFO/Millbrae', colorName: 'YELLOW', color: '#ffff33' }]]);
  const payload = {
    root: { station: [{ abbr: 'MONT', etd: [{ destination: 'Antioch', abbreviation: 'ANTC', estimate: [
      { minutes: 'Leaving', platform: '2', direction: 'North', color: 'YELLOW', hexcolor: '#ffff33', delay: '0' },
      { minutes: '28', platform: '2', direction: 'North', color: 'YELLOW', hexcolor: '#ffff33', delay: '0' },
    ] }] }] },
  };
  const items = Transit.parseBartEtd(payload, feed('bart'), stations, routes, 5);
  assert.equal(items.length, 1, 'only the departure due within the window is kept');
  assert.equal(items[0].etaSec, 0);
  assert.equal(items[0].nextStop, 'Montgomery St.');
  assert.equal(items[0].kind, 'arrivals');
  assert.match(Transit.etaText(items[0]), /arriving now/);
});

test('Umo route list is a tag -> title map', () => {
  const names = Transit.parseUmoRoutes({ route: [
    { tag: '501', title: '501-Queen' },
    { tag: '29', title: '29-Dufferin' },
    { tag: '', title: 'Broken' },
  ] });
  assert.equal(names.get('501'), '501-Queen');
  assert.equal(names.get('29'), '29-Dufferin');
  assert.equal(names.size, 2);
});

test('Umo vehicles become positioned buses, split streetcars out and drop stale reports', () => {
  const names = new Map([['504', '504-King'], ['29', '29-Dufferin']]);
  const payload = { vehicle: [
    { id: '4507', routeTag: '504', dirTag: '504_0_504B', lat: '43.6432', lon: '-79.4056', heading: '77', speedKmHr: '24', secsSinceReport: '5' },
    { id: '6701', routeTag: '29', dirTag: '29_1_29B', lat: '43.7976', lon: '-79.3117', heading: '277', speedKmHr: '0', secsSinceReport: '35' },
    { id: '9999', routeTag: '29', lat: '43.7', lon: '-79.4', heading: '10', speedKmHr: '0', secsSinceReport: '900' },
    { id: '8888', routeTag: '29', lat: null, lon: null, heading: '0', speedKmHr: '0', secsSinceReport: '5' },
  ] };
  const items = Transit.parseUmoVehicles(payload, feed('ttc'), names, 180);
  assert.equal(items.length, 2, 'the stale and the positionless vehicle are dropped');
  const [streetcar, bus] = items;
  assert.equal(streetcar.mode, 'tram', 'TTC 5xx routes are streetcars');
  assert.equal(streetcar.lineName, '504-King');
  assert.equal(streetcar.speed, 24);
  assert.equal(streetcar.color, '#41efc2');
  assert.equal(bus.mode, 'bus');
  assert.equal(bus.color, '#d9b56d');
  assert.equal(bus.dest, '29B');
  assert.equal(items.every((v) => v.kind === 'positions'), true);
});

test('a feed with no tram prefix keeps every vehicle on its declared mode', () => {
  const payload = { vehicle: [
    { id: '1', routeTag: '501', lat: '43.6', lon: '-79.4', heading: '90', speedKmHr: '10', secsSinceReport: '10' },
  ] };
  const items = Transit.parseUmoVehicles(payload, feed('stl'), new Map(), 180);
  assert.equal(items.length, 1);
  assert.equal(items[0].mode, 'bus');
  assert.equal(items[0].lineName, 'Route 501', 'unknown tags fall back to the route tag');
});

/* ------------------------------------------------------------------ Seoul --
 * Korea's only keyless live feed: the Seoul open API reports the station a train is
 * at, never a position, so the adapter's job is to place it honestly or not at all.
 */

const stationTable = JSON.parse(readFileSync(new URL('../data/kr-stations.json', import.meta.url), 'utf8'));

test('the Seoul feed is declared as a sampled, station-snapped network', () => {
  const f = feed('seoul-metro');
  assert.ok(f, 'the Seoul network must be registered');
  assert.equal(f.adapter, 'seoul');
  assert.equal(f.kind, 'station');
  assert.equal(f.cors, false, 'the host is http-only, so the relay has to fetch it');
  assert.ok(f.sample, 'the public sample key must be flagged so the UI says so');
  assert.equal(f.stations, 'data/kr-stations.json');
  assert.ok(f.lines.length >= 12, 'enough lines to be a network, not a demo');
  assert.ok(f.rotate >= 1 && f.rotate < f.lines.length, 'lines must be polled in rotation, not all at once');
  for (const line of f.lines) {
    assert.ok(line.id && line.name, 'each line needs the Korean id the API takes and a display name');
    assert.match(line.color, /^#[0-9a-f]{6}$/i);
  }
  assert.match(f.note, /sample key/i, 'the note must say the data is a sample');
  assert.match(f.note, /1,000 requests/, 'and why the polling is throttled');
});

test('the bundled station table is real coordinates, and ambiguous names are refused', () => {
  assert.ok(stationTable.count >= 600, 'the capital area has more stations than that');
  assert.equal(Object.keys(stationTable.stations).length, stationTable.count);
  assert.ok(stationTable.ambiguous.includes('양평'), '양평 is on two lines 47 km apart and must not be guessed');
  for (const [name, point] of Object.entries(stationTable.stations)) {
    assert.ok(!stationTable.ambiguous.includes(name), `${name} cannot be both placed and refused`);
    assert.ok(point[0] > 125.5 && point[0] < 129 && point[1] > 35 && point[1] < 39, `${name} is not in Korea`);
  }
  assert.equal(stationTable.license.includes('CC0'), true);
  assert.ok(stationTable.regenerate.length > 40, 'a regeneration query must ship with the data');
});

test('Seoul report times are read as KST, not as whatever zone the viewer is in', () => {
  const ms = Transit.parseKst('2026-09-28 09:56:29');
  assert.equal(new Date(ms).toISOString(), '2026-09-28T00:56:29.000Z');
  assert.equal(Number.isNaN(Transit.parseKst('')), true);
  assert.equal(Number.isNaN(Transit.parseKst('2026-09-28')), true);
  assert.equal(Number.isNaN(Transit.parseKst(null)), true);
});

test('station names are matched through aliases and without the trailing 역', () => {
  const candidates = Transit.seoulStationCandidates('대흥(서강대앞)');
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0], '대흥(서강대앞)');
  assert.equal(candidates[1], '대흥');
  assert.equal(candidates[2], '서강대앞');
  const table = new Map([['강남', [127.027583, 37.497928]], ['이수', [126.981611, 37.4765]]]);
  assert.equal(Transit.seoulLookup(table, '강남').lat, 37.497928);
  // 총신대입구(이수) is the same station as 이수역; either label has to resolve.
  assert.equal(Transit.seoulLookup(table, '총신대입구(이수)').lon, 126.981611);
  assert.equal(Transit.seoulLookup(table, '없는역'), null, 'an unknown station must resolve to nothing');
});

test('Seoul trains are snapped to their station, and never to a guess', () => {
  const f = Object.assign({}, feed('seoul-metro'), { maxAgeSec: 900 });
  const table = new Map([
    ['강남', [127.027583, 37.497928]],
    ['천호', [127.115528, 37.516336]],
  ]);
  const meta = new Map([['1002', { name: 'Line 2', color: '#00A84D' }]]);
  const fresh = '2026-09-28 09:56:29';
  const now = Date.parse('2026-09-28T00:56:29.000Z');
  const payload = { realtimePositionList: [
    // kept: in the table, found through its alias. dropped: unknown station, 20 minutes stale,
    { subwayId: '1002', subwayNm: '2호선', statnNm: '강남', trainNo: '2112', recptnDt: fresh, statnTnm: '성수종착', trainSttus: '2' },
    { subwayId: '1002', subwayNm: '2호선', statnNm: '천호(풍납토성)', trainNo: '2113', recptnDt: fresh, statnTnm: '성수(하선)', trainSttus: '1' },
    { subwayId: '1002', subwayNm: '2호선', statnNm: '없는역', trainNo: '2114', recptnDt: fresh, statnTnm: '성수', trainSttus: '1' },
    // one hour in the future (clock skew) and a report time that is not a time at all
    { subwayId: '1002', subwayNm: '2호선', statnNm: '강남', trainNo: '2115', recptnDt: '2026-09-28 09:36:29', statnTnm: '성수', trainSttus: '1' },
    { subwayId: '1002', subwayNm: '2호선', statnNm: '강남', trainNo: '2116', recptnDt: '2026-09-28 10:56:29', statnTnm: '성수', trainSttus: '1' },
    { subwayId: '1002', subwayNm: '2호선', statnNm: '강남', trainNo: '2117', recptnDt: 'not a time', statnTnm: '성수', trainSttus: '1' },
  ] };
  const items = Transit.parseSeoulPositions(payload, f, table, now, meta);
  assert.equal(items.length, 2, `stale, future and unknown-station reports must drop out: got ${items.length}`);
  assert.equal(items[0].kind, 'station');
  assert.equal(items[0].mode, 'rail');
  assert.equal(items[0].lineName, 'Line 2');
  assert.equal(items[0].color, '#00a84d');
  assert.equal(items[0].atStation, '강남');
  assert.equal(items[0].where, 'departed 강남');
  assert.equal(items[0].dest, '성수종착', 'terminal names are shown as the feed writes them');
  assert.equal(items[0].lon, 127.027583);
  assert.equal(items[0].heading, 0, 'the feed publishes no bearing, so none may be invented');
  // atStation is the resolved name, not the feed string, so clicking that station finds this train.
  assert.equal(items[1].atStation, '천호');
  assert.equal(items[1].where, 'stopped at 천호');
  assert.equal(items[1].dest, '성수', 'a bracketed note on the terminal is dropped');
  assert.ok(items.every((v) => v.attribution.includes('Seoul')));
});

test('a line with nothing running reports nothing, and a failing key says so', () => {
  const f = feed('seoul-metro');
  const table = new Map([['강남', [127.027583, 37.497928]]]);
  const now = Date.parse('2026-09-28T00:56:29.000Z');
  const empty = Transit.parseSeoulPositions({ status: 500, code: 'INFO-200', message: '데이터가 없습니다.' }, f, table, now, new Map());
  assert.equal(empty.length, 0, 'no train right now is not a feed failure');
  assert.throws(() => Transit.parseSeoulPositions({ status: 500, code: 'ERROR-337' }, f, table, now, new Map()), /request limit|feed returned/);
  assert.throws(() => Transit.parseSeoulPositions({ errorMessage: { code: 'INFO-300' } }, f, table, now, new Map()), /request limit/);
});
