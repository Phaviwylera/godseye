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
  assert.equal(socket.subscription.BoundingBoxes.length, 5);
  for (const [[north, west], [south, east]] of socket.subscription.BoundingBoxes) {
    assert.ok(north > south && west < east, 'AIS boxes run northwest to southeast');
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
