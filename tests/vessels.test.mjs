import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVessel, collect } from '../netlify/functions/ais-collector.mjs';
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
  assert.equal(vessels.length, 1);
  assert.equal(socket.closed, true);
});
