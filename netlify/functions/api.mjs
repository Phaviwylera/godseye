/* GOD'S EYE — Netlify Function: /api/proxy + /api/fetch (m3u8-rewriting stream relay).
 * Gives the static deployment the same CORS / mixed-content safe feed access
 * as server.py does locally.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const BLOCKED = new Set(["localhost", "0.0.0.0", "::1"]);
const MAX_BYTES = 16 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

/* ---- abuse protection: same-site origin check + per-IP rate limit ---- */
const HITS = new Map();
function rateOK(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 300) return false; // 300 relayed requests / minute / IP (HLS playback needs it)
  arr.push(now);
  HITS.set(ip, arr);
  if (HITS.size > 5000) HITS.clear();
  return true;
}
function siteOK(headers) {
  const host = String(headers.host || "").split(":")[0];
  const check = (u) => {
    if (!u) return true;
    try {
      const h = new URL(u).hostname;
      return h === host || h.endsWith(".netlify.app") || h.endsWith(".e2b.app") ||
             h === "localhost" || h === "127.0.0.1";
    } catch { return false; }
  };
  return check(headers.origin) && check(headers.referer);
}

function valid(u) {
  try {
    const p = new URL(u);
    return (p.protocol === "http:" || p.protocol === "https:") &&
      !p.username && !p.password && !BLOCKED.has(p.hostname) &&
      !p.hostname.endsWith(".local") && !p.hostname.endsWith(".internal") &&
      !p.hostname.endsWith(".localhost");
  } catch { return false; }
}

export function publicIP(address) {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(ip) === 6) {
    if (ip.includes(".")) return false; // reject mapped IPv4 forms
    return !(ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") ||
      /^fe[89ab]/.test(ip) || ip.startsWith("2001:db8:"));
  }
  return false;
}

async function safeTarget(url) {
  if (!valid(url)) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return publicIP(host);
  const addresses = await lookup(host, { all: true });
  return addresses.length > 0 && addresses.every(({ address }) => publicIP(address));
}

async function readLimited(response) {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_BYTES) throw new Error("source-too-large");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("source-too-large");
      chunks.push(Buffer.from(value));
    }
  } finally { reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, size);
}

function rewriteM3u8(text, base) {
  const out = text.split(/\r?\n/).map((line) => {
    const s = line.trim();
    if (s && !s.startsWith("#")) {
      const abs = new URL(s, base).href;
      return "/api/proxy?url=" + encodeURIComponent(abs);
    }
    return line.replace(/URI="([^"]+)"/g, (_m, u) =>
      `URI="/api/proxy?url=${encodeURIComponent(new URL(u, base).href)}"`);
  });
  return out.join("\n") + "\n";
}

/* ---- shared upstream cache (JSON only, small, short-lived, single-flight) ----
 * Quota-limited operator feeds are spent once for the whole site instead of once per visitor:
 * a caller that passes ?window=N gets the same bytes as anybody else who asked for that URL in
 * the last N seconds, and concurrent identical requests share one upstream fetch. Only an
 * HTTP-200 JSON body under 512 KB is ever stored — never a playlist, never an error envelope,
 * never a relay-level failure — so a cached answer can only ever be an answer the operator
 * really gave.
 */
const CACHE = new Map();               // warm instance: url -> { at, body, ctype }
const INFLIGHT = new Map();            // warm instance: url -> Promise<{ ok, status, ctype, buf }>
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 512 * 1024;
const WINDOW_MAX_SEC = 900;

/* Memory makes repeat reads on one warm function cheap. Blobs is the authoritative
 * read-through tier across Netlify instances and cold starts.  It is deliberately
 * restricted to the small set of operator APIs that use a cache window: otherwise
 * this public relay could be used to create an unbounded persistent key space. */
const PERSISTENT_CACHE_HOSTS = new Set([
  'swopenapi.seoul.go.kr', 'api-v3.mbta.com', 'rata.digitraffic.fi',
  'transport.opendata.ch', 'api.irail.be', 'api.adsb.lol',
]);
const RELAY_CACHE_STORE = 'relay-json-cache-v1';
let relayBlobStore; // undefined = lazily create the real store; null = disabled in tests

/* Test hook: production code never supplies a store and always uses Netlify Blobs. */
export function setRelayBlobStoreForTest(store) { relayBlobStore = store; }
export function resetFirmsCacheForTest() { firmsCache = null; }
export function resetRelayCacheForTest() { CACHE.clear(); INFLIGHT.clear(); }

function windowSec(param) {
  const n = Number(param);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(WINDOW_MAX_SEC, Math.round(n));
}

/* An operator's refusal (Seoul's {"errorMessage":{"code":"INFO-300"}}) is HTTP 200 but must
 * not be pinned for the whole window: caching it would keep a recovered key locked out. */
function cacheable(text) {
  if (!text || text.length > CACHE_MAX_BYTES) return false;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return parsed.error == null && parsed.errorMessage == null;
}

function cacheGetMemory(url, window) {
  const entry = CACHE.get(url);
  if (!entry) return null;
  if (Date.now() - entry.at >= window * 1000) { CACHE.delete(url); return null; }
  return entry;
}

function cacheSetMemory(url, entry) {
  CACHE.set(url, entry);
  while (CACHE.size > CACHE_MAX_ENTRIES) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0][0];
    CACHE.delete(oldest);
  }
}

function persistentCacheAllowed(url) {
  try { return PERSISTENT_CACHE_HOSTS.has(new URL(url).hostname.toLowerCase()); }
  catch { return false; }
}

function relayCacheKey(url) {
  return 'v1/' + createHash('sha256').update(url).digest('hex');
}

function relayStore() {
  if (relayBlobStore !== undefined) return relayBlobStore;
  try {
    relayBlobStore = getStore({ name: RELAY_CACHE_STORE, consistency: 'strong' });
  } catch {
    relayBlobStore = null;
  }
  return relayBlobStore;
}

function validCacheEntry(entry, window) {
  if (!entry || !Number.isFinite(entry.at) || typeof entry.body !== 'string' ||
      typeof entry.ctype !== 'string' || Date.now() - entry.at >= window * 1000) return null;
  // A corrupt or old-format Blob must never turn into an answer, and the same
  // no-error-envelope rule is enforced on read as well as write.
  return cacheable(entry.body) ? entry : null;
}

async function cacheGet(url, window) {
  const warm = cacheGetMemory(url, window);
  if (warm) return { entry: warm, tier: 'memory' };
  if (!persistentCacheAllowed(url)) return null;
  try {
    const store = relayStore();
    const saved = store && await store.get(relayCacheKey(url), { type: 'json' });
    const entry = validCacheEntry(saved, window);
    if (!entry) return null;
    cacheSetMemory(url, entry);
    return { entry, tier: 'blob' };
  } catch {
    // Blob availability is an optimisation, never a relay failure.
    return null;
  }
}

async function cacheSet(url, entry) {
  cacheSetMemory(url, entry);
  if (!persistentCacheAllowed(url)) return;
  try {
    const store = relayStore();
    if (store) await store.setJSON(relayCacheKey(url), entry);
  } catch {
    // The caller still receives the verified upstream answer from this request.
  }
}

/* NASA FIRMS fire hotspots (world, last day). The free MAP_KEY stays inside
 * the Function (env FIRMS_MAP_KEY) exactly like the OpenSky credentials: the
 * browser only ever sees the CSV, never the key. One upstream call per
 * instance per 15 minutes. Without the key the route answers 501 and the
 * client shows a labelled "FIRES · KEY PENDING" state instead of a feed. */
const FIRMS_TTL_MS = 15 * 60 * 1000;
let firmsCache = null; // { at, ctype, buf }

/* /gdelt: one GDELT DOC 2.0 PointData sweep per instance per 15 minutes.
 * Keyless upstream; the query is fixed and small (one OR-of-headlines for
 * conflict/disaster terms) so the response stays a GeoJSON of geolocated
 * articles. GDELT's own limit is one request per 5 seconds — a 15-minute
 * TTL keeps us far under it. */
const GDELT_TTL_MS = 15 * 60 * 1000;
const GDELT_QUERY = 'attack OR airstrike OR bombing OR explosion OR missile OR shelling OR arrest OR riot OR protest OR earthquake OR tsunami OR flood OR wildfire OR coup OR ceasefire OR election OR conflict';
let gdeltCache = null; // { at, buf }

/* /worldbank: ten keyless country indicators in one bounded relay call.
 * The World Bank API answers one indicator per request, so we fan out
 * concurrently and merge; one hour of cache per country. */
const WORLD_BANK_TTL_MS = 60 * 60 * 1000;
const WORLD_BANK_INDICATORS = [
  "NY.GDP.MKTP.CD", "NY.GDP.PCAP.CD", "SP.POP.TOTL", "FP.CPI.TOTL.ZG",
  "SL.UEM.TOTL.ZS", "SP.DYN.LE00.IN", "IT.NET.USER.ZS", "MS.XPD.TOTL.GD.ZS",
  "EG.USE.ELEC.KH.PC", "SH.TOT.MRTS",
];
const worldBankCache = new Map(); // cc -> { at, body }

async function worldbankRoute(cc) {
  if (!/^[A-Z]{2}$/.test(cc)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "bad country code" }) };
  }
  const hit = worldBankCache.get(cc);
  if (hit && Date.now() - hit.at < WORLD_BANK_TTL_MS) {
    return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json",
      "Cache-Control": "no-store", "X-Cache": "HIT" }, body: hit.body };
  }
  const base = `https://api.worldbank.org/v2/country/${cc}/indicator/`;
  const results = await Promise.all(WORLD_BANK_INDICATORS.map(async (id) => {
    try {
      const up = await fetchUpstream(base + id + "?format=json&per_page=1&sort=desc");
      if (up.failure) return null;
      const doc = JSON.parse(up.buf.toString("utf8"));
      const rows = Array.isArray(doc) && Array.isArray(doc[1]) ? doc[1] : [];
      const row = rows.find(r => Number.isFinite(Number(r.value)));
      if (!row) return null;
      return {
        id,
        name: row.indicator && row.indicator.value,
        value: Number(row.value),
        date: String(row.date),
        country: row.country && row.country.value,
        iso3: row.countryiso3code || null,
      };
    } catch { return null; }
  }));
  const ok = results.filter(Boolean);
  if (!ok.length) {
    return { statusCode: 502, headers: CORS,
      body: JSON.stringify({ error: "worldbank-unavailable" }) };
  }
  const body = JSON.stringify({
    country: ok[0].country || cc,
    iso2: cc,
    iso3: ok.find(r => r.iso3).iso3 || null,
    indicators: ok,
  });
  worldBankCache.set(cc, { at: Date.now(), body });
  return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json",
    "Cache-Control": "no-store", "X-Cache": "MISS" }, body };
}

async function gdeltRoute() {
  if (gdeltCache && Date.now() - gdeltCache.at < GDELT_TTL_MS) {
    return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/geo+json",
      "Cache-Control": "no-store", "X-Cache": "HIT" }, body: gdeltCache.buf };
  }
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc?' +
    new URLSearchParams({
      query: GDELT_QUERY, mode: "PointData", format: "GeoJSON",
      timespan: "1440m", maxrecords: "250",
    }).toString();
  let upstream;
  try {
    upstream = await fetchUpstream(url);
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: String(e) }) };
  }
  if (upstream.failure) {
    return { statusCode: upstream.failure.statusCode, headers: { ...CORS, "Content-Type": "application/json", "X-Cache": "SKIP" },
      body: upstream.failure.body };
  }
  const { buf } = upstream;
  if (buf.length > 8 * 1024 * 1024) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "source-too-large" }) };
  }
  // GDELT signals throttling with 200 + prose; keep the last good sweep then.
  let doc = null;
  try { doc = JSON.parse(buf.toString("utf8")); } catch { doc = null; }
  if (!doc || !Array.isArray(doc.features)) {
    if (gdeltCache) {
      return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/geo+json",
        "Cache-Control": "no-store", "X-Cache": "STALE" }, body: gdeltCache.buf };
    }
    return { statusCode: 502, headers: CORS,
      body: JSON.stringify({ error: "gdelt-unavailable",
        detail: buf.toString("utf8", 0, 120) }) };
  }
  gdeltCache = { at: Date.now(), buf: buf.toString("utf8") };
  return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/geo+json",
    "Cache-Control": "no-store", "X-Cache": "MISS" }, body: gdeltCache.buf };
}

/* FIRMS answers a bad MAP_KEY, an exhausted quota or a malformed request with
 * HTTP 200 and a line of prose (sometimes typed text/csv). Only a body whose
 * first non-empty line is a header naming both coordinate columns is a sweep;
 * prose is reported as the upstream error it is and never cached as fires. */
export function isFirmsCsv(text) {
  for (const line of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = new Set(line.split(",").map((c) => c.trim().replace(/^"|"$/g, "").toLowerCase()));
    return cells.has("latitude") && cells.has("longitude");
  }
  return false;
}

/* Test hook: the FIRMS product URL is fixed in production (world, last day);
 * tests point it at a stub upstream so the format gate is exercised offline. */
let firmsUrlForTest = null;
export function setFirmsUrlForTest(url) { firmsUrlForTest = url; }

async function firesRoute() {
  const key = String(process.env.FIRMS_MAP_KEY || "").trim();
  if (firmsCache && Date.now() - firmsCache.at < FIRMS_TTL_MS) {
    return { statusCode: 200, headers: { ...CORS, "Content-Type": firmsCache.ctype,
      "Cache-Control": "no-store", "X-Cache": "HIT" }, body: firmsCache.buf.toString("utf8") };
  }
  const url = firmsUrlForTest ||
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/VIIRS_NOAA21_NRT/world/1`;
  let upstream;
  try {
    upstream = await fetchUpstream(url);
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: String(e) }) };
  }
  if (upstream.failure) {
    return { statusCode: upstream.failure.statusCode,
      headers: { ...CORS, "Content-Type": "application/json", "X-Cache": "SKIP" },
      body: upstream.failure.body };
  }
  const { ctype, buf } = upstream;
  if (buf.length > 16 * 1024 * 1024) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "source-too-large" }) };
  }
  const text = buf.toString("utf8");
  if (!isFirmsCsv(text)) {
    const detail = text.replace(/\s+/g, " ").slice(0, 160);
    if (firmsCache) {
      return { statusCode: 200, headers: { ...CORS, "Content-Type": firmsCache.ctype,
        "Cache-Control": "no-store", "X-Cache": "STALE", "X-Source-Error": detail.slice(0, 120) },
        body: firmsCache.buf.toString("utf8") };
    }
    return { statusCode: 502, headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "firms-upstream-error", detail }) };
  }
  firmsCache = { at: Date.now(), ctype, buf };
  return { statusCode: 200, headers: { ...CORS, "Content-Type": ctype,
    "Cache-Control": "no-store", "X-Cache": "MISS" }, body: buf.toString("utf8") };
}

/* OpenSky has required OAuth2 client credentials since 2026-03-18. Credentials
 * are read only in the Function and are attached exclusively to its API host;
 * neither browser code nor responses can expose them. Anonymous calls still work. */
const OPENSKY_HOSTS = new Set(['opensky-network.org', 'api.opensky-network.org']);
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
let openskyToken = null;
let openskyTokenFlight = null;

async function openSkyAccessToken() {
  if (openskyToken && openskyToken.expiresAt > Date.now() + 60_000) return openskyToken.value;
  if (openskyTokenFlight) return openskyTokenFlight;
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  openskyTokenFlight = (async () => {
    const response = await fetch(OPENSKY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('opensky token unavailable');
    const payload = await response.json();
    if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new Error('opensky token invalid');
    }
    const lifetime = Math.max(60, Number(payload.expires_in) || 300);
    openskyToken = { value: payload.access_token, expiresAt: Date.now() + lifetime * 1000 };
    return openskyToken.value;
  })().catch(() => null).finally(() => { openskyTokenFlight = null; });
  return openskyTokenFlight;
}

export function resetOpenSkyAuthForTest() { openskyToken = null; openskyTokenFlight = null; }
export async function upstreamHeadersForTest(url) { return upstreamHeaders(url); }

async function upstreamHeaders(url) {
  const headers = { 'User-Agent': 'Mozilla/5.0 GodsEyeCCTV/1.0', Accept: '*/*' };
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return headers; }
  if (OPENSKY_HOSTS.has(host)) {
    const token = await openSkyAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/* Follow redirects by hand so every hop is address-checked before it is fetched. */
async function fetchUpstream(url) {
  let r;
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!await safeTarget(current)) {
      return { failure: { statusCode: 400, body: JSON.stringify({ error: "unsafe source address" }) } };
    }
    r = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: await upstreamHeaders(current),
    }).catch((te) => { throw Object.assign(new Error("source-timeout-or-unreachable"), { detail: String(te), timeout: true }); });
    if (![301, 302, 303, 307, 308].includes(r.status)) break;
    const location = r.headers.get("location");
    if (!location || redirects === 3) {
      return { failure: { statusCode: 502, body: JSON.stringify({ error: "source redirect limit" }) } };
    }
    current = new URL(location, current).href;
  }
  if (!r.ok) {
    return { failure: { statusCode: r.status >= 400 && r.status < 600 ? r.status : 502,
      body: JSON.stringify({ error: "source returned HTTP " + r.status }), json: true } };
  }
  const ctype = r.headers.get("content-type") || "application/octet-stream";
  const isHls = current.split("?")[0].toLowerCase().endsWith(".m3u8") || ctype.includes("mpegurl");
  return { current, ctype, isHls, buf: await readLimited(r) };
}

const TEXTUAL = (ctype) => ctype.includes("json") || ctype.includes("text") ||
  ctype.includes("xml") || ctype.includes("csv") || ctype.includes("javascript");

/* Seoul's public sample endpoint accepts exactly these documented line identifiers.
 * This endpoint takes no URL, key or line parameter from the browser: callers cannot
 * repurpose the batch worker as an arbitrary multi-fetch primitive. */
const SEOUL_LINES = ['1호선', '2호선', '3호선', '4호선', '5호선', '6호선', '7호선', '8호선', '9호선',
  '경의중앙선', '수인분당선', '신분당선', '공항철도', '우이신설선', '서해선', '신림선'];
const SEOUL_BASE = process.env.SEOUL_SUBWAY_BASE ||
  'http://swopenapi.seoul.go.kr/api/subway/sample/json/realtimePosition/0/5/';
const SEOUL_WINDOW_SEC = 1500;
const SEOUL_HITS = new Map();

function seoulBatchRateOK(ip) {
  const now = Date.now();
  const arr = (SEOUL_HITS.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= 12) return false; // this one request fans out to 16 operator reads at most
  arr.push(now); SEOUL_HITS.set(ip, arr);
  if (SEOUL_HITS.size > 5000) SEOUL_HITS.clear();
  return true;
}

async function windowedJson(url, window) {
  const hit = await cacheGet(url, window);
  if (hit) return JSON.parse(hit.entry.body);
  let upstream;
  if (!INFLIGHT.has(url)) INFLIGHT.set(url, fetchUpstream(url).finally(() => INFLIGHT.delete(url)));
  upstream = await INFLIGHT.get(url);
  if (upstream.failure) throw new Error('unavailable');
  if (upstream.isHls || !TEXTUAL(upstream.ctype)) throw new Error('unavailable');
  const text = upstream.buf.toString('utf8');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('unavailable'); }
  if (cacheable(text)) await cacheSet(url, { at: Date.now(), body: text, ctype: upstream.ctype });
  return data;
}

async function seoulBatch() {
  const lines = {};
  let cursor = 0;
  const read = async () => {
    while (cursor < SEOUL_LINES.length) {
      const line = SEOUL_LINES[cursor++];
      const url = SEOUL_BASE + encodeURIComponent(line);
      try {
        lines[line] = { data: await windowedJson(url, SEOUL_WINDOW_SEC) };
      } catch {
        // Do not place a relay error envelope in any cache.  The client can retain
        // its previous valid rows and explain that this particular line was unavailable.
        lines[line] = { error: 'unavailable' };
      }
    }
  };
  await Promise.all([read(), read(), read(), read()]); // bound upstream fan-out to four
  return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json',
    'Cache-Control': 'no-store', 'X-Cache': 'BATCH' }, body: JSON.stringify({ lines }) };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const headers = event.headers || {};
  const ip = headers["x-nf-client-connection-ip"] ||
    String(headers["x-forwarded-for"] || "").split(",")[0] || "anon";
  if (!siteOK(headers)) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "cross-site use not allowed" }) };
  }
  if (!rateOK(ip)) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: "rate limit — slow down" }) };
  }

  const params = event.queryStringParameters || {};
  const path = event.path || "";
  if (path.includes('/fires')) {
    if (!process.env.FIRMS_MAP_KEY) {
      return { statusCode: 501, headers: CORS,
        body: JSON.stringify({ error: "firms-key-pending",
          hint: "free key at https://firms.modaps.eosdis.nasa.gov/api -> Netlify env FIRMS_MAP_KEY" }) };
    }
    return firesRoute();
  }
  if (path.includes('/gdelt')) {
    return gdeltRoute();
  }
  if (path.includes('/worldbank')) {
    return worldbankRoute(String(params.cc || "").toUpperCase());
  }
  if (path.includes('/transit/seoul')) {
    if (!seoulBatchRateOK(ip)) {
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'rate limit — slow down' }) };
    }
    return seoulBatch();
  }
  const url = params.url || "";
  // health/liveness probe (and anything without a url) → report relay status
  if (!url) {
    return { statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, app: "godseye", relay: true }) };
  }
  if (!valid(url) || url.length > 2000) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "bad url" }) };
  }
  const isFetch = (event.path || "").includes("/fetch");
  // ?encoding=base64 is how a binary feed (GTFS-Realtime) survives the trip as text
  const asBase64 = params.encoding === "base64";
  const window = isFetch && !asBase64 ? windowSec(params.window) : 0;

  if (window) {
    const hit = await cacheGet(url, window);
    if (hit) {
      return { statusCode: 200, headers: { ...CORS, "Content-Type": hit.entry.ctype,
        "Cache-Control": "no-store", "X-Cache": "HIT", "X-Cache-Tier": hit.tier }, body: hit.entry.body };
    }
  }

  try {
    /* Concurrent identical requests share one upstream fetch: 40 tabs opening the map at
     * once must cost the operator one request, not forty. */
    let upstream;
    if (window) {
      if (!INFLIGHT.has(url)) {
        INFLIGHT.set(url, fetchUpstream(url).finally(() => INFLIGHT.delete(url)));
      }
      upstream = await INFLIGHT.get(url);
    } else {
      upstream = await fetchUpstream(url);
    }

    if (upstream.failure) {
      // a relay-level failure is never cached: the next visitor gets a fresh attempt
      return { statusCode: upstream.failure.statusCode,
        headers: { ...CORS, "Content-Type": "application/json", "X-Cache": "SKIP" },
        body: upstream.failure.body };
    }

    const { ctype, isHls, buf, current } = upstream;

    if (isHls) {
      const text = buf.toString("utf8");
      // agencies return "Not Found"/empty bodies for offline cams — say so honestly
      // instead of rewriting garbage into a fake playlist
      if (!text.trimStart().startsWith("#EXTM3U")) {
        return {
          statusCode: 404,
          headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Cache": "SKIP" },
          body: JSON.stringify({ error: "source-not-streaming", detail: text.trim().slice(0, 80) }),
        };
      }
      return {
        statusCode: 200,
        headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", "X-Cache": "SKIP" },
        body: rewriteM3u8(text, current),
      };
    }

    const text = TEXTUAL(ctype) || (isFetch && !asBase64) ? buf.toString("utf8") : buf.toString("base64");
    if (window && TEXTUAL(ctype) && cacheable(buf.toString("utf8"))) {
      await cacheSet(url, { at: Date.now(), body: buf.toString("utf8"), ctype });
    }
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": ctype, "Cache-Control": "no-store",
        "X-Cache": window ? "MISS" : "SKIP" },
      body: asBase64 ? buf.toString("base64") : text,
      isBase64Encoded: asBase64 || (!TEXTUAL(ctype) && !isFetch),
    };
  } catch (e) {
    if (e && e.timeout) {
      return { statusCode: 504, headers: { ...CORS, "X-Cache": "SKIP" },
        body: JSON.stringify({ error: "source-timeout-or-unreachable", detail: e.detail }) };
    }
    return { statusCode: 502, headers: { ...CORS, "X-Cache": "SKIP" }, body: JSON.stringify({ error: String(e) }) };
  }
}
