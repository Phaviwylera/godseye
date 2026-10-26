#!/usr/bin/env python3
"""Build data/conflict.json from the UCDP/PRIO Government-Endowed (GED) dataset.

UCDP (https://ucdp.uu.se) publishes the full GED as a zip on its downloads
page; the filename moves with each release, so this tool:

  1. fetches the downloads page and picks the newest *GED* CSV zip link,
  2. falls back to UCDP_FALLBACK_URLS below (edit when the site moves),
  3. parses the event CSV, keeps events inside WINDOW_DAYS with real
     coordinates, and writes compact JSON.

The release CSV has changed column names over time (PascalCase in older
releases, lowercase in current ones), so column lookup is case-insensitive and
accepts both spellings. UCDP releases lag the calendar, so when the last
WINDOW_DAYS is empty the window is anchored to the newest event in the release
instead of failing outright; `window_end` in the output records that date.

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

SITE = "https://ucdp.uu.se"
DATA_PAGE = SITE + "/downloads/"

# Last known release locations. When the UCDP site reorganises, drop the new
# zip URL here and re-run; the page scrape above is tried first regardless.
UCDP_FALLBACK_URLS = [
    SITE + "/downloads/ged/ged261-csv.zip",
    SITE + "/downloads/ged/ged251-csv.zip",
    SITE + "/downloads/ged/ged241-csv.zip",
]

FLOOR_EVENTS = 100      # below this in the window the parse is surely broken
CAP_EVENTS = 20000
WINDOW_DAYS = 180


def http_get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _version_key(url: str) -> tuple[int, int, int]:
    """Rank release zips newest-first: ged261-csv.zip -> (261, 0, 1)."""
    m = re.search(r"ged(\d{3})", url, re.I)
    release = int(m.group(1)) if m else 0
    flavour = 1 if re.search(r"-csv\.zip$", url, re.I) else 0
    return (release, flavour, 1 if url.lower().endswith(".zip") else 0)


def candidate_urls() -> list[str]:
    urls: list[str] = []
    try:
        page = http_get(DATA_PAGE, timeout=30).decode("utf-8", "replace")
    except Exception:
        page = ""
    for m in re.finditer(r"""href\s*=\s*["']([^"']+\.zip)["']""", page, re.I):
        u = m.group(1)
        if re.search(r"ged", u, re.I) and re.search(r"csv", u, re.I):
            if u.startswith("/"):
                u = SITE + u
            urls.append(u)
    urls.sort(key=_version_key, reverse=True)
    urls.extend(UCDP_FALLBACK_URLS)
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _norm_row(row: dict) -> dict[str, str]:
    """Lower-case the header so legacy and current GED releases look alike."""
    return {str(k).strip().lower(): ("" if v is None else str(v))
            for k, v in row.items() if k}


def _pick(row: dict[str, str], *names: str) -> str:
    for name in names:
        val = row.get(name)
        if val not in (None, ""):
            return val
    return ""


def _looks_like_ged_header(head: str) -> bool:
    cols = {c.strip().strip('"').lower() for c in head.split(",") if c.strip()}
    # Current releases carry the full date in date_start; older ones split it
    # into Year/Month/Day.
    has_date = "date_start" in cols or {"year", "month", "day"} <= cols
    has_coords = bool({"latitude", "lat"} & cols) and bool({"longitude", "long"} & cols)
    has_event = bool({"best", "killings", "type_of_violence", "conflict",
                      "country", "countryname", "id", "eventid"} & cols)
    return has_date and has_coords and has_event


def looks_like_ged_csv(text: str) -> bool:
    head = text.splitlines()[0] if text else ""
    return _looks_like_ged_header(head)


def find_events_csv(zdata: bytes) -> str | None:
    with zipfile.ZipFile(io.BytesIO(zdata)) as z:
        for name in z.namelist():
            if not name.lower().endswith(".csv"):
                continue
            try:
                raw = z.read(name)
            except Exception:
                continue
            text = raw.decode("utf-8-sig", "replace")
            if looks_like_ged_csv(text):
                return text
    return None


def _event_date(row: dict[str, str]) -> date | None:
    """Read the event date from either release layout."""
    raw = _pick(row, "date_start", "date_end")
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", raw)
    if m:
        try:
            return date(*(int(g) for g in m.groups()))
        except ValueError:
            return None
    try:
        return date(int(row["year"]), int(row["month"]), int(row["day"]))
    except (KeyError, TypeError, ValueError):
        return None


def latest_event_date(text: str) -> date | None:
    latest: date | None = None
    for row in csv.DictReader(io.StringIO(text)):
        ev = _event_date(_norm_row(row))
        if ev and (latest is None or ev > latest):
            latest = ev
    return latest


def parse_events(text: str, window_days: int, end: date | None = None) -> list[list]:
    """Return GED events in the `window_days` ending on `end` (default today).

    Accepts both release schemas: PascalCase (Year/Month/Day/Lat/Long/
    CountryName/StateName/Conflict/Killings/EventID) and the current lowercase
    one (year/month/day/latitude/longitude/country/adm_1/type_of_violence/
    best/id).
    """
    end = end or date.today()
    cutoff = end - timedelta(days=window_days)
    out: list[list] = []
    seen: set[tuple] = set()
    for raw in csv.DictReader(io.StringIO(text)):
        row = _norm_row(raw)
        ev = _event_date(row)
        if not ev or ev < cutoff or ev > end:
            continue
        try:
            lat = float(_pick(row, "latitude", "lat"))
            lon = float(_pick(row, "longitude", "long"))
        except (TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        try:
            kills = int(float(_pick(row, "best", "killings", "deaths_civilians") or 0))
        except (TypeError, ValueError):
            kills = 0
        etype = _pick(row, "type_of_violence", "conflict").strip() or "1"
        key = (ev.toordinal(), round(lon, 3), round(lat, 3), _pick(row, "id", "eventid"))
        if key in seen:
            continue
        seen.add(key)
        place = _pick(row, "where_description", "where_coordinates",
                      "location (free text)")
        out.append([ev.isoformat(), lon, lat,
                    _pick(row, "country", "countryname").strip(),
                    _pick(row, "adm_1", "statename", "region").strip(),
                    etype, kills, place.strip()[:200]])
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

    window_end = date.today()
    events = parse_events(text, args.days, end=window_end)

    # UCDP releases lag the calendar. If the last N days hold nothing but older
    # data exists, anchor the window to the newest event instead of shipping an
    # empty layer; window_end records the anchor.
    if len(events) < FLOOR_EVENTS:
        latest = latest_event_date(text)
        if latest and latest < window_end:
            anchored = parse_events(text, args.days, end=latest)
            if len(anchored) > len(events):
                print(f"note: no events in the last {args.days} days; "
                      f"anchoring the window to the newest release date {latest}",
                      file=sys.stderr)
                events, window_end = anchored, latest

    if len(events) < FLOOR_EVENTS:
        print(f"ERROR: only {len(events)} events in the last {args.days} days — parse is wrong, refusing to ship", file=sys.stderr)
        return 5
    events.sort(key=lambda e: e[0], reverse=True)
    events = events[:CAP_EVENTS]

    os.makedirs(os.path.dirname(os.path.abspath(args.out_path)), exist_ok=True)
    doc = {
        "source": "UCDP/PRIO GED (Georeferenced Events Dataset) — ucdp.uu.se",
        "generated": date.today().isoformat(),
        "window_days": args.days,
        "window_end": window_end.isoformat(),
        "count": len(events),
        "events": events,
    }
    tmp = args.out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, args.out_path)
    print(f"wrote {args.out_path}: {len(events)} events, {args.days} days to {window_end}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
