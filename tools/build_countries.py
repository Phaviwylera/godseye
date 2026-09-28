#!/usr/bin/env python3
"""Build data/countries.json: admin-0 (country) boundaries + ISO-2 codes.

Source: the widely mirrored `world.geo.json` static file (~250 countries,
properties: name + id=ISO 3166-1 alpha-2 where published). One small static
file instead of a heavy Overpass geometry pull: the layer only needs clickable
boundaries, and a 200 KB file keeps the offline shell fast.

The tool validates (feature count, ring sanity) before writing, so a partial
or restructured file fails loudly rather than shipping a half-world.

Run from the repo root:  python3 tools/build_countries.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "countries.json")
UA = {"User-Agent": "godseye-infra/1.0 (public data refresh; contact: repo owner)"}

SOURCES = [
    "https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json",
]

FLOOR = 200      # a real admin-0 file has ~240+ countries
CAP = 1200
MAX_MB = 5


def http_get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def validate(doc: dict) -> list:
    feats = doc.get("features")
    if not isinstance(feats, list):
        raise ValueError("not a FeatureCollection")
    out = []
    for f in feats:
        g = f.get("geometry") or {}
        if g.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        p = f.get("properties") or {}
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        # sanity: at least one ring with >= 4 coordinates
        rings = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        ok = any(len(ring) >= 4 for poly in rings for ring in poly)
        if not ok:
            continue
        out.append({
            "name": name,
            "iso2": str(p.get("id") or "").strip().upper() or None,
            "geometry": g,
        })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", dest="out_path", default=OUT, help="output path (tests)")
    ap.add_argument("--url", dest="url", default=None, help="override source url (tests)")
    args = ap.parse_args()

    url = args.url or SOURCES[0]
    try:
        data = http_get(url)
    except Exception as e:
        print(f"ERROR: download failed: {e}", file=sys.stderr)
        return 2
    if len(data) > MAX_MB * 1024 * 1024:
        print(f"ERROR: source is {len(data) // 1024} KB — not the expected small static file", file=sys.stderr)
        return 3
    try:
        doc = json.loads(data)
        feats = validate(doc)
    except (ValueError, KeyError, TypeError) as e:
        print(f"ERROR: malformed source: {e}", file=sys.stderr)
        return 4
    if len(feats) < FLOOR:
        print(f"ERROR: only {len(feats)} countries parsed (< {FLOOR}) — refusing to ship", file=sys.stderr)
        return 5

    doc_out = {
        "source": "world.geo.json (OpenStreetMap-derived admin-0 boundaries, widely mirrored)",
        "generated": date.today().isoformat(),
        "count": len(feats),
        "countries": feats,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out_path)), exist_ok=True)
    tmp = args.out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc_out, f, separators=(",", ":"))
    os.replace(tmp, args.out_path)
    print(f"wrote {args.out_path}: {len(feats)} countries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
