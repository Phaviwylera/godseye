/* GOD'S EYE — Netlify Function: /api/proxy + /api/fetch (m3u8-rewriting stream relay).
 * Gives the static deployment the same CORS / mixed-content safe feed access
 * as server.py does locally.
 */
const BLOCKED = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

function valid(u) {
  try {
    const p = new URL(u);
    return (p.protocol === "http:" || p.protocol === "https:") &&
      !BLOCKED.has(p.hostname) && !p.hostname.endsWith(".local");
  } catch { return false; }
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

  const params = event.queryStringParameters || {};
  const url = params.url || "";
  if (!valid(url)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "bad url" }) };
  }
  const isFetch = (event.path || "").includes("/fetch");

  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 GodsEyeCCTV/1.0", Accept: "*/*" },
    });
    const ctype = r.headers.get("content-type") || "application/octet-stream";
    const isHls = url.split("?")[0].toLowerCase().endsWith(".m3u8") || ctype.includes("mpegurl");

    if (isHls) {
      const text = await r.text();
      return {
        statusCode: 200,
        headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
        body: rewriteM3u8(text, url),
      };
    }

    const buf = Buffer.from(await r.arrayBuffer());
    const asText = isFetch || ctype.includes("json") || ctype.includes("text") || buf.length < 2_000_000 && isFetch;
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
