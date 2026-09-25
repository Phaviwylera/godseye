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

    def test_player_types_supported(self):
        pl = open(os.path.join(ROOT, "js", "players.js")).read()
        for t in ("m3u8", "mp4", "youtube", "mjpeg", "dynamic", "embed"):
            self.assertIn(f'"{t}"', pl, t)


if __name__ == "__main__":
    unittest.main(verbosity=2)
