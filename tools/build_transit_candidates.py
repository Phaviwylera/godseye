#!/usr/bin/env python3
"""Build a candidate list of keyless, worldwide GTFS-Realtime vehicle feeds.

The registry's rule is that a network is drawn where its operator publishes positions, and a
candidate is only promoted into data/transit.json after tools/probe_transit.py has seen it
answer with real vehicles. This tool supplies the candidates from somewhere better than
memory: the Mobility Database catalogs CSV, which lists ~1,800 mobility feeds with their
licence, country and whether they need a key.

It needs network access, so it runs in CI (.github/workflows/probe-transit.yml) or by hand.
The selector itself — the part that must never be wrong — is a pure function and is unit-tested
offline in tests/test_build_transit_candidates.py.

Usage:
    python3 tools/build_transit_candidates.py                     # fetch, filter, write
    python3 tools/build_transit_candidates.py --csv local.csv      # filter a saved copy
    python3 tools/build_transit_candidates.py --per-country 2 --limit 60
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import urllib.request
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "data" / "transit.json"
OUT = ROOT / "data" / "transit-candidates.json"
CATALOG = "https://storage.googleapis.com/storage/v1/b/mdb-csv/o/sources.csv?alt=media"
USER_AGENT = "godseye-transit-candidates/1.0 (+https://github.com/Phaviwylera/godseye)"

# Only these columns are needed; the CSV has ~23 and its schema has grown before.
FIELDS = {
    "id": "mdb_source_id",
    "dataType": "data_type",
    "entityType": "entity_type",
    "country": "location.country_code",
    "subdivision": "location.subdivision_name",
    "municipality": "location.municipality",
    "provider": "provider",
    "name": "name",
    "url": "urls.direct_download",
    "auth": "urls.authentication_type",
    "license": "urls.license",
    "latest": "urls.latest",
    "status": "status",
}

# authentication_type in the catalogs CSV: 0 = no key, 1 = key required, 2 = unknown/other.
KEYLESS = {"0", "", "none", "false", "no"}


def fetch_catalog(url: str = CATALOG, timeout: float = 120.0) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def select_candidates(rows: list[dict], registered: list[dict] | None = None,
                      per_country: int = 1, limit: int = 40) -> list[dict]:
    """Filter the catalog down to keyless, HTTPS vehicle-position feeds the app can draw.

    Purity matters here: this runs over a third-party CSV whose schema drifts, and a feed that
    slipped through with a key requirement would sit in the registry permanently unavailable —
    the exact thing the registry's notes promise never happens.
    """
    known = set()
    known_hosts = set()
    for feed in registered or []:
        base = str(feed.get("base") or "")
        if base:
            known.add(base.split("?")[0].rstrip("/").lower())
            host = base.split("//", 1)[-1].split("/", 1)[0].lower()
            if host:
                known_hosts.add(host)

    by_country: dict[str, list[dict]] = OrderedDict()
    for row in rows:
        if str(row.get("dataType") or "").strip().lower() not in ("gtfs-rt", "gtfs_rt", "gtfsrt"):
            continue
        if "vp" not in str(row.get("entityType") or "").lower():
            continue
        if str(row.get("auth") or "").strip().lower() not in KEYLESS:
            continue
        url = str(row.get("url") or "").strip()
        if not url.lower().startswith("https://") or "key=" in url.lower():
            continue
        host = url.split("//", 1)[-1].split("/", 1)[0].lower()
        if url.split("?")[0].rstrip("/").lower() in known or host in known_hosts:
            continue          # already in the registry under this endpoint or operator host
        country = str(row.get("country") or "").strip().upper() or "XX"
        place = str(row.get("municipality") or row.get("subdivision") or "").strip()
        provider = str(row.get("provider") or "").strip()
        by_country.setdefault(country, []).append({
            "source": "Mobility Database catalogs CSV",
            "mdbId": str(row.get("id") or "").strip(),
            "country": country,
            "city": place or provider or "Unknown",
            "operator": provider or place or "Unknown",
            "network": str(row.get("name") or "").strip() or f"{provider} vehicle positions",
            "base": url,
            "license": str(row.get("license") or "").strip(),
            "catalogUrl": str(row.get("latest") or "").strip(),
        })

    out: list[dict] = []
    for country in sorted(by_country):
        out.extend(by_country[country][:max(1, per_country)])
    return out[:limit]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--csv", help="use a saved copy of the catalog CSV instead of fetching")
    parser.add_argument("--registry", default=str(REGISTRY))
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--per-country", type=int, default=1, help="how many feeds per country")
    parser.add_argument("--limit", type=int, default=40)
    args = parser.parse_args(argv)

    text = Path(args.csv).read_text(encoding="utf-8") if args.csv else fetch_catalog()
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for raw in reader:
        rows.append({key: (raw.get(column) or "") for key, column in FIELDS.items()})

    registry = json.loads(Path(args.registry).read_text(encoding="utf-8"))
    candidates = select_candidates(rows, registry.get("feeds", []),
                                   per_country=args.per_country, limit=args.limit)
    payload = {
        "note": "Candidate keyless GTFS-Realtime vehicle feeds selected from the Mobility Database "
                "catalogs CSV. Nothing here is drawn: a candidate is promoted into data/transit.json "
                "only after tools/probe_transit.py sees it answer with real vehicles twice.",
        "source": CATALOG,
        "sourceLicense": "Mobility Database catalogs (CC BY 4.0 for the catalog metadata)",
        "selected": len(candidates),
        "from": len(rows),
        "candidates": candidates,
    }
    Path(args.out).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"{len(rows)} catalog rows → {len(candidates)} keyless candidates → {args.out}")
    for candidate in candidates:
        print(f"  {candidate['country']:<3} {candidate['city'][:28]:<30} {candidate['base'][:78]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
