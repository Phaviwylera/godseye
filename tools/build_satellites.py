#!/usr/bin/env python3
"""Snapshot a small CelesTrak OMM catalog for client-side SGP4 propagation."""
import json
import os
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=JSON"
GROUPS = ("STATIONS", "GPS-OPS")


def fetch_group(group):
    req = urllib.request.Request(BASE.format(group), headers={
        "User-Agent": "GodsEye/1.0 (public orbital catalog; github.com/Phaviwylera/godseye)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=25) as response:
        data = json.load(response)
    if not isinstance(data, list) or not data:
        raise ValueError(f"No orbital elements for {group}")
    records = []
    now = datetime.now(timezone.utc)
    for row in data:
        if not isinstance(row, dict) or not all(k in row for k in
                ("OBJECT_NAME", "NORAD_CAT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY")):
            continue
        epoch = datetime.fromisoformat(row["EPOCH"].replace("Z", "+00:00"))
        if epoch.tzinfo is None:
            epoch = epoch.replace(tzinfo=timezone.utc)
        if abs((now - epoch).total_seconds()) > 14 * 86400:
            continue
        records.append({**row, "group": group})
    if not records:
        raise ValueError(f"No recent orbital elements for {group}")
    return records


def main():
    records = [row for group in GROUPS for row in fetch_group(group)]
    result = {"source": "CelesTrak GP JSON OMM", "generated": datetime.now(timezone.utc).isoformat(),
              "groups": list(GROUPS), "records": records}
    path = os.path.join(ROOT, "data", "satellites.json")
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(result, f, separators=(",", ":"))
    os.replace(temp, path)
    print(f"wrote {len(records)} orbital elements to {path}")


if __name__ == "__main__":
    main()
