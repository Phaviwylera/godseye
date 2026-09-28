#!/usr/bin/env python3
"""God's Eye — tooling unit tests (stdlib unittest, no deps)."""
import base64, concurrent.futures, http.client, json, os, re, sys, threading, time, unittest, urllib.parse, urllib.request, importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestServer(unittest.TestCase):
    def test_valid_url_blocks_local(self):
        self.assertFalse(self.srv.valid_url("http://127.0.0.1/x"))
        self.assertFalse(self.srv.valid_url("http://localhost:8000/x"))
        self.assertFalse(self.srv.valid_url("file:///etc/passwd"))
        self.assertTrue(self.srv.valid_url("https://example.com/a.m3u8"))

    def test_m3u8_rewrite(self):
        out = self.srv.rewrite_m3u8("#EXTM3U\nchunklist_1.m3u8\n",
                                    "https://host/live/playlist.m3u8")
        self.assertIn("#EXTM3U", out)
        self.assertIn("/api/proxy?url=", out)
        self.assertIn("chunklist_1.m3u8", out.replace("%2F", "/").replace("%3A", ":"))

    def test_m3u8_rewrite_key_uri(self):
        out = self.srv.rewrite_m3u8('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTM3U\n',
                                    "https://host/live/p.m3u8")
        self.assertIn("/api/proxy?url=", out)

    # ----------------------------------------------------------- encode_iri --
    # parse_qs hands do_fetch a percent-*decoded* URL and http.client writes the request line
    # as ASCII, so a non-ASCII target used to fail with "'ascii' codec can't encode characters"
    # — indistinguishable from the operator being down.
    def test_encode_iri_makes_a_non_ascii_target_sendable(self):
        url = "http://cam.example.kr/stream/한국어.m3u8"
        encoded = self.srv.encode_iri(url)
        encoded.encode("ascii")                      # must not raise
        self.assertEqual(encoded,
                         "http://cam.example.kr/stream/%ED%95%9C%EA%B5%AD%EC%96%B4.m3u8")
        self.assertEqual(urllib.parse.unquote(encoded), url)

    def test_encode_iri_leaves_ascii_and_existing_escapes_alone(self):
        for url in ("https://example.com/a.m3u8",
                    "https://example.com/a?b=1&c=%ED%95%9C",
                    "http://swopenapi.seoul.go.kr/api/subway/sample/json/realtimePosition/0/5/%ED%98%B8"):
            self.assertEqual(self.srv.encode_iri(url), url, url)

    def test_encode_iri_keeps_query_structure_and_encodes_only_the_value(self):
        out = self.srv.encode_iri("https://api.example/x?key=abc&line=1호선")
        out.encode("ascii")
        self.assertIn("key=abc", out)
        self.assertIn("line=1%ED%98%B8%EC%84%A0", out)   # the ASCII digit is left alone
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(out).query)["line"], ["1호선"])

    def test_encode_iri_handles_host_userinfo_port_and_space(self):
        self.assertEqual(self.srv.encode_iri("http://пример.рф/путь"),
                         "http://xn--e1afmkfd.xn--p1ai/%D0%BF%D1%83%D1%82%D1%8C")
        self.assertTrue(self.srv.encode_iri("https://user:pw@пример.рф:8443/a b").startswith(
            "https://user:pw@xn--e1afmkfd.xn--p1ai:8443/a%20b"))

    def test_encode_iri_output_is_something_urllib_will_send(self):
        # This is the call that used to raise UnicodeEncodeError for a non-ASCII target.
        for url in ("http://cam.example.kr/stream/한국어.m3u8",
                    "https://api.example/x?line=1호선"):
            req = urllib.request.Request(self.srv.encode_iri(url))
            conn = http.client.HTTPConnection("127.0.0.1", 1)
            conn.putrequest("GET", req.selector)      # would raise before the fix

    # ------------------------------------------------- shared upstream cache --
    def test_cache_window_is_clamped_and_rejects_nonsense(self):
        self.assertEqual(self.srv.window_sec("600"), 600)
        self.assertEqual(self.srv.window_sec("999999"), 900)
        self.assertEqual(self.srv.window_sec("0"), 0)
        self.assertEqual(self.srv.window_sec("-5"), 0)
        self.assertEqual(self.srv.window_sec("abc"), 0)
        self.assertEqual(self.srv.window_sec(None), 0)

    def test_cache_stores_only_a_small_json_answer(self):
        self.assertTrue(self.srv.cacheable(b'{"trains": 77}'))
        self.assertTrue(self.srv.cacheable(b'{"a": [1, 2, 3]}'))
        self.assertFalse(self.srv.cacheable(b'{"error": "source returned HTTP 502"}'),
                         "a relay failure must not be served again as if it were an answer")
        self.assertFalse(self.srv.cacheable(b'{"errorMessage": {"code": "INFO-300"}}'),
                         "a capped key must not be pinned for the whole window")
        self.assertFalse(self.srv.cacheable(b"[1,2,3]"))
        self.assertFalse(self.srv.cacheable(b"not json at all"))
        self.assertFalse(self.srv.cacheable(b""))
        self.assertFalse(self.srv.cacheable(b'{"blob": "%s"}' % b"x" * (513 * 1024)))

    def test_cache_entries_expire_with_the_window_and_are_bounded(self):
        srv = self.srv
        srv.CACHE.clear()
        srv.cache_set("https://a/x", {"at": time.time(), "ctype": "application/json", "data": b"{}"})
        self.assertIsNotNone(srv.cache_get("https://a/x", 600))
        srv.CACHE["https://a/x"]["at"] = time.time() - 601
        self.assertIsNone(srv.cache_get("https://a/x", 600), "an answer older than the window is gone")
        for i in range(srv.CACHE_MAX_ENTRIES + 25):
            srv.cache_set("https://bulk/%d" % i,
                          {"at": time.time(), "ctype": "application/json", "data": b"{}"})
        self.assertLessEqual(len(srv.CACHE), srv.CACHE_MAX_ENTRIES)
        self.assertIsNotNone(srv.cache_get("https://bulk/%d" % (srv.CACHE_MAX_ENTRIES + 24), 600),
                             "the newest answer survives eviction")
        srv.CACHE.clear()

    # ------------------------------------------------------ HTTP relay contract --
    # Keep this real HTTP exercise separate from unit-level cache checks.  It catches
    # response framing and thread behavior that a direct do_fetch call cannot see.
    @classmethod
    def setUpClass(cls):
        cls.srv = load_module("server", os.path.join(ROOT, "server.py"))
        super().setUpClass()
        class StubUpstream(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            hits = {}
            lock = threading.Lock()
            started = threading.Event()
            release = threading.Event()

            def log_message(self, *_args):
                pass

            def do_GET(self):
                path = urllib.parse.urlparse(self.path).path
                with self.lock:
                    self.hits[path] = self.hits.get(path, 0) + 1
                    hit = self.hits[path]
                if path == "/block":
                    self.started.set()
                    self.release.wait(4)
                if path == "/binary":
                    body, ctype, code = bytes([0, 1, 2, 255]), "application/octet-stream", 200
                elif path == "/envelope":
                    body, ctype, code = b'{"errorMessage":{"code":"INFO-300"}}', "application/json", 200
                else:
                    body = json.dumps({"hit": hit, "path": path}, separators=(",", ":")).encode()
                    ctype, code = "application/json", 200
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        cls.stub_handler = StubUpstream
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), StubUpstream)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.relay = cls.srv.Server(("127.0.0.1", 0), cls.srv.Handler)
        cls.relay_thread = threading.Thread(target=cls.relay.serve_forever, daemon=True)
        cls.relay_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.relay.shutdown(); cls.relay.server_close(); cls.relay_thread.join(timeout=3)
        cls.upstream.shutdown(); cls.upstream.server_close(); cls.upstream_thread.join(timeout=3)
        super().tearDownClass()

    def _stub_url(self, path):
        return "http://127.0.0.1:%d%s" % (self.upstream.server_port, path)

    def _relay_get(self, target, **params):
        query = urllib.parse.urlencode({"url": target, **params})
        conn = http.client.HTTPConnection("127.0.0.1", self.relay.server_port, timeout=8)
        try:
            conn.request("GET", "/api/fetch?" + query)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_http_fetch_contract_caches_single_flights_and_base64s(self):
        srv = self.srv
        original_valid_url = srv.valid_url
        # The production relay rejects localhost by design.  This isolated test has its
        # own stub upstream, so let its otherwise-real Handler talk to that ephemeral port.
        srv.valid_url = lambda _url: True
        srv.CACHE.clear(); srv.INFLIGHT.clear(); srv.Handler._hits.clear()
        stub = self.stub_handler
        stub.hits.clear(); stub.started.clear(); stub.release.set()
        try:
            target = self._stub_url("/json")
            one = self._relay_get(target, window="600")
            two = self._relay_get(target, window="600")
            self.assertEqual(one[0], 200); self.assertEqual(two[0], 200)
            self.assertEqual(one[1].get("X-Cache"), "MISS")
            self.assertEqual(two[1].get("X-Cache"), "HIT")
            self.assertEqual(stub.hits.get("/json"), 1, "a cache window makes one upstream HTTP call")
            self.assertEqual(one[2], two[2])

            binary = self._relay_get(self._stub_url("/binary"), encoding="base64", window="600")
            self.assertEqual(binary[0], 200)
            self.assertEqual(binary[1].get("X-Cache"), "SKIP", "binary payloads are never JSON-cached")
            self.assertEqual(binary[2], base64.b64encode(bytes([0, 1, 2, 255])))

            # A valid HTTP 200 error envelope must not be replayed as a cached answer.
            self._relay_get(self._stub_url("/envelope"), window="600")
            self._relay_get(self._stub_url("/envelope"), window="600")
            self.assertEqual(stub.hits.get("/envelope"), 2)

            stub.release.clear()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(self._relay_get, self._stub_url("/block"), window="600")
                self.assertTrue(stub.started.wait(2), "the upstream request started")
                second = pool.submit(self._relay_get, self._stub_url("/block"), window="600")
                time.sleep(0.08)
                self.assertEqual(stub.hits.get("/block"), 1, "two relay clients share one in-flight HTTP fetch")
                stub.release.set()
                results = [first.result(timeout=5), second.result(timeout=5)]
            self.assertTrue(all(result[0] == 200 for result in results))
            self.assertEqual(results[0][2], results[1][2])
        finally:
            stub.release.set()
            srv.valid_url = original_valid_url
            srv.CACHE.clear(); srv.INFLIGHT.clear()


class TestDataset(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bd = load_module("build_dataset", os.path.join(ROOT, "tools", "build_dataset.py"))

    def test_add_and_dedup_prefers_video(self):
        feats = []
        add = self.bd.add
        # monkey-patch features list
        self.bd.features = feats
        add("A", 10.0, 20.0, "image", "https://x/1.jpg", "t1")
        add("B", 10.0001, 20.0001, "m3u8", "https://x/1.m3u8", "t2")
        out = self.bd.dedup(self.bd.features)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["properties"]["stype"], "m3u8")

    def test_add_rejects_junk(self):
        self.bd.features = []
        add = self.bd.add
        add("bad", "nope", None, "image", "https://x", "t")
        add("bad2", 500, 50, "image", "https://x", "t")   # out of range
        add("bad3", 1, 1, "image", "", "t")               # no stream
        self.assertEqual(len(self.bd.features), 0)


class TestContract(unittest.TestCase):
    """UI element contract + manifest + workflow sanity (catches clobber bugs)."""

    def test_all_js_element_ids_exist(self):
        app = open(os.path.join(ROOT, "js", "app.js")).read()
        intel = open(os.path.join(ROOT, "js", "intel.js")).read()
        html = open(os.path.join(ROOT, "index.html")).read()
        ids = set(re.findall(r'\$\("#([\w-]+)"\)', app + intel)) | \
             set(re.findall(r'getElementById\("([\w-]+)"\)', app + intel))
        missing = [i for i in ids if f'id="{i}"' not in html]
        self.assertEqual(missing, [], f"missing ids in index.html: {missing}")

    def test_offline_shell_caches_every_html_app_script(self):
        """An installed PWA must not silently lose a newly added UI layer."""
        html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
        worker = open(os.path.join(ROOT, "sw.js"), encoding="utf-8").read()
        scripts = set(re.findall(r'<script[^>]+src=["\'](js/[^"\']+\.js)["\']', html))
        core = set(re.findall(r'["\']\./(js/[^"\']+\.js)["\']', worker))
        self.assertTrue(scripts, "index.html should load app scripts")
        self.assertEqual(scripts - core, set(), f"not precached by sw.js CORE: {sorted(scripts - core)}")
        self.assertIn("js/transit.js", core)

    def test_liveness_is_a_compact_bitfield_aligned_to_the_camera_index(self):
        index = json.load(open(os.path.join(ROOT, "data", "cameras.index.json")))
        packed = open(os.path.join(ROOT, "data", "liveness.bin"), "rb").read()
        self.assertEqual(len(packed), (len(index["cams"]) + 7) // 8)
        self.assertLess(len(packed), 4000, "24k liveness flags should be a few KB, not an id map")
        self.assertNotIn("l", index["cams"][0], "liveness belongs in the bitfield, not every index row")
        self.assertTrue(index.get("lv"), "one generated timestamp marks the weekly baseline")
        app = open(os.path.join(ROOT, "js", "app.js"), encoding="utf-8").read()
        self.assertIn('fetch("data/liveness.bin"', app)
        self.assertNotIn('fetch("data/liveness.json"', app)

    def test_manifest_valid(self):
        m = json.load(open(os.path.join(ROOT, "manifest.json")))
        self.assertEqual(m["display"], "standalone")
        self.assertTrue(m["icons"])

    def test_workflows_exist(self):
        for wf in ("refresh-dataset.yml", "check-liveness.yml", "ci.yml"):
            self.assertTrue(os.path.exists(os.path.join(ROOT, ".github", "workflows", wf)), wf)

    def test_player_resilience_features(self):
        pl = open(os.path.join(ROOT, "js", "players.js")).read()
        self.assertIn("extractYt", pl)
        self.assertIn("YT_ERRORS", pl)
        self.assertIn("153", pl)              # youtube embed restriction handled
        self.assertIn("nearestAlternative", pl)  # dead-cam failover
        self.assertIn("armHeal", pl)          # background auto-heal
        self.assertIn("async function probe", pl)  # accurate feed status probe

    def test_progressive_regional_loading(self):
        app = open(os.path.join(ROOT, "js", "app.js")).read()
        self.assertIn("cameras.index.json", app)
        self.assertIn("loadPack", app)
        self.assertIn("loadViewportPacks", app)
        self.assertIn("probeCam", app)
        self.assertTrue(os.path.exists(os.path.join(ROOT, "data", "cameras.index.json")))
        self.assertTrue(os.path.exists(os.path.join(ROOT, "data", "regions", "manifest.json")))
        self.assertTrue(os.path.exists(os.path.join(ROOT, "tools", "build_regions.py")))

    def test_customizable_video_wall(self):
        idx = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
        app = open(os.path.join(ROOT, "js", "app.js")).read()
        self.assertIn("wall-cols", idx)
        self.assertIn("wall-rows", idx)
        self.assertIn("wall-pref", idx)
        self.assertIn("btn-wall-custom", idx)
        self.assertIn("openCustomWall", app)
        self.assertIn("ge_wall_cols", app)

    def test_live_earthquake_layer(self):
        idx = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
        app = open(os.path.join(ROOT, "js", "app.js"), encoding="utf-8").read()
        intel = open(os.path.join(ROOT, "js", "intel.js"), encoding="utf-8").read()
        self.assertIn('id="btn-quakes"', idx)
        self.assertIn('id="quake-chip"', idx)
        self.assertIn('data-do="#btn-quakes"', idx)
        self.assertIn("toggleQuakes", app)
        self.assertIn("earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson", intel)
        self.assertIn("5 * 60 * 1000", intel)
        self.assertIn('setDOMContent(content)', intel)

    def test_shareable_map_scene(self):
        idx = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
        app = open(os.path.join(ROOT, "js", "app.js"), encoding="utf-8").read()
        self.assertIn('id="btn-share-scene"', idx)
        self.assertIn('data-do="#btn-share-scene"', idx)
        self.assertIn("function readSharedScene()", app)
        self.assertIn('params.get("scene") !== "1"', app)
        self.assertIn("center: sharedScene ? sharedScene.center", app)
        self.assertIn("bearing: sharedScene ? sharedScene.bearing", app)
        self.assertIn("sensor: currentSensorMode", app)
        self.assertIn('params.get("sensor") || "natural"', app)
        self.assertIn("function shareScene()", app)

    def test_visual_sensor_modes(self):
        idx = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
        app = open(os.path.join(ROOT, "js", "app.js"), encoding="utf-8").read()
        css = open(os.path.join(ROOT, "css", "style.css"), encoding="utf-8").read()
        self.assertIn('id="btn-sensor-mode"', idx)
        self.assertIn('data-do="#btn-sensor-mode"', idx)
        self.assertIn('const SENSOR_MODES = ["natural", "crt", "nvg", "flir", "noir", "snow"]', app)
        self.assertIn('document.body.dataset.sensorMode = mode', app)
        for mode in ("crt", "nvg", "flir", "noir", "snow"):
            self.assertIn(f'data-sensor-mode="{mode}"', css)
        self.assertIn('"5": "snow"', app)

    def test_global_context_view(self):
        idx = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
        app = open(os.path.join(ROOT, "js", "app.js"), encoding="utf-8").read()
        readme = open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()
        self.assertIn('id="btn-context-view"', idx)
        self.assertIn('data-do="#btn-context-view"', idx)
        self.assertIn("function toggleContextView()", app)
        self.assertIn("savedContextView = {", app)
        self.assertIn("map.flyTo({ ...view, duration: 1600, essential: true })", app)
        self.assertIn('e.key.toLowerCase() === "g"', app)
        self.assertIn("restore the saved center, zoom, bearing", readme)

    def test_aircraft_tracking_trails(self):
        intel = open(os.path.join(ROOT, "js", "intel.js"), encoding="utf-8").read()
        app = open(os.path.join(ROOT, "js", "app.js"), encoding="utf-8").read()
        self.assertIn('id: "air-track-line"', intel)
        self.assertIn("function selectAirTrack(record)", intel)
        self.assertIn("60 * 60 * 1000", intel)
        self.assertIn("state.airFollow", intel)
        self.assertIn("function toggleAirFollow()", intel)
        self.assertIn("function toggleAirCockpit()", intel)
        self.assertIn('cockpit.textContent = state.airCockpit ? "EXIT COCKPIT" : "COCKPIT VIEW"', intel)
        self.assertIn("positionAirCockpit(coordinates, state.airTrack.track, 900)", intel)
        self.assertIn("state.airSavedCamera = {", intel)
        self.assertIn('"STOP TRACKING"', intel)
        self.assertIn("c.lng.toFixed(2)", intel)
        self.assertIn("restoreAirLayer()", intel)
        self.assertIn("Intel.restoreAirLayer()", app)
        self.assertIn("Intel.openAirList()", app)
        readme = open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()
        self.assertIn("recent flight trails", readme)
        self.assertIn("cockpit view", readme)

    def test_player_types_supported(self):
        pl = open(os.path.join(ROOT, "js", "players.js")).read()
        for t in ("m3u8", "mp4", "youtube", "mjpeg", "dynamic", "embed"):
            self.assertIn(f'"{t}"', pl, t)


    def test_upgrade_e_tier(self):
        """Tour, LIVE jump, 6-feed wall, PWA install, revisit badge must all ship."""
        idx = open("index.html", encoding="utf-8").read()
        appjs = open("js/app.js", encoding="utf-8").read()
        self.assertIn("btn-tour", idx)            # autopilot world tour
        self.assertIn("btn-live", idx)            # freshest-feeds jump
        self.assertIn("btn-wall6", idx)           # 6-feed wall (3x2)
        self.assertIn("btn-install", idx)         # PWA install button
        self.assertIn("m-visits", idx)            # revisit counter badge
        self.assertIn("serviceWorker.register", idx)
        self.assertIn("img/godseye-icon.png", idx)
        self.assertIn("startTour", appjs)
        self.assertIn("tourStops", appjs)
        self.assertIn("goLive", appjs)
        self.assertIn("bumpVisit", appjs)
        self.assertIn("ge_visits", appjs)
        self.assertIn("beforeinstallprompt", idx)
        self.assertTrue(os.path.exists("sw.js"))
        self.assertTrue(os.path.exists("img/godseye-icon.png"))
        self.assertFalse(os.path.exists("E-TIER-COMPLETE.md"))  # no banner docs
        import json
        mf = json.load(open("manifest.json", encoding="utf-8"))
        self.assertEqual(mf.get("short_name"), "God's Eye")


class TestBuildInfra(unittest.TestCase):
    """Static infrastructure datasets (OSM volcanoes/plants/harbours, open cable map)."""

    @classmethod
    def setUpClass(cls):
        cls.infra = load_module("build_infra", os.path.join(ROOT, "tools", "build_infra.py"))

    OVERPASS_XML = """<?xml version="1.0" encoding="UTF-8"?>
    <osm version="0.6">
      <node id="1" lat="12.3" lon="-1.2"><tag k="natural" v="volcano"/><tag k="name" v="Test Volcano"/><tag k="ele" v="2500"/></node>
      <node id="2" lat="0" lon="0"><tag k="natural" v="volcano"/><tag k="name" v="Null Island"/></node>
      <way id="3"><nd ref="1"/><nd ref="2"/>
        <center lat="45.5" lon="13.5"/>
        <tag k="power" v="plant"/><tag k="name" v="Solar Farm"/><tag k="power:generates" v="electricity"/>
      </way>
      <way id="4"><center lat="51.5" lon="-0.1"/>
        <tag k="place" v="harbour"/><tag k="name" v="Test Harbour"/>
      </way>
      <way id="5"><center lat="51.6" lon="-0.2"/>
        <tag k="harbour" v="yes"/><tag k="name" v="Test Harbour"/>
      </way>
      <relation id="6"></relation>
    </osm>"""

    def test_parse_overpass_extracts_positions_and_tags(self):
        rows = self.infra.parse_overpass(self.OVERPASS_XML)
        by_id = {r[0]: r for r in rows}
        self.assertIn("1", by_id)
        self.assertEqual(by_id["1"][2], -1.2)   # lon
        self.assertEqual(by_id["1"][3], 12.3)   # lat
        self.assertEqual(by_id["3"][2], 13.5)   # way uses its center
        self.assertEqual(by_id["3"][4]["power"], "plant")
        self.assertNotIn("2", by_id)            # (0,0) refused
        self.assertNotIn("6", by_id)            # no position at all

    def test_volcano_records_requires_natural_volcano_and_name(self):
        rows = self.infra.parse_overpass(self.OVERPASS_XML)
        recs = self.infra.volcano_records(rows)
        self.assertEqual(recs, [[-1.2, 12.3, "Test Volcano", 2500]])

    def test_power_records_requires_power_plant_and_name(self):
        rows = self.infra.parse_overpass(self.OVERPASS_XML)
        recs = self.infra.power_records(rows)
        self.assertEqual(recs, [[13.5, 45.5, "Solar Farm", "other"]])

    def test_power_kind_maps_real_osm_generator_tags(self):
        self.assertEqual(self.infra.power_kind({"generator:source": "nuclear"}), "nuclear")
        self.assertEqual(self.infra.power_kind({"generator:source": "fuel:oil"}), "oil")
        self.assertEqual(self.infra.power_kind({"generator:source": "fuel:coal"}), "coal")
        self.assertEqual(self.infra.power_kind({"generator:source": "fuel:natural_gas"}), "gas")
        self.assertEqual(self.infra.power_kind({"generator:source": "water"}), "hydro")
        self.assertEqual(self.infra.power_kind({"generator:solar": "yes"}), "solar")
        self.assertEqual(self.infra.power_kind({"generator:wind": "yes"}), "wind")
        self.assertEqual(self.infra.power_kind({"generator:source": "unknown-tech"}), "other")
        self.assertEqual(self.infra.power_kind({"power:generates": "electricity"}), "other")
        self.assertEqual(self.infra.power_kind({}), "other")

    def test_port_records_dedupes_same_position_and_name(self):
        rows = self.infra.parse_overpass(self.OVERPASS_XML)
        recs = self.infra.port_records(rows)
        # same name but different positions: both kept (they are different harbours)
        self.assertEqual(recs, [[-0.1, 51.5, "Test Harbour"], [-0.2, 51.6, "Test Harbour"]])

    def test_slim_cables_keeps_named_routes_and_drops_z(self):
        doc = {"features": [
            {"type": "Feature", "properties": {"Name": "Atlantic-1", "length": "6500 km",
             "rfs": "2019", "owners": "X"},
             "geometry": {"type": "LineString", "coordinates": [[-50, 30, 9], [-40, 40, 9]]}},
            {"type": "Feature", "properties": {"Name": "", "length": "1 km"},
             "geometry": {"type": "LineString", "coordinates": [[0, 0, 0]]}},
        ]}
        slim = self.infra.slim_cables(doc)
        self.assertEqual(len(slim["features"]), 1)
        f = slim["features"][0]
        self.assertEqual(f["properties"]["name"], "Atlantic-1")
        self.assertEqual(f["geometry"]["coordinates"], [[-50, 30], [-40, 40]])

    def test_validate_cables_enforces_floor(self):
        self.infra.validate_cables({"features": [{"type": "Feature"}] * self.infra.CABLE_FLOOR})
        with self.assertRaises(ValueError):
            self.infra.validate_cables({"features": [{"type": "Feature"}]})

    def test_write_records_refuses_partial_downloads(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit):
                self.infra._write_records("volcanoes", [[0, 0, "x", 0]], tmp, "src")
            path = self.infra._write_records("volcanoes",
                                             [[1, 2, "a", 0]] * self.infra.FLOORS["volcanoes"], tmp, "src")
            self.assertTrue(path.exists())
            doc = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(doc["count"], self.infra.FLOORS["volcanoes"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
