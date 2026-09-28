/* GOD'S EYE — Netlify Function: /api/proxy + /api/fetch (m3u8-rewriting stream relay).
 * Gives the static deployment the same CORS / mixed-content safe feed access
 * as server.py does locally.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
const CACHE = new Map();               // url -> { at, body, ctype }
const INFLIGHT = new Map();            // url -> Promise<{ ok, status, ctype, buf }>
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 512 * 1024;
const WINDOW_MAX_SEC = 900;

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

function cacheGet(url, window) {
  const entry = CACHE.get(url);
  if (!entry) return null;
  if (Date.now() - entry.at >= window * 1000) { CACHE.delete(url); return null; }
  return entry;
}

function cacheSet(url, entry) {
  CACHE.set(url, entry);
  while (CACHE.size > CACHE_MAX_ENTRIES) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0][0];
    CACHE.delete(oldest);
  }
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
      headers: { "User-Agent": "Mozilla/5.0 GodsEyeCCTV/1.0", Accept: "*/*" },
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
    const hit = cacheGet(url, window);
    if (hit) {
      return { statusCode: 200, headers: { ...CORS, "Content-Type": hit.ctype,
        "Cache-Control": "no-store", "X-Cache": "HIT" }, body: hit.body };
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
      cacheSet(url, { at: Date.now(), body: buf.toString("utf8"), ctype });
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
