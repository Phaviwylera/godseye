/* Public read-only, bounded, recent AIS observations. No provider credential. */
import { getStore } from '@netlify/blobs';

export default async (request) => {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  try {
    const snapshot = await getStore({ name: 'ais-vessels', consistency: 'strong' }).get('latest', { type: 'json' });
    const age = Date.now() - Date.parse(snapshot?.observed);
    if (!snapshot || !Number.isFinite(age) || age < 0 || age > 5 * 60 * 1000) {
      return Response.json({ status: 'unavailable', vessels: [] }, { status: 503,
        headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json({ status: 'recent', observed: snapshot.observed, vessels: snapshot.vessels },
      { headers: { 'Cache-Control': 'public, max-age=20, s-maxage=30' } });
  } catch {
    return Response.json({ status: 'unavailable', vessels: [] }, { status: 503,
      headers: { 'Cache-Control': 'no-store' } });
  }
};
