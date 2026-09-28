import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVessel, collect, attachObservedTracks } from '../netlify/functions/ais-collector.mjs';
import { EventEmitter } from 'node:events';

const message = { MessageType: 'PositionReport', MetaData: { MMSI: 368207620, ShipName: 'TEST VESSEL', Latitude: 25.7617, Longitude: -80.1918 }, Message: { PositionReport: { Valid: true, Sog: 12.4, Cog: 86.7 } } };
test('AIS frames retain valid positions and reject invalid or non-vessel messages', () => {
  assert.equal(parseVessel(message).mmsi, '368207620');
  assert.equal(parseVessel({ ...message, MetaData: { ...message.MetaData, Latitude: 91 } }), null);
  assert.equal(parseVessel({ ...message, MessageType: 'SubscriptionConfirmation' }), null);
  assert.equal(parseVessel({ ...message, Message: { PositionReport: { Valid: false } } }), null);
});
test('collector subscribes once with server key, deduplicates vessels, and closes', async () => {
  class FakeSocket extends EventEmitter {
    send(data) { this.subscription = JSON.parse(data); this.emit('message', Buffer.from(JSON.stringify({ MessageType: 'SubscriptionConfirmation' }))); this.emit('message', Buffer.from(JSON.stringify(message))); }
    close() { this.closed = true; }
  }
  const socket = new FakeSocket();
  const promise = collect('test-key', 10, () => socket);
  socket.emit('open');
  const vessels = await promise;
  assert.equal(socket.subscription.APIKey, 'test-key');
  assert.equal(socket.subscription.BoundingBoxes.length, 10);
  for (const [[north, west], [south, east]] of socket.subscription.BoundingBoxes) {
    assert.ok(north > south && west < east, 'AIS boxes run northwest to southeast');
  }
  // The five chokepoints must be listened on as well, not just drawn.
  const flat = JSON.stringify(socket.subscription.BoundingBoxes);
  for (const [name, box] of [
    ['Hormuz', [[27.1, 56.2], [26.3, 58.9]]],
    ['Suez', [[31.35, 32.1], [29.95, 33.0]]],
    ['Panama', [[9.55, -80.1], [8.95, -79.55]]],
    ['Gibraltar', [[36.35, -6.0], [35.75, -4.6]]],
  ]) {
    assert.ok(flat.includes(JSON.stringify(box)), 'missing corridor box: ' + name);
  }
  assert.equal(vessels.length, 1);
  assert.equal(socket.closed, true);
});
test('trails use observed points, discard old history, and ignore stationary repeats', () => {
  const at = Date.parse('2026-09-27T03:00:00Z');
  const first = { mmsi: '368207620', lon: 80, lat: 13, received: new Date(at).toISOString() };
  const old = [[79, 12, new Date(at - 31 * 60000).toISOString()]];
  const one = attachObservedTracks([first], { history: { [first.mmsi]: old } }, at);
  assert.deepEqual(one.vessels[0].track, [[80, 13, first.received]]);
  const gap = attachObservedTracks([], one, at + 60000);
  const still = attachObservedTracks([first], gap, at + 120000);
  assert.equal(still.vessels[0].track.length, 1);
  const moved = { ...first, lon: 80.003, received: new Date(at + 120000).toISOString() };
  const two = attachObservedTracks([moved], still, at + 120000);
  assert.deepEqual(two.vessels[0].track.map(point => point.slice(0, 2)), [[80, 13], [80.003, 13]]);
});
