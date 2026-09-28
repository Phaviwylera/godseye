#!/usr/bin/env python3
"""Build data/companies.json from the curated large-cap seed.

data/companies-seed.json holds name + ticker + an explicit Nominatim geocode
query for each HQ city. This tool geocodes those queries (1 req/s, Nominatim
usage policy) with a local cache, and writes compact JSON for the COMPANIES
layer. No coordinates are invented: a seed row that fails to geocode is
dropped (and counted), and the run refuses to ship if fewer than FLOOR rows
resolve.

Run from the repo root:  python3 tools/build_companies.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(ROOT, "data", "companies-seed.json")
OUT = os.path.join(ROOT, "data", "companies.json")
CACHE_FILE = os.path.join(ROOT, "tools", "_cache", "geocode.json")
UA = {"User-Agent": "godseye-companies/1.0 (one-off HQ geocoding; contact: repo owner)"}
NOMINATIM = "https://nominatim.openstreetmap.org/search"
FLOOR = 50
CACHE_TTL_DAYS = 30 * 365  # HQ cities do not move; cache forever-ish


def load_cache(path: str = CACHE_FILE) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_cache(cache: dict, path: str = CACHE_FILE) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=0)
    os.replace(tmp, path)


def geocode(query: str, cache: dict, offline: bool = False) -> tuple[float, float] | None:
    key = query.strip()
    hit = cache.get(key)
    if hit and all(isinstance(v, (int, float)) for v in hit):
        return hit
    if offline:
        return None
    params = urllib.parse.urlencode({"format": "jsonv2", "limit": 1, "q": key})
    req = urllib.request.Request(NOMINATIM + "?" + params, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"  geocode failed for {key!r}: {e}", file=sys.stderr)
        return None
    if not rows:
        return None
    try:
        lon, lat = float(rows[0]["lon"]), float(rows[0]["lat"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    cache[key] = [lon, lat]
    return [lon, lat]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="use only the geocode cache (CI-safe rebuild)")
    ap.add_argument("--seed", default=SEED, help="seed path (tests)")
    ap.add_argument("--out", dest="out_path", default=OUT, help="output path (tests)")
    ap.add_argument("--cache", default=CACHE_FILE, help="geocode cache path (tests)")
    ap.add_argument("--floor", type=int, default=FLOOR, help="minimum resolved rows (tests)")
    args = ap.parse_args()

    try:
        with open(args.seed, "r", encoding="utf-8") as f:
            seed = json.load(f)
    except (OSError, ValueError) as e:
        print(f"ERROR: cannot read seed: {e}", file=sys.stderr)
        return 1
    rows = seed.get("companies") or []
    if not rows:
        print("ERROR: seed has no companies", file=sys.stderr)
        return 1

    cache = load_cache(args.cache)
    out = []
    failed = 0
    for i, c in enumerate(rows):
        q = (c.get("q") or "").strip()
        name = (c.get("name") or "").strip()
        ticker = (c.get("ticker") or "").strip()
        if not (q and name and ticker):
            failed += 1
            continue
        if i and (q not in cache):
            time.sleep(1.05)  # Nominatim usage policy: 1 request/second
        ll = geocode(q, cache, offline=args.offline)
        if ll is None:
            failed += 1
            print(f"  skipped (no geocode): {name}", file=sys.stderr)
            continue
        out.append({"name": name, "ticker": ticker, "city": q.split(",")[0].strip(),
                    "lon": ll[0], "lat": ll[1]})
    save_cache(cache, args.cache)

    if len(out) < args.floor:
        print(f"ERROR: only {len(out)}/{len(rows)} HQs resolved (< {args.floor}) — refusing to ship", file=sys.stderr)
        return 5

    doc = {
        "source": "curated large-cap seed (data/companies-seed.json) + OpenStreetMap Nominatim HQ geocoding (CC-BY-ODbL)",
        "generated": date.today().isoformat(),
        "count": len(out),
        "dropped": failed,
        "companies": out,
    }
    tmp = args.out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, args.out_path)
    print(f"wrote {args.out_path}: {len(out)} companies, {failed} dropped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
