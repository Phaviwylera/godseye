#!/usr/bin/env python3
"""Build data/conflict.json from the UCDP/PRIO Government-Endowed (GED) dataset.

UCDP (https://ucdp.unic.ch) publishes the full GED as a zip on its data page;
the filename moves with each release, so this tool:

  1. fetches the data page and picks the newest *GED* zip link it finds,
  2. falls back to UCDP_FALLBACK_URLS below (edit when the site moves),
  3. parses the event CSV (any file with the GED header shape), keeps events
     inside WINDOW_DAYS with real coordinates, and writes compact JSON.

If every download fails the tool exits 2 with an explicit message — the layer
then stays in its labelled "PENDING BUILD" state rather than drawing guesses.
Run from the repo root:  python3 tools/build_conflict.py [--days 180]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "conflict.json")
CACHE_DIR = os.path.join(ROOT, "tools", "_cache")
UA = {"User-Agent": "godseye-infra/1.0 (public data refresh; contact: repo owner)"}

DATA_PAGE = "https://ucdp.unic.ch/data/"

# Last known release locations. When the UCDP site reorganises, drop the new
# zip URL here and re-run; the page scrape above is tried first regardless.
UCDP_FALLBACK_URLS = [
    "https://ucdp.unic.ch/wp-content/uploads/2026/01/UCDP_GED_2026_1.zip",
    "https://ucdp.unic.ch/wp-content/uploads/2025/01/UCDP_GED_2025_1.zip",
]

FLOOR_EVENTS = 100      # below this in the window the parse is surely broken
CAP_EVENTS = 20000
WINDOW_DAYS = 180


def http_get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def candidate_urls() -> list[str]:
    urls: list[str] = []
    try:
        page = http_get(DATA_PAGE, timeout=30).decode("utf-8", "replace")
    except Exception:
        page = ""
    for m in re.finditer(r'href="([^"]+\.zip)"', page):
        u = m.group(1)
        if re.search(r"(ged|events?)", u, re.I) and not re.search(r"(state|dyad|pr|peace)", u, re.I):
            if u.startswith("/"):
                u = "https://ucdp.unic.ch" + u
            urls.append(u)
    urls.extend(UCDP_FALLBACK_URLS)
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def looks_like_ged_csv(text: str) -> bool:
    head = text.splitlines()[0] if text else ""
    return "CountryName" in head and ("EventCode2015" in head or "EventCode" in head) and "Lat" in head


def find_events_csv(zdata: bytes) -> str | None:
    with zipfile.ZipFile(io.BytesIO(zdata)) as z:
        for name in z.namelist():
            if not name.lower().endswith(".csv"):
                continue
            try:
                text = z.read(name).decode("utf-8", "replace")[:8192]
            except Exception:
                continue
            if looks_like_ged_csv(text):
                # read the whole file back
                with zipfile.ZipFile(io.BytesIO(zdata)) as z2:
                    return z2.read(name).decode("utf-8", "replace")
    return None


def parse_events(text: str, window_days: int) -> list[list]:
    cutoff = date.today() - timedelta(days=window_days)
    rows = csv.DictReader(io.StringIO(text))
    out: list[list] = []
    seen: set[tuple] = set()
    for row in rows:
        try:
            y, mo, d = int(row["Year"]), int(row["Month"]), int(row["Day"])
            ev = date(y, mo, d)
        except (KeyError, TypeError, ValueError):
            continue
        if ev < cutoff or ev > date.today():
            continue
        try:
            lon = float(row["Long"])
            lat = float(row["Lat"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        try:
            kills = int(float(row.get("Killings") or 0))
        except (TypeError, ValueError):
            kills = 0
        etype = str(row.get("Conflict") or "1").strip()
        key = (ev.toordinal(), round(lon, 3), round(lat, 3), row.get("EventID", ""))
        if key in seen:
            continue
        seen.add(key)
        out.append([ev.isoformat(), lon, lat,
                    (row.get("CountryName") or "").strip(),
                    (row.get("StateName") or "").strip(),
                    etype, kills,
                    (row.get("Location (Free Text)") or "").strip()[:200]])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=WINDOW_DAYS)
    ap.add_argument("--zip", dest="zip_path", help="local path to a GED zip (offline rebuild)")
    ap.add_argument("--out", dest="out_path", default=OUT, help="output path (tests)")
    args = ap.parse_args()

    if args.zip_path:
        with open(args.zip_path, "rb") as f:
            zdata = f.read()
    else:
        zdata = None
        for url in candidate_urls():
            try:
                print(f"trying {url}", file=sys.stderr)
                zdata = http_get(url, timeout=120)
                break
            except Exception as e:
                print(f"  failed: {e}", file=sys.stderr)
        if zdata is None:
            print("ERROR: could not download a UCDP GED release from any known location.\n"
                  f"Open {DATA_PAGE}, copy the current GED zip URL into UCDP_FALLBACK_URLS "
                  "in tools/build_conflict.py (or pass --zip /path/to/release.zip) and re-run.",
                  file=sys.stderr)
            return 2

    if len(zdata) < 100_000:
        print(f"ERROR: download is only {len(zdata)} bytes — not a GED release", file=sys.stderr)
        return 3

    text = find_events_csv(zdata)
    if text is None:
        print("ERROR: no GED-shaped CSV inside the archive", file=sys.stderr)
        return 4

    events = parse_events(text, args.days)
    if len(events) < FLOOR_EVENTS:
        print(f"ERROR: only {len(events)} events in the last {args.days} days — parse is wrong, refusing to ship", file=sys.stderr)
        return 5
    events.sort(key=lambda e: e[0], reverse=True)
    events = events[:CAP_EVENTS]

    os.makedirs(os.path.dirname(os.path.abspath(args.out_path)), exist_ok=True)
    doc = {
        "source": "UCDP/PRIO GED (Peaces and conflict events) — ucdp.unic.ch",
        "generated": date.today().isoformat(),
        "window_days": args.days,
        "count": len(events),
        "events": events,
    }
    tmp = args.out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, args.out_path)
    print(f"wrote {args.out_path}: {len(events)} events, last {args.days} days")
    return 0


if __name__ == "__main__":
    sys.exit(main())
