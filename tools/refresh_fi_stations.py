#!/usr/bin/env python3
"""Bundle Digitraffic's public railway station table for the transit layer.

The app only needs a station short code, a human name and WGS84 coordinates to
place the train reports. Keeping that distilled table under data/ removes the
per-session metadata relay request while retaining the source attribution.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://rata.digitraffic.fi/api/v1/metadata/stations"
OUT = os.path.join(ROOT, "data", "fi-stations.json")
UA = "GodsEyeCCTV/1.0 (static station refresh; github.com/Phaviwylera/godseye)"


def compact(rows):
    out = []
    seen = set()
    for row in rows if isinstance(rows, list) else []:
        code = str(row.get("stationShortCode") or row.get("shortCode") or "").strip()
        name = str(row.get("stationName") or row.get("name") or code).strip()
        try:
            lon, lat = float(row["longitude"]), float(row["latitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not code or not name or not -180 <= lon <= 180 or not -90 <= lat <= 90 or (lon == 0 and lat == 0):
            continue
        if code in seen:
            continue
        seen.add(code)
        out.append({"stationShortCode": code, "stationName": name,
                    "longitude": round(lon, 6), "latitude": round(lat, 6)})
    return out


def download_rows():
    request = urllib.request.Request(URL, headers={"User-Agent": UA, "Accept": "application/json"})
    failure = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.load(response)
        except (OSError, urllib.error.HTTPError, json.JSONDecodeError) as error:
            failure = error
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"could not retrieve Digitraffic station metadata after 3 attempts: {failure}")


def main():
    rows = download_rows()
    stations = compact(rows)
    if len(stations) < 100:
        raise RuntimeError("Digitraffic returned too few usable stations; refusing to replace the snapshot")
    payload = {
        "v": 1,
        "generated": datetime.now(timezone.utc).isoformat(),
        "source": URL,
        "attribution": "Digitraffic / rata.digitraffic.fi — Finnish open railway data (CC 4.0)",
        "stations": stations,
    }
    with open(OUT, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {OUT}: {len(stations)} stations ({os.path.getsize(OUT):,} bytes)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"refresh failed: {error}", file=sys.stderr)
        raise
