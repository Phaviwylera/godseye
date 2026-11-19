"""Repository-level security invariants for public data shipped to browsers."""
import json
import unittest
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


class PublicCredentialTests(unittest.TestCase):
    def test_delhi_transit_registry_contains_no_api_key(self):
        registry = json.loads((ROOT / "data" / "transit.json").read_text(encoding="utf-8"))
        feed = next(row for row in registry["feeds"] if row["id"] == "delhi-dtc")
        self.assertEqual(feed.get("keyEnv"), "DELHI_OTD_KEY")
        self.assertFalse(urlparse(feed["base"]).query)
        self.assertNotRegex(json.dumps(feed), r"[?&]key=[^&\"]+")

    def test_no_delhi_key_fallback_is_committed_in_public_sources(self):
        public_files = [
            ROOT / "data" / "transit.json",
            ROOT / "js" / "transit.js",
            ROOT / "index.html",
        ]
        for path in public_files:
            source = path.read_text(encoding="utf-8")
            self.assertNotRegex(source, r"otd\.delhi\.gov\.in/[^\s\"']*[?&]key=",
                                msg=f"credential-bearing URL found in {path.relative_to(ROOT)}")


if __name__ == "__main__":
    unittest.main()
