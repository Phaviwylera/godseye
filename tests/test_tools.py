#!/usr/bin/env python3
"""God's Eye — tooling unit tests (stdlib unittest, no deps)."""
import json, os, re, sys, unittest, importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_module("server", os.path.join(ROOT, "server.py"))

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
        self.assertIn("if (!Intel.state.airTrack)", app)
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
