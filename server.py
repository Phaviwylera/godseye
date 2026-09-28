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
import os, re, sys, time, json, base64, threading, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
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


def _ascii_host(authority):
    """IDNA-encode a non-ASCII host, keeping any userinfo and port around it."""
    userinfo, sep, hostport = authority.rpartition("@")
    if hostport.startswith("["):                      # IPv6 literal: leave it alone
        host, colon, port = hostport.partition("]:")
        host += "]"
        port = (":" + port) if colon else ""
    else:
        host, colon, port = hostport.rpartition(":")
        if not host:                                  # no port at all
            host, port = hostport, ""
        else:
            port = ":" + port
    try:
        host.encode("ascii")
    except UnicodeEncodeError:
        try:
            host = host.encode("idna").decode("ascii")
        except (UnicodeError, UnicodeDecodeError):
            host = quote(host, safe="")
    return (userinfo + "@" if sep else "") + host + port


def encode_iri(url):
    """Percent-encode an IRI so urllib can put it on the wire.

    parse_qs hands us a percent-*decoded* URL and http.client writes the request line as
    ASCII, so any target carrying a non-ASCII character — a Korean camera path, say — used to
    die with "'ascii' codec can't encode characters" and look exactly like the operator being
    down. Already-encoded sequences are left alone ('%' is safe) so this never double-encodes.
    """
    try:
        url.encode("ascii")
        return url
    except UnicodeEncodeError:
        pass
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    netloc = _ascii_host(parts.netloc) if parts.netloc else parts.netloc
    return urllib.parse.urlunsplit((
        parts.scheme,
        netloc,
        quote(parts.path, safe="/%:@&=+$,;~!*'()"),
        quote(parts.query, safe="=&%:@/?+,;$~!*'()"),
        quote(parts.fragment, safe="%:@&=+$,;~!*'()/"),
    ))


# ---- shared upstream cache (mirrors netlify/functions/api.mjs) -----------------
# Quota-limited operator feeds are spent once for the whole app instead of once per visitor.
# Only an HTTP-200 JSON body under 512 KB is ever stored: never a playlist, never an error
# envelope, never a relay-level failure.
CACHE = {}                 # url -> {"at": float, "ctype": str, "data": bytes}
INFLIGHT = {}              # url -> {"event": Event, "result": tuple|None, "error": Exception|None}
CACHE_LOCK = threading.Lock()
CACHE_MAX_ENTRIES = 64
CACHE_MAX_BYTES = 512 * 1024
WINDOW_MAX_SEC = 900

# The browser calls one bounded endpoint for Seoul's sixteen documented public sample
# lines. Keeping the line list and base URL server-owned avoids a batch endpoint that
# could otherwise be repurposed into an arbitrary multi-fetch relay.
SEOUL_LINES = ("1호선", "2호선", "3호선", "4호선", "5호선", "6호선", "7호선", "8호선", "9호선",
               "경의중앙선", "수인분당선", "신분당선", "공항철도", "우이신설선", "서해선", "신림선")
SEOUL_BASE = os.environ.get("SEOUL_SUBWAY_BASE",
    "http://swopenapi.seoul.go.kr/api/subway/sample/json/realtimePosition/0/5/")
SEOUL_WINDOW_SEC = 1500


def window_sec(value):
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return 0
    if n <= 0:
        return 0
    return min(WINDOW_MAX_SEC, n)


def cache_get(url, window):
    with CACHE_LOCK:
        entry = CACHE.get(url)
        if not entry:
            return None
        if time.time() - entry["at"] >= window:
            CACHE.pop(url, None)
            return None
        return entry


def cache_set(url, entry):
    with CACHE_LOCK:
        CACHE[url] = entry
        while len(CACHE) > CACHE_MAX_ENTRIES:
            CACHE.pop(min(CACHE, key=lambda key: CACHE[key]["at"]), None)


def cacheable(data):
    """An operator's refusal (Seoul's {"errorMessage":{"code":"INFO-300"}}) is HTTP 200 but
    must not be pinned for the whole window: caching it would keep a recovered key locked out."""
    if not data or len(data) > CACHE_MAX_BYTES:
        return False
    try:
        parsed = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return False
    if not isinstance(parsed, dict):
        return False
    return parsed.get("error") is None and parsed.get("errorMessage") is None


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
    _seoul_hits = {}

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

    def _seoul_batch_ok(self):
        """A batch can trigger sixteen source reads on a cold cache, so keep a stricter
        per-IP ceiling than ordinary HLS segment traffic."""
        ip = self.client_address[0]
        now = time.time()
        with CACHE_LOCK:
            arr = [t for t in Handler._seoul_hits.get(ip, []) if now - t < 60]
            if len(arr) >= 12:
                return False
            arr.append(now)
            Handler._seoul_hits[ip] = arr
            if len(Handler._seoul_hits) > 5000:
                Handler._seoul_hits.clear()
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
        if path == "/api/transit/seoul":
            if not self._seoul_batch_ok():
                return self._json({"error": "rate limit — slow down"}, 429)
            return self.do_seoul_batch()
        if path == "/api/fetch":
            query = parse_qs(parsed.query)
            return self.do_fetch(
                query.get("url", [""])[0],
                window_sec(query.get("window", ["0"])[0]),
                query.get("encoding", [""])[0])
        return self.do_static(path)

    # ------------------------------------------------------------- proxy ----
    def do_proxy(self, url):
        if not url or not valid_url(url) or len(url) > 2000:
            return self._json({"error": "bad url"}, 400)
        url = encode_iri(url)
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

    # --------------------------------------------------------- Seoul batch ----
    def _seoul_json(self, url):
        hit = cache_get(url, SEOUL_WINDOW_SEC)
        if hit:
            try:
                return json.loads(hit["data"].decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                pass
        try:
            ctype, data = self._single_flight(url, lambda: self._upstream(url))
            parsed = json.loads(data.decode("utf-8"))
            # Exactly the same safe write rule as /api/fetch: only genuine operator
            # JSON is kept, never a refusal envelope or relay failure.
            if cacheable(data):
                cache_set(url, {"at": time.time(), "ctype": ctype, "data": data})
            return parsed
        except Exception:
            return None

    def do_seoul_batch(self):
        lines = {}
        # Four workers are enough to shorten the cold load without a 16-connection burst.
        def read(line):
            url = SEOUL_BASE + quote(line, safe="")
            data = self._seoul_json(url)
            return line, ({"data": data} if data is not None else {"error": "unavailable"})
        with ThreadPoolExecutor(max_workers=4) as ex:
            for line, value in ex.map(read, SEOUL_LINES):
                lines[line] = value
        self._json({"lines": lines})

    # ------------------------------------------------------------- fetch ----
    def _single_flight(self, url, fn):
        """Concurrent identical requests share one upstream fetch: forty tabs opening the map
        at once must cost the operator one request, not forty."""
        with CACHE_LOCK:
            flight = INFLIGHT.get(url)
            owner = flight is None
            if owner:
                flight = {"event": threading.Event(), "result": None, "error": None}
                INFLIGHT[url] = flight
        if owner:
            try:
                flight["result"] = fn()
            except Exception as e:                    # noqa: BLE001 - shared with the followers
                flight["error"] = e
            finally:
                with CACHE_LOCK:
                    INFLIGHT.pop(url, None)
                flight["event"].set()
        elif not flight["event"].wait(35):
            return fn()                                # the leader vanished; fetch it ourselves
        if flight["error"] is not None:
            raise flight["error"]
        return flight["result"]

    def _upstream(self, url):
        req = urllib.request.Request(encode_iri(url), headers={
            "User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*",
            "Accept-Encoding": "gzip",
        })
        upstream = urllib.request.urlopen(req, timeout=30)
        try:
            data = upstream.read()
        finally:
            upstream.close()
        if data[:2] == b"\x1f\x8b":
            import gzip as _gz
            data = _gz.decompress(data)
        return upstream.headers.get("Content-Type", "application/json; charset=utf-8"), data

    def _bytes(self, data, ctype, extra=None):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def do_fetch(self, url, window=0, encoding=""):
        if not url or not valid_url(url) or len(url) > 2000:
            return self._json({"error": "bad url"}, 400)
        as_base64 = encoding == "base64"
        if as_base64:
            window = 0
        if window:
            hit = cache_get(url, window)
            if hit:
                return self._bytes(hit["data"], hit["ctype"], {"X-Cache": "HIT"})
        try:
            if window:
                ctype, data = self._single_flight(url, lambda: self._upstream(url))
            else:
                ctype, data = self._upstream(url)
        except Exception as e:                        # noqa: BLE001 - a relay failure is never cached
            return self._json({"error": str(e)}, 502)
        if window and cacheable(data):
            cache_set(url, {"at": time.time(), "ctype": ctype, "data": data})
        if as_base64:
            return self._bytes(base64.b64encode(data), "text/plain; charset=utf-8", {"X-Cache": "SKIP"})
        return self._bytes(data, ctype, {"X-Cache": "MISS" if window else "SKIP"})

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
