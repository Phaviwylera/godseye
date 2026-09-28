#!/usr/bin/env python3
"""Build the static GEODESY infrastructure datasets used by the EVENTS layer
and the (upcoming) POWER/PORTS/CABLES map layers.

Sources (all open, cited in each output file):
  volcanoes — OpenStreetMap, natural=volcano (named), via the Overpass API
  power     — OpenStreetMap, power=plant (named), via the Overpass API
  ports     — OpenStreetMap, place=harbour / harbour=yes (named), via Overpass
  cables    — open "CABLE" GeoJSON dataset (Submarine Cable Map routes, 2019
              vintage, MIT). Candidate mirrors are tried in order; the first
              that parses wins. The vintage is recorded in the output.

Overpass is queried in four quadrants with delays between requests: a single
global query regularly times out the public endpoint, and this tool must never
ship a half-world. Every dataset has a sanity floor: a partial download fails
loudly instead of shipping small.

Usage:
    python3 tools/build_infra.py [--only volcanoes,power,ports,cables] [--out data]
"""
import argparse
import gzip
import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / "_cache"

OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"
USER_AGENT = "godseye-data-build (open data mirror; contact: repo maintainer)"
QUADRANTS = [(-180, -90, 0, 0), (0, -90, 180, 0), (-180, 0, 0, 90), (0, 0, 180, 90)]

# Sanity floors: a partial download must fail loudly, never ship small.
FLOORS = {
    "volcanoes": 800,     # OSM names ~1,300 volcanoes
    "power": 15000,       # named power=plant features
    "ports": 2500,        # named harbour features
}
CAPS = {"volcanoes": 50000, "power": 300000, "ports": 100000}

CABLE_CANDIDATES = [
    "https://gist.githubusercontent.com/shimizu/6b7123b893fca8440e70216cddfcfe52/raw/cable.geojson",
]
CABLE_FLOOR = 300  # the 2019 dataset carries 400+ cables
CABLE_VINTAGE = "2019"

# Real OSM generator tagging: generator:source=... (e.g. "nuclear", "fuel:oil",
# "water") or generator:<tech>=yes. Mapped to the short legend codes.
GENERATOR_SOURCE_MAP = {
    "solar": "solar", "wind": "wind", "water": "hydro", "hydro": "hydro",
    "nuclear": "nuclear", "geothermal": "geothermal",
    "fuel:coal": "coal", "fuel:peat": "peat", "fuel:lignite": "lignite",
    "fuel:natural_gas": "gas", "fuel:oil": "oil", "fuel:petroleum": "oil",
    "fuel:biogas": "biogas", "fuel:biomass": "biomass",
}
TECH_TAGS = [
    ("generator:solar", "solar"),
    ("generator:wind", "wind"),
    ("generator:hydro", "hydro"),
    ("generator:nuclear", "nuclear"),
    ("generator:geothermal", "geothermal"),
]


# ----------------------------------------------------------------- pure parse --

def _coord(parent):
    """(lon, lat) from an Overpass element: node lat/lon attrs, way/relation center."""
    lat = parent.get("lat")
    lon = parent.get("lon")
    if lat is None or lon is None:
        center = parent.find("center")
        if center is None:
            return None
        lat, lon = center.get("lat"), center.get("lon")
    try:
        lon = round(float(lon), 4)
        lat = round(float(lat), 4)
    except (TypeError, ValueError):
        return None
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return None
    if lon == 0 and lat == 0:
        return None
    return (lon, lat)


def _tags(elem):
    out = {}
    for t in elem.findall("tag"):
        k, v = t.get("k"), t.get("v")
        if k and v is not None:
            out[k] = v
    return out


def parse_overpass(xml_text):
    """Overpass XML -> [(osm_id, kind, lon, lat, tags)] with valid coordinates.

    Rows without a usable position are dropped (a coordinate problem is reported
    by the floors, never silently mapped to (0,0))."""
    root = ET.fromstring(xml_text)
    out = []
    for elem in root.iter():
        if elem.tag not in ("node", "way", "relation"):
            continue
        c = _coord(elem)
        if c is None:
            continue
        out.append((elem.get("id"), elem.tag, c[0], c[1], _tags(elem)))
    return out


def volcano_records(rows):
    """[(id, kind, lon, lat, tags)] -> [[lon, lat, name, ele-or-0]] for natural=volcano."""
    out = []
    for _id, _kind, lon, lat, tags in rows:
        if tags.get("natural") != "volcano" or not tags.get("name"):
            continue
        try:
            ele = int(float(tags.get("ele", 0) or 0))
        except ValueError:
            ele = 0
        out.append([lon, lat, tags["name"], ele])
    return out


def power_kind(tags):
    src = tags.get("generator:source")
    if src:
        if src in GENERATOR_SOURCE_MAP:
            return GENERATOR_SOURCE_MAP[src]
        if src.startswith("fuel:"):
            rest = src.split(":", 1)[1]
            if rest == "natural_gas":
                return "gas"
            if rest == "petroleum":
                return "oil"
            if rest in ("coal", "peat", "lignite", "oil", "biogas", "biomass"):
                return rest
    for tag, code in TECH_TAGS:
        if tags.get(tag) == "yes":
            return code
    return "other"


def power_records(rows):
    """[(id, kind, lon, lat, tags)] -> [[lon, lat, name, kind]] for power=plant."""
    out = []
    for _id, _kind, lon, lat, tags in rows:
        if tags.get("power") != "plant" or not tags.get("name"):
            continue
        out.append([lon, lat, tags["name"], power_kind(tags)])
    return out


def port_records(rows):
    """[(id, kind, lon, lat, tags)] -> [[lon, lat, name]] for named harbour places."""
    out = []
    seen = set()
    for _id, _kind, lon, lat, tags in rows:
        if not tags.get("name"):
            continue
        if tags.get("place") != "harbour" and tags.get("harbour") != "yes":
            continue
        key = (lon, lat, tags["name"].lower())
        if key in seen:
            continue
        seen.add(key)
        out.append([lon, lat, tags["name"]])
    return out


def slim_cables(geojson_doc):
    """CABLE GeoJSON -> compact document: keeps name/length/rfs/owners, drops z."""
    features = []
    for f in geojson_doc.get("features") or []:
        geom = f.get("geometry") or {}
        if geom.get("type") not in ("LineString", "MultiLineString"):
            continue
        def drop_z(coords):
            if isinstance(coords, list) and coords and isinstance(coords[0], (int, float)):
                return [c for c in coords[:2]]
            return [drop_z(c) for c in coords]
        props = f.get("properties") or {}
        name = props.get("Name") or props.get("name") or ""
        if not name:
            continue
        features.append({
            "type": "Feature",
            "properties": {
                "name": name,
                "length": props.get("length") or "",
                "rfs": props.get("rfs") or props.get("lastRefurbished") or "",
                "owners": props.get("owners") or "",
            },
            "geometry": {"type": geom["type"], "coordinates": drop_z(geom.get("coordinates") or [])},
        })
    return {"type": "FeatureCollection", "features": features}


def validate_cables(doc):
    n = len((doc or {}).get("features") or [])
    if n < CABLE_FLOOR:
        raise ValueError(f"cables dataset too small: {n} < {CABLE_FLOOR} — refusing to ship")
    return n


# ------------------------------------------------------------------- network --

def _http(url, data=None, timeout=120):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip" or raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return raw.decode("utf-8", "replace")


def overpass_selectors(query, w, s, e, n, retries=3):
    """Run one Overpass selector over one quadrant bbox (XML out), with polite
    retries. Returns the same (id, kind, lon, lat, tags) rows parse_overpass
    produces for any Overpass XML document."""
    bbox = f"({s},{w},{n},{e})"
    expr = "[out:xml][timeout:90];(" + query + bbox + ");out center tags;"
    body = urllib.parse.urlencode({"data": expr}).encode()
    last = None
    for attempt in range(retries):
        try:
            return parse_overpass(_http(OVERPASS_ENDPOINT, data=body))
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"overpass query failed after {retries} tries: {last}")


def overpass_global(query):
    rows = []
    for i, q in enumerate(QUADRANTS):
        rows.extend(overpass_selectors(query, *q))
        if i < len(QUADRANTS) - 1:
            time.sleep(4)  # public endpoint: be polite, stay under pressure
    # de-duplicate (features can cross quadrant borders)
    seen, out = set(), []
    for row in rows:
        key = (row[0], row[1])
        if key not in seen:
            seen.add(key)
            out.append(row)
    return out


def build_volcanoes(out_dir):
    rows = overpass_global('nwr["natural"="volcano"]["name"]')
    records = volcano_records(rows)
    return _write_records("volcanoes", records, out_dir,
                          "OpenStreetMap contributors (natural=volcano), CC-BY-SA, via Overpass API")


def build_power(out_dir):
    rows = overpass_global('nwr["power"="plant"]["name"]')
    records = power_records(rows)
    return _write_records("power", records, out_dir,
                          "OpenStreetMap contributors (power=plant), CC-BY-SA, via Overpass API")


def build_ports(out_dir):
    rows = overpass_global('nwr["place"="harbour"]["name"];nwr["harbour"="yes"]["name"]')
    records = port_records(rows)
    return _write_records("ports", records, out_dir,
                          "OpenStreetMap contributors (place=harbour), CC-BY-SA, via Overpass API")


def _write_records(name, records, out_dir, source):
    out_dir = Path(out_dir)
    floor = FLOORS[name]
    cap = CAPS[name]
    if len(records) < floor:
        raise SystemExit(f"{name}: only {len(records)} records (< floor {floor}) — partial download, refusing to ship")
    if len(records) > cap:
        raise SystemExit(f"{name}: {len(records)} records (> cap {cap}) — bad parse, refusing to ship")
    doc = {"source": source, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "count": len(records), "records": records}
    path = out_dir / f"{name}.json"
    path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    try:
        shown = path.relative_to(ROOT)
    except ValueError:
        shown = path
    print(f"  {name}: {len(records)} records -> {shown}")
    return path


def build_cables(out_dir):
    last = None
    for url in CABLE_CANDIDATES:
        try:
            doc = json.loads(_http(url, timeout=180))
            n = validate_cables(doc)
            slim = slim_cables(doc)
            doc = {
                "source": "Open 'CABLE' dataset (Submarine Cable Map routes, MIT), "
                          f"vintage {CABLE_VINTAGE} — routes are historical, not live status",
                "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "count": n,
                "url": url,
                "features": slim["features"],
            }
            path = out_dir / "cables.geojson"
            path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
            print(f"  cables: {n} cables -> {path.relative_to(ROOT)}")
            return path
        except Exception as e:  # noqa: BLE001 — try the next mirror
            last = e
    raise SystemExit(f"cables: no candidate mirror parsed: {last}")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="volcanoes,power,ports,cables",
                    help="comma list of volcanoes,power,ports,cables")
    ap.add_argument("--out", default=str(ROOT / "data"))
    args = ap.parse_args(argv)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = [w.strip() for w in args.only.split(",") if w.strip()]
    builders = {"volcanoes": build_volcanoes, "power": build_power,
                "ports": build_ports, "cables": build_cables}
    for name in wanted:
        if name not in builders:
            raise SystemExit(f"unknown dataset {name!r}")
        print(f"building {name}…")
        builders[name](out_dir)
    print("infra datasets done")


if __name__ == "__main__":
    main()
