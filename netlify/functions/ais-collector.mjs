/* One shared AISStream connection per scheduled run; never expose the provider key. */
import WebSocket from 'ws';
import { getStore } from '@netlify/blobs';

export const config = { schedule: '*/2 * * * *' };
const URL = 'wss://stream.aisstream.io/v0/stream';
// AISStream corners are [latitude, longitude]. Focus on busy shipping corridors.
const BOXES = [
  [[12.5, 79.0], [15.2, 82.0]],       // Chennai
  [[0.8, 102.8], [2.4, 105.0]],       // Singapore Strait
  [[51.3, 3.3], [52.2, 4.9]],         // Rotterdam
  [[40.3, -74.7], [41.1, -73.2]],     // New York
  [[33.3, -119.0], [34.3, -117.6]],   // Los Angeles
];
const TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'];
const accepted = new Set(TYPES);

export function parseVessel(data, received = Date.now()) {
  if (!data || !accepted.has(data.MessageType)) return null;
  const meta = data.MetaData || {};
  const report = data.Message?.[data.MessageType] || {};
  if (report.Valid === false) return null;
  const lat = Number(meta.Latitude ?? report.Latitude);
  const lon = Number(meta.Longitude ?? report.Longitude);
  const mmsi = String(meta.MMSI ?? report.UserID ?? '');
  if (!/^\d{9}$/.test(mmsi) || !Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const speed = Number(report.Sog), course = Number(report.Cog);
  return { mmsi, name: String(meta.ShipName || '').trim().slice(0, 70) || `MMSI ${mmsi}`,
    lat, lon, speed: Number.isFinite(speed) && speed >= 0 && speed < 102.3 ? speed : null,
    course: Number.isFinite(course) && course >= 0 && course < 360 ? course : null,
    received: new Date(received).toISOString() };
}

export async function collect(key, durationMs = 18000, connect = (url, options) => new WebSocket(url, options)) {
  return new Promise((resolve, reject) => {
    const vessels = new Map();
    let settled = false, opened = false, confirmed = false;
    const ws = connect(URL, { perMessageDeflate: true, handshakeTimeout: 4000 });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (error || !confirmed) reject(error || new Error('AIS subscription was not confirmed'));
      else resolve([...vessels.values()].slice(0, 1200));
    };
    const timer = setTimeout(() => finish(opened ? null : new Error('AIS connection timed out')), durationMs);
    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: BOXES, FilterMessageTypes: TYPES }));
    });
    ws.on('message', raw => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.MessageType === 'SubscriptionConfirmation') confirmed = true;
        const vessel = parseVessel(frame);
        if (vessel) vessels.set(vessel.mmsi, vessel);
      } catch { /* malformed provider frame */ }
    });
    ws.on('error', () => finish(new Error('AIS connection failed')));
    ws.on('close', () => finish(opened && confirmed ? null : new Error('AIS connection closed before confirmation')));
  });
}

export default async () => {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) { console.warn('AISSTREAM_API_KEY is not configured'); return; }
  try {
    const vessels = await collect(key);
    const snapshot = { observed: new Date().toISOString(), vessels };
    await getStore({ name: 'ais-vessels', consistency: 'strong' }).setJSON('latest', snapshot);
    console.log(`Stored ${vessels.length} AIS vessel observations`);
  } catch (error) {
    console.error('AIS collector failed:', error.message);
    // Preserve the last valid snapshot; the reader rejects it when stale.
  }
};
