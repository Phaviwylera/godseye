import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../js/metro.js', import.meta.url), 'utf8');
const Metro = runInNewContext(source + '\nMetro;', {});

const registry = JSON.parse(readFileSync(new URL('../data/metro.json', import.meta.url), 'utf8'));
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const feed = (id) => registry.feeds.find((f) => f.id === id);

test('registry only declares supported adapters and keeps attribution', () => {
  assert.ok(registry.feeds.length >= 3);
  for (const f of registry.feeds) {
    assert.ok(['oba', 'tfl', 'bart'].includes(f.adapter), `unknown adapter ${f.adapter}`);
    assert.ok(['positions', 'arrivals'].includes(f.kind), `unknown kind ${f.kind}`);
    for (const key of ['id', 'network', 'operator', 'city', 'attribution', 'page']) {
      assert.ok(f[key], `${f.id} missing ${key}`);
    }
  }
});

test('the METRO control and chip exist in the UI', () => {
  assert.match(html, /id="btn-metro"/);
  assert.match(html, /id="metro-chip"/);
  assert.match(html, /js\/metro\.js/);
});

test('polyline and TfL line-string geometry decode to [lon, lat] pairs', () => {
  const coords = Metro.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(coords.length, 3);
  assert.equal(coords[0][0].toFixed(1), '-120.2');
  assert.equal(coords[0][1].toFixed(1), '38.5');
  const lines = Metro.parseLineStrings(['[[[-0.090047,51.513132],[-0.11478,51.503299]]]']);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 2);
  assert.equal(lines[0][0][0], -0.090047);
  assert.equal(Metro.parseLineStrings(['not json']).length, 0);
});

test('dark brand colours are lifted so lines stay visible on the globe', () => {
  assert.equal(Metro.readable('#00782A'), '#00782a');
  assert.notEqual(Metro.readable('#000000'), '#000000');   // Northern line black
  assert.equal(Metro.normColor('00782a'), '#00782a');
  assert.equal(Metro.normColor(''), '#7ee0ff');
});

test('OneBusAway route list keeps rail modes and drops buses', () => {
  const payload = {
    data: {
      list: [
        { id: '40_100479', shortName: '1 Line', color: '28813F', type: 0 },
        { id: '40_SNDR_EV', shortName: 'N Line', color: '9AB6D3', type: 2 },
        { id: '40_594', shortName: '594', color: '2b376e', type: 3 },
      ],
    },
  };
  const routes = Metro.parseObaRoutes(payload, feed('st-link'));
  assert.deepEqual(routes.map((r) => r.id), ['40_100479', '40_SNDR_EV']);
  assert.equal(routes[0].color, '#28813f');
});

test('OneBusAway trip payload becomes positioned trains with next-stop detail', () => {
  const payload = {
    data: {
      list: [{
        tripId: '40_TLINE_61',
        status: {
          vehicleId: '40_1',
          position: { lat: 47.26, lon: -122.4535 },
          lastKnownLocation: { lat: 47.26, lon: -122.4535 },
          orientation: 282.8,
          nextStop: '40_T19',
          closestStop: '40_T19',
          nextStopTimeOffset: 120,
          scheduleDeviation: 37,
          lastUpdateTime: 1700000000000,
        },
      }],
      references: {
        trips: [{ id: '40_TLINE_61', tripHeadsign: 'Tacoma Dome Station' }],
        stops: [{ id: '40_T19', name: 'Convention Center/S 15th St', lat: 47.26, lon: -122.4535 }],
        routes: [],
      },
    },
  };
  const route = { id: '40_TLINE', name: 'T Line', color: '#f38b00' };
  const trains = Metro.parseObaTrips(payload, feed('st-link'), route);
  assert.equal(trains.length, 1);
  const [train] = trains;
  assert.equal(train.kind, 'positions');
  assert.equal(train.lat, 47.26);
  assert.equal(train.heading, 282.8);
  assert.equal(train.dest, 'Tacoma Dome Station');
  assert.equal(train.nextStop, 'Convention Center/S 15th St');
  assert.equal(train.etaSec, 120);
  assert.equal(train.delaySec, 37);
  assert.equal(train.attribution, feed('st-link').attribution);
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
  const parsed = Metro.parseTflSequence(payload, feed('tfl'), { id: 'waterloo-city', name: 'Waterloo & City' });
  assert.equal(parsed.lines.length, 1);
  assert.deepEqual([...parsed.stations.map((s) => s.name)], ['Bank', 'Waterloo']);
  assert.deepEqual([...parsed.stations.map((s) => s.id)], ['940GZZLUBNK', '940GZZLUWLO']);
});

test('TfL status keeps the worst severity and its reason', () => {
  const status = Metro.parseTflStatus([{
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
  const trains = Metro.parseTflArrivals(payload, feed('tfl'), stops, meta);
  assert.equal(trains.length, 1, 'unknown stations must be dropped, vehicles merged');
  assert.equal(trains[0].etaSec, 160);
  assert.equal(trains[0].lineName, 'Northern');
  assert.equal(trains[0].nextStop, 'Colindale');
  assert.equal(trains[0].kind, 'arrivals');
});

test('BART stations and routes parse the API quirks (strings, single objects)', () => {
  const stations = Metro.parseBartStations({
    root: { stations: { station: [
      { name: 'Montgomery St.', abbr: 'MONT', gtfs_latitude: '37.7846', gtfs_longitude: '-122.4079' },
      { name: 'Powell St.', abbr: 'POWL', gtfs_latitude: '37.7845', gtfs_longitude: '-122.4078' },
    ] } },
  });
  assert.equal(stations.length, 2);
  assert.equal(stations[0].lat, 37.7846);

  const routes = Metro.parseBartRoutes({
    root: { routes: { route: [
      { name: "Antioch to SF Int'l Airport SFO/Millbrae", abbr: 'ANTC-MLBR', routeID: 'ROUTE 1', number: '1', color: 'YELLOW', hexcolor: '#FFFF33' },
    ] } },
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].colorName, 'YELLOW');
  assert.equal(routes[0].color, '#ffff33');

  const index = new Map(stations.map((s) => [s.abbr, s]));
  const coords = Metro.parseBartRouteInfo({
    root: { routes: { route: { config: { station: ['MONT', 'POWL'] } } } },
  }, feed('bart'), routes[0], index);
  assert.equal(coords[0][0], -122.4079);
  assert.equal(coords[0][1], 37.7846);
});

test('BART departures become station-snapped trains inside the sampling window', () => {
  const stations = new Map([['MONT', { abbr: 'MONT', name: 'Montgomery St.', lat: 37.7846, lon: -122.4079 }]]);
  const routes = new Map([['YELLOW', { number: '1', name: "Antioch to SFO/Millbrae", colorName: 'YELLOW', color: '#ffff33' }]]);
  const payload = {
    root: { station: [{ abbr: 'MONT', etd: [{ destination: 'Antioch', abbreviation: 'ANTC', estimate: [
      { minutes: 'Leaving', platform: '2', direction: 'North', color: 'YELLOW', hexcolor: '#ffff33', delay: '0' },
      { minutes: '28', platform: '2', direction: 'North', color: 'YELLOW', hexcolor: '#ffff33', delay: '0' },
    ] }] }] },
  };
  const trains = Metro.parseBartEtd(payload, feed('bart'), stations, routes, 5);
  assert.equal(trains.length, 1, 'only the departure due within the window is kept');
  assert.equal(trains[0].etaSec, 0);
  assert.equal(trains[0].nextStop, 'Montgomery St.');
  assert.equal(trains[0].dest, 'Antioch');
  assert.equal(trains[0].kind, 'arrivals');
  assert.match(Metro.etaText(trains[0]), /arriving now/);
});
