#!/usr/bin/env python3
"""Build data/ofac.json from the U.S. Treasury OFAC Specially Designated
Nationals (SDN) list XML — the same public document sanction-watch services
use, cited in every flagged card.

We extract only what the app needs to cross-check against live ADS-B/AIS
contacts:
  aircraft — designated aircraft (by registration, SDNReg)
  vessels  — designated vessels (by IMO, SDNIMONumber, and by name, since
             public AIS feeds rarely carry the IMO; name matches are labelled
             as name matches in the UI)

The download is large (~20 MB); the cache dir makes re-runs resumable and the
sanity floors refuse a partial parse instead of shipping a thin list.

Usage:
    python3 tools/build_ofac.py [--xml tools/_cache/sdn.xml] [--out data]
"""
import argparse
import json
import os
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / "_cache"
SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.xml"
USER_AGENT = "godseye-data-build (open data mirror; contact: repo maintainer)"

FLOORS = {"aircraft": 50, "vessels": 500}
CAPS = {"aircraft": 20000, "vessels": 200000}


def _first_text(elem, tag):
    for child in elem.iter(tag):
        text = (child.text or "").strip()
        if text:
            return text
    return ""


def _all_text(elem, tag):
    return [ (child.text or "").strip() for child in elem.iter(tag) if (child.text or "").strip() ]


def parse_sdn(xml_text):
    """SDN XML -> {'aircraft': [{reg, name, reason}], 'vessels': [{imo, name, reason}]}.

    Lenient on purpose: the Treasury file is machine-generated but not schema
    versioned forever — an entry is kept when it has an identifying field
    (registration for aircraft, IMO or name for vessels)."""
    root = ET.fromstring(xml_text)
    aircraft, vessels = {}, {}
    for entry in root.iter("SDNEntry"):
        etype = _first_text(entry, "Type").strip().lower()
        name = _first_text(entry, "Name") or " ".join(_all_text(entry, "PrimaryName")) or "Unknown"
        name = " ".join(name.split())
        reason = "; ".join(dict.fromkeys(_all_text(entry, "SDNReason")))[:220]
        regs = [_first_text(r, "SDNReg") for r in entry.iter("SDNReg")]
        regs = [r.strip().upper() for r in regs if r.strip()]
        imo = _first_text(entry, "SDNIMONumber").strip()
        if etype == "aircraft":
            for reg in regs or ["?"]:
                if reg != "?" and reg not in aircraft:
                    aircraft[reg] = {"reg": reg, "name": name, "reason": reason}
            if not regs and name and name != "Unknown":
                # Rarely the entry names the aircraft without a clean registration.
                aircraft.setdefault(name.upper(), {"reg": name.upper(), "name": name, "reason": reason})
        elif etype == "vessel":
            key = imo or name.upper()
            if key and key not in vessels:
                vessels[key] = {"imo": imo, "name": name, "reason": reason}
    return {"aircraft": list(aircraft.values()), "vessels": list(vessels.values())}


def _check(name, rows):
    if len(rows) < FLOORS[name]:
        raise SystemExit(f"ofac {name}: only {len(rows)} rows (< floor {FLOORS[name]}) — partial parse, refusing to ship")
    if len(rows) > CAPS[name]:
        raise SystemExit(f"ofac {name}: {len(rows)} rows (> cap {CAPS[name]}) — bad parse, refusing to ship")


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    size = os.path.getsize(dest)
    if size < 1_000_000:  # the real document is tens of MB
        raise SystemExit(f"sdn.xml too small ({size} bytes) — download refused as partial")
    return dest


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--xml", default=str(CACHE / "sdn.xml"))
    ap.add_argument("--out", default=str(ROOT / "data"))
    args = ap.parse_args(argv)
    xml_path = Path(args.xml)
    if not xml_path.exists() or xml_path.stat().st_size < 1_000_000:
        CACHE.mkdir(parents=True, exist_ok=True)
        print("downloading OFAC SDN list…")
        download(SDN_URL, xml_path)
    print("parsing…")
    doc = parse_sdn(xml_path.read_text(encoding="utf-8", errors="replace"))
    _check("aircraft", doc["aircraft"])
    _check("vessels", doc["vessels"])
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = {
        "source": "U.S. Treasury Office of Foreign Assets Control — Specially Designated Nationals (SDN) list (public document)",
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "url": SDN_URL,
        "counts": {"aircraft": len(doc["aircraft"]), "vessels": len(doc["vessels"])},
        "aircraft": doc["aircraft"],
        "vessels": doc["vessels"],
    }
    path = out_dir / "ofac.json"
    path.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    try:
        shown = path.relative_to(ROOT)
    except ValueError:
        shown = path
    print(f"  ofac: {out['counts']} -> {shown}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
