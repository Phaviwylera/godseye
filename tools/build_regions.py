#!/usr/bin/env python3
"""
GOD'S EYE — build progressive-load region packs + compact camera index.

Reads data/cameras.geojson (+ optional data/liveness.json) and writes:
  data/cameras.index.json   slim global index for fast first paint
  data/regions/<pack>.json  full camera records per country / US-state pack
  data/regions/manifest.json

Countries with >= SPLIT_MIN cameras are split by region/state so a single
viewport load stays small. Run after tools/build_dataset.py (or standalone).
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPLIT_MIN = 800


def main():
    src_path = os.path.join(ROOT, "data", "cameras.geojson")
    if not os.path.exists(src_path):
        print("missing data/cameras.geojson", file=sys.stderr)
        sys.exit(1)

    src = json.load(open(src_path))
    lv = {}
    lv_path = os.path.join(ROOT, "data", "liveness.json")
    if os.path.exists(lv_path):
        try:
            lv = json.load(open(lv_path)).get("s") or {}
        except Exception:
            pass

    out_dir = os.path.join(ROOT, "data", "regions")
    os.makedirs(out_dir, exist_ok=True)
    for fn in os.listdir(out_dir):
        if fn.endswith(".json"):
            os.remove(os.path.join(out_dir, fn))

    from collections import defaultdict
    by_cc = defaultdict(list)
    index_feats = []

    for f in src["features"]:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        cc = (p.get("country") or "XX").upper()[:2] or "XX"
        region = (p.get("region") or "").strip()
        live = lv.get(p["id"])
        idx = {
            "id": p["id"],
            "n": p.get("name") or "Camera",
            "s": p.get("src") or "",
            "t": p.get("stype") or "embed",
            "c": cc,
            "r": region,
            "p": p.get("place") or "",
            "lon": round(float(lon), 5),
            "lat": round(float(lat), 5),
        }
        if live is not None:
            idx["l"] = int(live)
        index_feats.append(idx)

        full = {
            "id": p["id"], "name": p.get("name") or "Camera", "src": p.get("src") or "",
            "stype": p.get("stype") or "embed", "stream": p.get("stream") or "",
            "country": cc, "region": region, "place": p.get("place") or "",
            "dir": p.get("dir") or "", "attr": p.get("attr") or "",
            "status": p.get("status") or "unknown", "page": p.get("page") or "",
            "lon": float(lon), "lat": float(lat),
        }
        if live is not None:
            full["live"] = int(live)
        by_cc[cc].append((region, full, idx))

    final_packs = defaultdict(list)
    country_counts = {cc: len(rows) for cc, rows in by_cc.items()}

    for cc, rows in by_cc.items():
        if country_counts[cc] >= SPLIT_MIN:
            for region, full, idx in rows:
                if cc == "US" and len(region) == 2:
                    sub = region.upper()
                elif region:
                    sub = region.upper().replace(" ", "")[:6]
                else:
                    sub = "OTHER"
                key = f"{cc}-{sub}"
                final_packs[key].append(full)
                idx["pk"] = key
        else:
            for region, full, idx in rows:
                final_packs[cc].append(full)
                idx["pk"] = cc

    manifest = {
        "v": 1,
        "total": len(index_feats),
        "generated_from": src.get("generated_at"),
        "packs": {},
    }
    for key, rows in sorted(final_packs.items()):
        path = os.path.join(out_dir, f"{key}.json")
        with open(path, "w") as f:
            json.dump({"pack": key, "cams": rows}, f, separators=(",", ":"))
        manifest["packs"][key] = {"count": len(rows), "bytes": os.path.getsize(path)}

    with open(os.path.join(ROOT, "data", "cameras.index.json"), "w") as f:
        json.dump({"v": 1, "count": len(index_feats), "cams": index_feats}, f, separators=(",", ":"))
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))

    idx_sz = os.path.getsize(os.path.join(ROOT, "data", "cameras.index.json"))
    print(f"wrote cameras.index.json ({idx_sz/1e6:.2f} MB, {len(index_feats)} cams)")
    print(f"wrote {len(final_packs)} region packs → data/regions/")
    largest = max(manifest["packs"].items(), key=lambda x: x[1]["bytes"])
    print(f"largest pack: {largest[0]} ({largest[1]['count']} cams, {largest[1]['bytes']/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
