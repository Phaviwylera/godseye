#!/usr/bin/env python3
"""Build data/country-centroids.json: ISO-2 code -> approximate country centre.

Country-level feeds (IODA outage alerts) report an ISO-2 entity, not a point.
This file gives the globe a stable, approximate national centre for those rows;
it is never presented as an event location.

Source: mledoze/countries (ODbL-1.0), which publishes one record per ISO 3166-1
country with a `latlng` field. Small, stable and keyless.

Run from the repo root:  python3 tools/build_country_centroids.py
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import urllib.request
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "country-centroids.json")
UA = {"User-Agent": "godseye-infra/1.0 (public data refresh; contact: repo owner)"}

SOURCE = "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"
FLOOR = 200      # a real ISO list carries ~250 countries
CAP = 400


def http_get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_centroids(doc) -> dict:
    """mledoze countries list -> {'US': {'name': ..., 'lat': ..., 'lon': ...}}."""
    if not isinstance(doc, list):
        raise ValueError("not a country list")
    out: dict[str, dict] = {}
    for row in doc:
        if not isinstance(row, dict):
            continue
        code = str(row.get("cca2") or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{2}", code):
            continue
        latlng = row.get("latlng")
        if not isinstance(latlng, list) or len(latlng) < 2:
            continue
        try:
            lat, lon = float(latlng[0]), float(latlng[1])
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(lat) and math.isfinite(lon)):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        if lat == 0 and lon == 0:            # the classic placeholder, not a centre
            continue
        name = ((row.get("name") or {}).get("common") or "").strip() or code
        out[code] = {"name": name, "lat": round(lat, 3), "lon": round(lon, 3)}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", dest="out_path", default=OUT, help="output path (tests)")
    ap.add_argument("--url", dest="url", default=None, help="override source url (tests)")
    args = ap.parse_args()

    url = args.url or SOURCE
    try:
        data = http_get(url)
    except Exception as e:
        print(f"ERROR: download failed: {e}", file=sys.stderr)
        return 2
    try:
        centroids = parse_centroids(json.loads(data))
    except (ValueError, KeyError, TypeError) as e:
        print(f"ERROR: malformed source: {e}", file=sys.stderr)
        return 4
    if len(centroids) < FLOOR:
        print(f"ERROR: only {len(centroids)} country centres (< {FLOOR}) — refusing to ship",
              file=sys.stderr)
        return 5
    if len(centroids) > CAP:
        print(f"ERROR: {len(centroids)} country centres (> {CAP}) — bad parse, refusing to ship",
              file=sys.stderr)
        return 6

    doc = {
        "source": "mledoze/countries (ODbL-1.0) — approximate country centres",
        "generated": date.today().isoformat(),
        "note": "Approximate national centre for country-level feeds. Not an event location.",
        "count": len(centroids),
        "centroids": centroids,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out_path)), exist_ok=True)
    tmp = args.out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, args.out_path)
    print(f"wrote {args.out_path}: {len(centroids)} country centres")
    return 0


if __name__ == "__main__":
    sys.exit(main())
