#!/usr/bin/env python3
"""Probe every GTFS-Realtime feed in data/transit.json and report what each one answers.

The TRANSIT layer's rule is that a network is only drawn where its operator publishes
positions. That rule is worthless if nobody checks the feeds, because the failure mode is
silent: a dead key, a moved endpoint or a producer that changed its protobuf field map all
look exactly the same from the map — an empty city. This tool asks each feed directly and
prints what it actually said:

    FEED           HTTP     BYTES  ENTITIES  DRAWN  MAP       VERDICT
    delhi-dtc      200    412,904       651    651  current   live
    atlanta-marta  200     38,210       180    178  current   live (2 stale)

It needs network access, so it is meant to be run by hand or by CI (see
.github/workflows/probe-transit.yml), not by the offline unit tests. The protobuf reader is
dependency-free and is unit-tested offline in tests/test_probe_transit.py against
hand-built frames for both field maps.

Usage:
    python3 tools/probe_transit.py                 # probe every gtfsrt feed
    python3 tools/probe_transit.py --feed delhi-dtc
    python3 tools/probe_transit.py --json data/transit-probe.json
    python3 tools/probe_transit.py --strict        # exit 1 if any feed is not live

Keys: a feed naming `keyEnv` is probed with `os.environ[feed['keyEnv']]` when that variable
is set, and with the URL in data/transit.json otherwise. In CI, set the repository secret
and pass it through as an environment variable.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "data" / "transit.json"
USER_AGENT = "godseye-transit-probe/1.0 (+https://github.com/Phaviwylera/godseye)"
EPOCH_FLOOR = 946684800          # 2000-01-01: earlier than this is not an epoch timestamp


# --------------------------------------------------------------------------- wire reader
"""A minimal protobuf reader: GTFS-Realtime is protobuf, and a whole dependency (or a
compiled schema) is not warranted to read four numbers out of a VehiclePosition. Both
field maps described in js/transit.js are decoded — the bytes say which they carry."""


def read_varint(data: bytes, index: int) -> tuple[int, int]:
    result = 0
    shift = 0
    pos = index
    while True:
        if pos >= len(data):
            raise ValueError("truncated varint")
        byte = data[pos]
        pos += 1
        result += (byte & 0x7F) * (2 ** shift)
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def read_fields(data: bytes) -> list[tuple[int, int, object]]:
    out: list[tuple[int, int, object]] = []
    i = 0
    while i < len(data):
        key, i = read_varint(data, i)
        field, wire = divmod(key, 8)
        if wire == 0:
            value, i = read_varint(data, i)
            out.append((field, wire, value))
        elif wire == 1:
            if i + 8 > len(data):
                raise ValueError("truncated fixed64")
            out.append((field, wire, data[i:i + 8]))
            i += 8
        elif wire == 2:
            length, i = read_varint(data, i)
            if i + length > len(data):
                raise ValueError("truncated length-delimited field")
            out.append((field, wire, data[i:i + length]))
            i += length
        elif wire == 5:
            if i + 4 > len(data):
                raise ValueError("truncated fixed32")
            out.append((field, wire, data[i:i + 4]))
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
    return out


def fixed32(raw: bytes) -> float:
    return struct.unpack("<f", raw)[0]


def text(raw: bytes) -> str:
    return raw.decode("utf-8", "replace")


def sub(fields, number):
    for field, wire, value in fields:
        if field == number and wire == 2:
            return read_fields(value)
    return None


def num(fields, number):
    for field, wire, value in fields:
        if field == number and wire == 0:
            return value
    return None


def string(fields, number):
    for field, wire, value in fields:
        if field == number and wire == 2:
            return text(value)
    return None


def fixed(fields, number):
    for field, wire, value in fields:
        if field == number and wire == 5:
            return fixed32(value)
    return None


# ------------------------------------------------------------------- VehiclePosition map
POSITION_FIELDS = (2, 3)          # current spec first, legacy second
TIME_FIELDS = (5, 7)              # one is the timestamp, the other the stop_id
VEHICLE_FIELDS = (8, 2)


def looks_like_position(fields) -> bool:
    return any(field == 1 and wire == 5 for field, wire, _ in fields or [])


def find_position(vp):
    for number in POSITION_FIELDS:
        candidate = sub(vp, number)
        if candidate and looks_like_position(candidate):
            return candidate, ("current" if number == 2 else "legacy")
    for field, wire, value in vp:
        if wire != 2 or field == 1:
            continue
        try:
            candidate = read_fields(value)
        except ValueError:
            continue
        if looks_like_position(candidate):
            return candidate, "inferred"
    return None, None


def find_timestamp(vp, fallback, now):
    for number in TIME_FIELDS:
        for field, wire, value in vp:
            if field == number and wire == 0 and EPOCH_FLOOR < value < now + 86400:
                return value
    return fallback


def find_stop_id(vp):
    for number in TIME_FIELDS:
        for field, wire, value in vp:
            if field == number and wire == 2:
                return text(value).strip()
    return ""


def find_vehicle(vp):
    for number in VEHICLE_FIELDS:
        candidate = sub(vp, number)
        if candidate and not looks_like_position(candidate):
            return candidate
    return None


def decode_vehicle_positions(payload: bytes, max_age_sec: int = 600, now: float | None = None):
    """Decode a FeedMessage into positioned vehicles plus a report of what was seen."""
    now = time.time() if now is None else now
    report = {
        "bytes": len(payload), "entities": 0, "withPosition": 0, "stale": 0,
        "badCoords": 0, "kept": 0, "map": None, "headerSeconds": None,
        "explicitTimestamps": 0, "newestSeconds": None, "oldestSeconds": None,
    }
    vehicles: list[dict] = []
    message = read_fields(payload)
    header = sub(message, 1) or []
    header_seconds = num(header, 3)
    report["headerSeconds"] = header_seconds
    fallback = header_seconds
    for entity_index, (field, wire, value) in enumerate(message):
        if field != 2 or wire != 2:
            continue
        vp = sub(read_fields(value), 4)
        if not vp:
            continue
        report["entities"] += 1
        position, field_map = find_position(vp)
        if not position:
            continue
        report["withPosition"] += 1
        if not report["map"]:
            report["map"] = field_map
        lat = fixed(position, 1)
        lon = fixed(position, 2)
        if lat is None or lon is None or (lat == 0 and lon == 0) or abs(lat) > 90 or abs(lon) > 180:
            report["badCoords"] += 1
            continue
        explicit = any(field in TIME_FIELDS and wire == 0 for field, wire, _ in vp)
        if explicit:
            report["explicitTimestamps"] += 1
        seconds = find_timestamp(vp, fallback, now)
        if seconds is not None:
            report["newestSeconds"] = seconds if report["newestSeconds"] is None else max(report["newestSeconds"], seconds)
            report["oldestSeconds"] = seconds if report["oldestSeconds"] is None else min(report["oldestSeconds"], seconds)
        if seconds is None or (now - seconds) > max_age_sec:
            report["stale"] += 1
            continue
        trip = sub(vp, 1) or []
        descriptor = find_vehicle(vp) or []
        vehicles.append({
            "key": f"{string(descriptor, 1) or string(trip, 1) or f'{lat},{lon}'}".strip(),
            "route": (string(trip, 5) or "").strip(),
            "label": (string(descriptor, 2) or string(descriptor, 1) or "").strip(),
            "lat": round(lat, 5), "lon": round(lon, 5),
            "bearing": fixed(position, 3), "speed": fixed(position, 5),
            "stopId": find_stop_id(vp), "observed": int(seconds),
        })
    report["kept"] = len(vehicles)
    return vehicles, report


# ------------------------------------------------------------------------------- probing
def endpoint_for(feed: dict) -> str:
    url = str(feed.get("base") or "")
    env_name = str(feed.get("keyEnv") or "")
    key = (os.environ.get(env_name) or "").strip() if env_name else ""
    if not key or "key=" not in url:
        return url
    head, _, tail = url.partition("key=")
    rest = tail.split("&", 1)[1] if "&" in tail else ""
    return f"{head}key={urllib.parse.quote(key)}" + (f"&{rest}" if rest else "")


def fetch(url: str, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status or 200), response.read()
    except urllib.error.HTTPError as exc:
        return int(exc.code), (exc.read() or b"")[:2048]
    except Exception as exc:                                     # DNS, TLS, timeout …
        return 0, str(exc).encode("utf-8", "replace")[:512]


def clock_hint(report: dict, now: float | None = None) -> str:
    """When every report is too old to draw, is it a constant clock offset?

    A producer whose server clock is set to local time — Delhi's is UTC+05:30 — publishes
    timestamps that are a whole number of hours away from POSIX. From the map that looks
    exactly like a dead feed: every vehicle is dropped, nothing is drawn. The offset has to
    be named before it is corrected, because guessing it in the client would be inventing
    positions the operator never timestamped.
    """
    newest = report.get("newestSeconds")
    if newest is None:
        return ""
    now = time.time() if now is None else now
    age = now - newest                      # > 0: the feed is behind; < 0: ahead
    if abs(age) < 300:
        return ""
    hours = abs(age) / 3600.0
    direction = "behind" if age > 0 else "ahead of"
    correction = f"+{hours:.2f}" if age > 0 else f"-{hours:.2f}"     # what to add to the feed
    return (f"every report is stale: the newest is {hours:.2f} h {direction} this clock "
            f"— a constant {correction} h correction would make them fresh")


def verdict_for(report: dict) -> str:
    """One verdict line per feed, straight from the counts — never a guess at why."""
    kept = int(report.get("kept") or 0)
    entities = int(report.get("entities") or 0)
    if kept:
        return "live" if kept == entities else f"live ({entities - kept} dropped)"
    if entities:
        return "empty: answered with entities but none are drawable"
    return "empty: answered with no vehicle entities"


def probe_feed(feed: dict, timeout: float = 20.0) -> dict:
    url = endpoint_for(feed)
    max_age = int(feed.get("maxAgeSec") or 600)
    started = time.time()
    status, payload = fetch(url, timeout)
    row = {
        "id": feed.get("id"), "city": feed.get("city"), "network": feed.get("network"),
        "status": status, "ms": int((time.time() - started) * 1000), "url": url,
    }
    if status != 200:
        row.update(verdict="unreachable", detail=payload.decode("utf-8", "replace").strip()[:160])
        return row
    try:
        vehicles, report = decode_vehicle_positions(payload, max_age_sec=max_age)
    except ValueError as exc:
        row.update(verdict="undecodable", detail=str(exc), bytes=len(payload))
        return row
    row.update(report)
    row["sample"] = vehicles[:3]
    row["verdict"] = verdict_for(report)
    return row


def probe_registry(registry: dict, only: str | None = None, timeout: float = 20.0) -> list[dict]:
    feeds = [f for f in registry.get("feeds", []) if f.get("adapter") == "gtfsrt"]
    if only:
        feeds = [f for f in feeds if f.get("id") == only]
        if not feeds:
            feeds = [f for f in registry.get("feeds", []) if f.get("id") == only]
    return [probe_feed(feed, timeout=timeout) for feed in feeds]


def probe_candidates(path: str, timeout: float = 20.0) -> list[dict]:
    """Probe the candidate list built by tools/build_transit_candidates.py.

    A candidate is a proposal, not a registry entry: it is only promoted once this has seen it
    answer with real vehicles, so nothing enters data/transit.json on the strength of a
    catalogue row alone.
    """
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = []
    for candidate in document.get("candidates", []):
        feed = dict(candidate)
        feed.setdefault("maxAgeSec", 600)
        row = probe_feed(feed, timeout=timeout)
        row["promotable"] = bool(row.get("kept")) and row.get("status") == 200
        rows.append(row)
    return rows


def format_rows(rows: list[dict]) -> str:
    head = f"{'FEED':<16}{'CITY':<16}{'HTTP':>5}{'BYTES':>10}{'ENTITIES':>10}{'DRAWN':>7}  {'MAP':<9}VERDICT"
    lines = [head, "-" * len(head)]
    for row in rows:
        lines.append(
            f"{str(row.get('id') or '')[:15]:<16}{str(row.get('city') or '')[:15]:<16}"
            f"{row.get('status', 0):>5}{row.get('bytes', 0):>10,}{row.get('entities', 0):>10}"
            f"{row.get('kept', 0):>7}  {str(row.get('map') or '—'):<9}{row.get('verdict', '')}"
        )
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--registry", default=str(REGISTRY), help="path to data/transit.json")
    parser.add_argument("--feed", help="probe one feed id only")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--json", dest="json_out", help="write the report as JSON to this path")
    parser.add_argument("--candidates", help="probe data/transit-candidates.json instead of the registry")
    parser.add_argument("--strict", action="store_true",
                        help="exit 1 unless every probed feed answered and drew vehicles")
    args = parser.parse_args(argv)

    if args.candidates:
        rows = probe_candidates(args.candidates, timeout=args.timeout)
    else:
        registry = json.loads(Path(args.registry).read_text(encoding="utf-8"))
        rows = probe_registry(registry, only=args.feed, timeout=args.timeout)
    print(format_rows(rows))
    for row in rows:
        if row.get("verdict") not in ("live",) and not str(row.get("verdict", "")).startswith("live ("):
            detail = row.get("detail") or ""
            print(f"  ! {row.get('id')}: {row.get('verdict')}{(' — ' + detail) if detail else ''}")
            hint = clock_hint(row)
            if hint:
                print(f"    ↳ {hint}")
            if row.get("entities") and not row.get("explicitTimestamps"):
                print("    ↳ no entity carries its own timestamp: the feed header's is used for every vehicle")

    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({
            "probedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "feeds": rows,
        }, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {args.json_out}")

    if args.strict and any(not str(r.get("verdict", "")).startswith("live") for r in rows):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
