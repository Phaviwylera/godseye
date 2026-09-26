#!/usr/bin/env python3
"""
GOD'S EYE — liveness prober.
Checks every bundled direct-media feed with a tiny ranged GET and writes
data/liveness.json:  {"generated": "...", "s": {"<cam-id>": 1|0},
                       "t": {"<cam-id>": unix_seconds}}

Only direct media is probed (m3u8, mp4, mjpeg, image, dynamic). Portal/youtube
cams are skipped — their pages block bots and would report false negatives.

Usage:
  python3 tools/check_liveness.py [--limit N] [--timeout S]
Resumable: results merge into any existing data/liveness.json.
"""
import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROBE_TYPES = {"m3u8", "mp4", "mjpeg", "image", "dynamic"}
UA = {"User-Agent": "Mozilla/5.0 GodsEyeCCTV/1.0 (liveness probe; github.com/Phaviwylera/godseye)",
      "Range": "bytes=0-2047", "Accept": "*/*"}

LIMIT = 100000 if "--limit" not in sys.argv else int(sys.argv[sys.argv.index("--limit") + 1])
TIMEOUT = 6 if "--timeout" not in sys.argv else int(sys.argv[sys.argv.index("--timeout") + 1])
WORKERS = 24


def probe(item):
    cid, url = item
    if not url:
        return cid, 0
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            chunk = r.read(64)
            ok = 1 if r.status in (200, 206, 302, 304) and (chunk or r.status == 304) else 0
            return cid, ok
    except Exception:
        return cid, 0


def main():
    cams = json.load(open(os.path.join(ROOT, "data", "cameras.geojson")))["features"]
    out_path = os.path.join(ROOT, "data", "liveness.json")
    state = {"generated": None, "s": {}, "t": {}}
    if os.path.exists(out_path):
        try:
            state = json.load(open(out_path))
            state.setdefault("s", {})
            state.setdefault("t", {})
        except Exception:
            pass

    todo = []
    for f in cams:
        p = f["properties"]
        if p.get("stype") not in PROBE_TYPES:
            continue
        todo.append((p["id"], p.get("stream") or ""))
    todo = todo[:LIMIT]
    print(f"probing {len(todo)} direct-media feeds ({WORKERS} workers, timeout {TIMEOUT}s)…")

    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(probe, it) for it in todo]
        for fut in as_completed(futs):
            cid, ok = fut.result()
            state["s"][cid] = ok
            state["t"][cid] = int(time.time())
            done += 1
            if done % 500 == 0:
                state["generated"] = datetime.now(timezone.utc).isoformat()
                with open(out_path, "w") as f:
                    json.dump(state, f, separators=(",", ":"))
                rate = done / (time.time() - t0)
                print(f"  {done}/{len(todo)}  live={sum(1 for v in state['s'].values() if v)}  ({rate:.0f}/s)")

    state["generated"] = datetime.now(timezone.utc).isoformat()
    with open(out_path, "w") as f:
        json.dump(state, f, separators=(",", ":"))
    live = sum(1 for v in state["s"].values() if v)
    print(f"done. checked={len(state['s'])} live={live} down={len(state['s']) - live}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
