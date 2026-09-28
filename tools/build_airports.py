#!/usr/bin/env python3
"""Build data/airports.json from the OurAirports global dataset.

OurAirports (https://ourairports.com/data/) is a public-domain dataset refreshed nightly;
this tool converts its airports.csv into the compact positional format the AIRPORTS layer
reads, the same pattern build_satellites.py uses for data/satellites.json. Every airport
type except 'closed' is kept: large and medium aerodromes, small airfields, seaplane bases,
heliports and balloonports, because the layer fades types in with zoom instead of sampling.

Usage:
    python3 tools/build_airports.py [--csv tools/_cache/airports.csv] [--out data/airports.json]
"""
import csv
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / "_cache"
CSV_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"

# Short type codes used throughout the client: legend lives in the output document.
TYPES = {
    "large_airport": "l",
    "medium_airport": "m",
    "small_airport": "s",
    "heliport": "h",
    "seaplane_base": "w",
    "balloonport": "b",
}
NAMES = {
    "l": "large airport",
    "m": "medium airport",
    "s": "small airport",
    "h": "heliport",
    "w": "seaplane base",
    "b": "balloonport",
}

MAX_RECORDS = 120000  # sanity cap: anything above means a bad parse, not growth
MIN_RECORDS = 20000   # sanity floor: a partial download must fail loudly, never ship small


def compact_record(row):
    """One airports.csv row -> positional [lon, lat, type, code, name, municipality, country].

    Code precedence is IATA, then GPS, then ICAO ident — what a rider actually recognises —
    and names are trimmed. Rows without a usable position are refused upstream instead of
    dropped here (a coordinate error is a data problem, never silently mapped to (0,0))."""
    try:
        lon = round(float(row["longitude_deg"]), 4)
        lat = round(float(row["latitude_deg"]), 4)
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"bad coordinates for {row.get('ident', '?')}")
    if not (-180 <= lon <= 180 and -90 <= lat <= 90) or (lon == 0 and lat == 0):
        raise ValueError(f"out-of-range coordinates for {row.get('ident', '?')}")
    tcode = TYPES[row["type"]]
    code = (row.get("iata_code") or row.get("gps_code") or row.get("local_code") or row.get("ident") or "").strip()
    name = (row.get("name") or "").strip()[:90]
    muni = (row.get("municipality") or "").strip()[:60]
    iso = (row.get("iso_country") or "").strip()
    return [lon, lat, tcode, code, name, muni, iso]


def build(csv_text):
    """CSV text -> output document. Raises on structurally wrong input."""
    reader = csv.DictReader(io.StringIO(csv_text))
    if not reader.fieldnames or "latitude_deg" not in reader.fieldnames or "type" not in reader.fieldnames:
        raise ValueError("not an OurAirports airports.csv")
    records = []
    skipped = {"closed": 0, "bad": 0}
    for row in reader:
        kind = row.get("type", "")
        if kind == "closed":
            skipped["closed"] += 1
            continue
        if kind not in TYPES:
            skipped["bad"] += 1
            continue
        try:
            records.append(compact_record(row))
        except ValueError:
            skipped["bad"] += 1
    if len(records) > MAX_RECORDS or len(records) < MIN_RECORDS:
        raise ValueError(f"suspicious record count {len(records)}")
    # Large airports first: the client can stop reading early at low zoom if it ever needs to.
    order = "lmswhb"
    records.sort(key=lambda r: (order.index(r[2]), r[4]))
    return {
        "source": {
            "name": "OurAirports",
            "url": "https://ourairports.com/data/",
            "license": "public domain",
            "csv": CSV_URL,
        },
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "types": NAMES,
        "count": len(records),
        "skipped": skipped,
        "records": records,
    }


def main():
    csv_arg = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--csv=")), None)
    out_arg = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--out=")), None)
    out_path = Path(out_arg) if out_arg else ROOT / "data" / "airports.json"
    if csv_arg:
        text = Path(csv_arg).read_text(encoding="utf-8")
    else:
        CACHE.mkdir(exist_ok=True)
        cache = CACHE / "airports.csv"
        req = urllib.request.Request(CSV_URL, headers={"User-Agent": "godseye-build/1.0"})
        text = urllib.request.urlopen(req, timeout=120).read().decode("utf-8")
        cache.write_text(text, encoding="utf-8")
    doc = build(text)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    kb = out_path.stat().st_size // 1024
    print(f"wrote {out_path} — {doc['count']} aerodromes ({kb} KB), skipped {doc['skipped']}")


if __name__ == "__main__":
    main()
