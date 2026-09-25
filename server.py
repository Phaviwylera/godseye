#!/usr/bin/env python3
"""
GOD'S EYE — tiny zero-dependency server (Python stdlib only).

  * serves the static app (index.html, js, css, vendor, data)
  * GET /api/proxy?url=...   streams relay (fixes mixed-content + CORS for camera
    feeds). Rewrites .m3u8 playlists so segment/key URIs also go through the proxy.
  * GET /api/fetch?url=...   JSON/text passthrough with CORS open (for source APIs
    that do not send CORS headers).
  * GET /api/health

Run:  python3 server.py [port]      (default 8000, binds 0.0.0.0)
"""
import os, re, sys, time, json, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs, quote

ROOT = os.path.dirname(os.path.abspath(__file__))
def _port():
    try:
        return int(sys.argv[1])
    except (IndexError, ValueError):
        return int(os.environ.get("PORT", 8000))

PORT = _port()

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".geojson": "application/geo+json; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".ico": "image/vnd.microsoft.icon", ".woff2": "font/woff2", ".mjs": "text/javascript",
    ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
}

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade"}
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) GodsEyeCCTV/1.0"


def valid_url(url):
    try:
        p = urlparse(url)
        if p.scheme not in ("http", "https"):
            return False
        host = (p.hostname or "").lower()
        if host in ("localhost", "127.0.0.1", "0.0.0.0", "::1") or host.endswith(".local"):
            return False
        return True
    except Exception:
        return False


def rewrite_m3u8(text, base_url):
    """Wrap every URI line of an HLS playlist in the proxy."""
    base = base_url
    out = []
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            if s.startswith("//"):
                s = "https:" + s
            absu = urllib.parse.urljoin(base, s) if not s.startswith("http") else s
            line = "/api/proxy?url=" + quote(absu, safe="")
        elif s.startswith("#") and "URI=" in s:
            def wrap(m):
                u = m.group(1)
                absu = urllib.parse.urljoin(base, u) if not u.startswith("http") else u
                return 'URI="/api/proxy?url=%s"' % quote(absu, safe="")
            line = re.sub(r'URI="([^"]+)"', wrap, line)
        out.append(line)
    return "\n".join(out) + "\n"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "GodsEye/1.0"

    # ---- abuse protection: same-site check + per-IP rate limit ----
    _hits = {}

    def _client_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        def ok(u):
            if not u:
                return True
            try:
                h = urlparse(u).hostname or ""
                return h == host or h in ("localhost", "127.0.0.1") or h.endswith((".netlify.app", ".e2b.app"))
            except Exception:
                return False
        if not ok(self.headers.get("Origin")) or not ok(self.headers.get("Referer")):
            return False
        ip = self.client_address[0]
        now = time.time()
        arr = [t for t in Handler._hits.get(ip, []) if now - t < 60]
        if len(arr) >= 300:
            return False
        arr.append(now)
        Handler._hits[ip] = arr
        if len(Handler._hits) > 5000:
            Handler._hits.clear()
        return True

    def log_message(self, fmt, *args):
        if "/api/proxy" in (args[0] if args else ""):
            return  # stream relay is chatty
        sys.stderr.write("[http] %s\n" % (fmt % args))

    # ------------------------------------------------------------- helpers --
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -------------------------------------------------------------- routes --
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            return self._json({"ok": True, "app": "godseye", "relay": True})
        if path.startswith("/api/") and not self._client_ok():
            return self._json({"error": "cross-site use not allowed / rate limit"}, 403)
        if path == "/api/proxy":
            return self.do_proxy(parse_qs(parsed.query).get("url", [""])[0])
        if path == "/api/fetch":
            return self.do_fetch(parse_qs(parsed.query).get("url", [""])[0])
        return self.do_static(path)

    # ------------------------------------------------------------- proxy ----
    def do_proxy(self, url):
        if not url or not valid_url(url) or len(url) > 2000:
            return self._json({"error": "bad url"}, 400)
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT, "Accept": "*/*",
                "Accept-Encoding": "identity",
            })
            upstream = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        except Exception as e:
            return self._json({"error": str(e)}, 502)

        ctype = upstream.headers.get("Content-Type", "application/octet-stream")
        is_hls = ("mpegurl" in ctype) or url.split("?")[0].lower().endswith((".m3u8", ".m3u"))
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/vnd.apple.mpegurl" if is_hls else ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Upstream-Status", str(upstream.status))

        if is_hls:
            raw_text = upstream.read().decode("utf-8", "replace")
            if not raw_text.lstrip().startswith("#EXTM3U"):
                return self._json({"error": "source-not-streaming",
                                   "detail": raw_text.strip()[:80]}, 404)
            body = rewrite_m3u8(raw_text, url)
            data = body.encode()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        clen = upstream.headers.get("Content-Length")
        if clen:
            self.send_header("Content-Length", clen)
        self.end_headers()
        try:
            while True:
                chunk = upstream.read(16384)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()

    # ------------------------------------------------------------- fetch ----
    def do_fetch(self, url):
        if not url or not valid_url(url) or len(url) > 2000:
            return self._json({"error": "bad url"}, 400)
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*",
                "Accept-Encoding": "gzip",
            })
            upstream = urllib.request.urlopen(req, timeout=30)
            data = upstream.read()
            if data[:2] == b"\x1f\x8b":
                import gzip as _gz
                data = _gz.decompress(data)
            ctype = upstream.headers.get("Content-Type", "application/json; charset=utf-8")
        except Exception as e:
            return self._json({"error": str(e)}, 502)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------ static ----
    def do_static(self, path):
        if path == "/":
            path = "/index.html"
        rel = os.path.normpath(path.lstrip("/"))
        full = os.path.join(ROOT, rel)
        if not full.startswith(ROOT) or not os.path.isfile(full):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "9")
            self.end_headers()
            self.wfile.write(b"not found")
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if ext in (".html", ".geojson", ".json") else "max-age=3600")
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"""
  ╔══════════════════════════════════════════════╗
  ║   G O D ' S   E Y E   —  global cctv grid    ║
  ║   serving  http://0.0.0.0:{PORT:<5}             ║
  ╚══════════════════════════════════════════════╝""")
    Server(("0.0.0.0", PORT), Handler).serve_forever()
