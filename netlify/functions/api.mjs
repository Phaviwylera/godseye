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

  try {
    let r;
    let current = url;
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (!await safeTarget(current)) return { statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: "unsafe source address" }) };
        r = await fetch(current, {
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Mozilla/5.0 GodsEyeCCTV/1.0", Accept: "*/*" },
        });
        if (![301, 302, 303, 307, 308].includes(r.status)) break;
        const location = r.headers.get("location");
        if (!location || redirects === 3) return { statusCode: 502, headers: CORS,
          body: JSON.stringify({ error: "source redirect limit" }) };
        current = new URL(location, current).href;
      }
    } catch (te) {
      return { statusCode: 504, headers: CORS,
        body: JSON.stringify({ error: "source-timeout-or-unreachable", detail: String(te) }) };
    }
    if (!r.ok) return { statusCode: r.status >= 400 && r.status < 600 ? r.status : 502,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "source returned HTTP " + r.status }) };
    const ctype = r.headers.get("content-type") || "application/octet-stream";
    const isHls = current.split("?")[0].toLowerCase().endsWith(".m3u8") || ctype.includes("mpegurl");
    const buf = await readLimited(r);

    if (isHls) {
      const text = buf.toString("utf8");
      // agencies return "Not Found"/empty bodies for offline cams — say so honestly
      // instead of rewriting garbage into a fake playlist
      if (!text.trimStart().startsWith("#EXTM3U")) {
        return {
          statusCode: 404,
          headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
          body: JSON.stringify({ error: "source-not-streaming", detail: text.trim().slice(0, 80) }),
        };
      }
      return {
        statusCode: 200,
        headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
        body: rewriteM3u8(text, current),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": ctype, "Cache-Control": "no-store" },
      body: (isFetch || ctype.includes("json") || ctype.includes("text") || ctype.includes("xml") || ctype.includes("csv"))
        ? buf.toString("utf8") : buf.toString("base64"),
      isBase64Encoded: !(isFetch || ctype.includes("json") || ctype.includes("text") || ctype.includes("xml") || ctype.includes("csv")),
    };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: String(e) }) };
  }
}
