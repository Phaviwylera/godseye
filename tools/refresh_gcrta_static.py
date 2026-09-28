#!/usr/bin/env python3
"""Distil GCRTA's public static GTFS into map geometry and station dots.

The live feed is GTFS-Realtime VehiclePositions.  This companion snapshot keeps
only rail routes, their representative shapes and rail stations, so the browser
does not need to download or unzip the full schedule at runtime.
"""
import csv
import io
import json
import os
import sys
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://www.riderta.com/sites/default/files/gtfs/latest/google_transit.zip"
OUT = os.path.join(ROOT, "data", "gcrta-static.json")
UA = "GodsEyeCCTV/1.0 (static GTFS refresh; github.com/Phaviwylera/godseye)"
RAIL_TYPES = {"0", "1", "2"}


def rows(archive, name):
    with archive.open(name) as file:
        yield from csv.DictReader(io.TextIOWrapper(file, encoding="utf-8-sig", newline=""))


def point(row):
    try:
        lon, lat = float(row["stop_lon"]), float(row["stop_lat"])
    except (KeyError, TypeError, ValueError):
        return None
    return lon, lat


def simplify(coords, limit=300):
    """Keep a bounded representative shape without changing its endpoints."""
    if len(coords) <= limit:
        return coords
    step = (len(coords) - 1) / (limit - 1)
    return [coords[round(i * step)] for i in range(limit)]


def main():
    request = urllib.request.Request(URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = response.read()
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        required = {"routes.txt", "trips.txt", "stop_times.txt", "shapes.txt", "stops.txt"}
        names = {name.rsplit('/', 1)[-1] for name in archive.namelist()}
        if not required <= names:
            raise RuntimeError("GTFS archive lacks routes, trips, stop_times, shapes or stops")
        route_meta = {}
        for route in rows(archive, "routes.txt"):
            if str(route.get("route_type", "")) not in RAIL_TYPES:
                continue
            route_id = str(route.get("route_id") or "").strip()
            if route_id:
                route_meta[route_id] = {
                    "name": str(route.get("route_long_name") or route.get("route_short_name") or route_id).strip(),
                    "color": "#" + str(route.get("route_color") or "8be9fa").strip().lstrip("#"),
                }
        # Keep a few different rail shapes per route. A separate shape can be a branch
        # (rather than a duplicate direction), which matters for GCRTA's light rail.
        rail_trip_ids, route_shapes = set(), defaultdict(list)
        for trip in rows(archive, "trips.txt"):
            route_id = str(trip.get("route_id") or "")
            trip_id, shape_id = str(trip.get("trip_id") or ""), str(trip.get("shape_id") or "")
            if route_id not in route_meta:
                continue
            if trip_id:
                rail_trip_ids.add(trip_id)
            if shape_id and shape_id not in route_shapes[route_id] and len(route_shapes[route_id]) < 8:
                route_shapes[route_id].append(shape_id)
        rail_stop_ids = set()
        for stop_time in rows(archive, "stop_times.txt"):
            if str(stop_time.get("trip_id") or "") in rail_trip_ids:
                stop_id = str(stop_time.get("stop_id") or "").strip()
                if stop_id:
                    rail_stop_ids.add(stop_id)
        shapes = defaultdict(list)
        wanted = {shape_id for shape_ids in route_shapes.values() for shape_id in shape_ids}
        for row in rows(archive, "shapes.txt"):
            shape_id = str(row.get("shape_id") or "")
            if shape_id not in wanted:
                continue
            try:
                shapes[shape_id].append((int(float(row.get("shape_pt_sequence") or 0)),
                    [round(float(row["shape_pt_lon"]), 6), round(float(row["shape_pt_lat"]), 6)]))
            except (KeyError, TypeError, ValueError):
                continue
        lines = []
        for route_id, shape_ids in route_shapes.items():
            for index, shape_id in enumerate(shape_ids, 1):
                coords = [coord for _, coord in sorted(shapes.get(shape_id, []))]
                if len(coords) > 1:
                    suffix = "" if len(shape_ids) == 1 else f"-{index}"
                    lines.append({"id": f"{route_id}{suffix}", **route_meta[route_id], "coords": simplify(coords)})
        stations, seen_stations = [], set()
        for stop in rows(archive, "stops.txt"):
            stop_id = str(stop.get("stop_id") or "").strip()
            parent = str(stop.get("parent_station") or "").strip()
            # This is the important filter: no bus stops in the static rail layer.
            if stop_id not in rail_stop_ids and parent not in rail_stop_ids:
                continue
            if str(stop.get("location_type") or "0") not in {"", "0", "1"}:
                continue
            pos = point(stop)
            name = str(stop.get("stop_name") or stop_id).strip()
            station_id = parent or stop_id
            if not pos or not station_id or not name or station_id in seen_stations:
                continue
            seen_stations.add(station_id)
            stations.append({"id": station_id, "name": name, "lon": round(pos[0], 6), "lat": round(pos[1], 6)})
    if len(lines) < 1 or len(stations) < 10:
        raise RuntimeError("GTFS extraction was unexpectedly empty; refusing to replace snapshot")
    data = {"v": 1, "generated": datetime.now(timezone.utc).isoformat(), "source": URL,
            "attribution": "GCRTA public static GTFS", "lines": lines, "stations": stations}
    with open(OUT, "w", encoding="utf-8") as file:
        json.dump(data, file, separators=(",", ":"))
    print(f"wrote {OUT}: {len(lines)} lines, {len(stations)} stops ({os.path.getsize(OUT):,} bytes)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"refresh failed: {error}", file=sys.stderr)
        raise
