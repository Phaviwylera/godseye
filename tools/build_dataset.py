#!/usr/bin/env python3
"""
GOD'S EYE — camera dataset builder
Fetches every public source listed in data/sources.json and normalizes it into
one GeoJSON FeatureCollection: data/cameras.geojson

Camera schema (Feature.properties):
  id      stable id
  name    human-readable location description
  src     source id (see sources.json)
  stype   stream type: m3u8 | image | embed | dynamic
  stream  playable URL (m3u8 playlist / jpg endpoint / html page / json refresh)
  country ISO-2
  region  state / province
  place   county / city (optional)
  dir     camera facing direction (optional)
  attr    attribution line (shown in the UI, be nice and keep it)
  status  live | unknown
  page    official info page (optional)

Usage:  python3 tools/build_dataset.py [--full]
        --full   keep every camera (big file). Default caps IMAGE_STREAM
                 per US state to keep the bundled dataset lean.
"""
import json, re, sys, urllib.request, urllib.error, gzip, io, os, hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "_cache")
os.makedirs(CACHE, exist_ok=True)

FULL = "--full" in sys.argv
IMAGE_CAP_PER_STATE = 10000 if FULL else 250
ARGUS_CAP_PER_COUNTRY = 50000 if FULL else 300

UA = {"User-Agent": "GodsEyeCCTV/1.0 (open public-camera map; +github.com)"}
TIMEOUT = 60


def fetch(url, cache_key=None, force=False):
    """GET with gzip, cached to disk so builds are resumable."""
    key = cache_key or hashlib.md5(url.encode()).hexdigest()
    path = os.path.join(CACHE, key)
    if not force and os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as f:
            return f.read()
    req = urllib.request.Request(url, headers={**UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip" or data[:2] == b"\x1f\x8b":
            try:
                data = gzip.decompress(data)
            except OSError:
                pass
    with open(path, "wb") as f:
        f.write(data)
    return data


def fetch_json(url, cache_key=None, force=False):
    return json.loads(fetch(url, cache_key, force).decode("utf-8", "replace"))


def fnum(v):
    try:
        return round(float(v), 6)
    except (TypeError, ValueError):
        return None


features = []


def add(name, lon, lat, stype, stream, src, country="US", region="", place="",
        direction="", attr="", status="unknown", page=""):
    lon, lat = fnum(lon), fnum(lat)
    if lon is None or lat is None or not stream:
        return
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return
    if stype == "m3u8" and not stream.lower().split("?")[0].endswith((".m3u8", ".m3u")):
        # still fine — some servers serve playlists without extension
        pass
    fid = f"{src}-{re.sub(r'[^a-z0-9]+', '-', (str(region)+' '+str(place)+' '+str(name)).lower())}"
    fid = re.sub(r"-+", "-", fid).strip("-")[:120]
    fid += "-" + hashlib.md5(f"{lon},{lat},{stream}".encode()).hexdigest()[:6]
    p = {"id": fid, "name": name or "Camera", "src": src, "stype": stype,
         "stream": stream, "country": country, "status": status or "unknown"}
    if region: p["region"] = region
    if place: p["place"] = place
    if direction: p["dir"] = direction
    if attr: p["attr"] = attr
    if page: p["page"] = page
    features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": p})


STATES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC",
    "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL",
    "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA",
    "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
    "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR",
    "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA",
    "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
    "Puerto Rico": "PR",
}


# ---------------------------------------------------------------- sources ---
def src_otc_master():
    """OpenTrafficCamMap (modernized) — US states/county JSON."""
    print("[otc] OpenTrafficCamMap master…")
    d = fetch_json("https://raw.githubusercontent.com/AidanWelch/OpenTrafficCamMap/master/cameras/USA.json", "otc_master.json")
    n = 0
    for state, counties in d.items():
        st = STATES.get(state, state)
        for county, cams in counties.items():
            for c in cams:
                stype = "m3u8" if c.get("format") == "M3U8" else "image"
                add(c.get("description", "DOT camera"), c.get("longitude"), c.get("latitude"),
                    stype, c.get("url"), "otc", "US", st, county, c.get("direction", ""),
                    f"{state} DOT via OpenTrafficCamMap", page="https://github.com/AidanWelch/OpenTrafficCamMap")
                n += 1
    print(f"[otc] {n} cameras")


def src_otc_v1():
    """OpenTrafficCamMap v1 archive — 39 states, 30k+ cameras."""
    print("[otc-v1] OpenTrafficCamMap v1 archive…")
    d = fetch_json("https://raw.githubusercontent.com/AidanWelch/OpenTrafficCamMap/v1/cameras/USA.json", "otc_v1.json")
    n = 0
    for state, counties in d.items():
        st = STATES.get(state, state)
        img_kept = 0
        for county, cams in counties.items():
            for c in cams:
                fmt = c.get("format")
                if fmt == "M3U8" or fmt == "M3U9":
                    stype = "m3u8"
                elif fmt == "IMAGE_STREAM" or fmt == "IMAGE_STREAM_BY_EPOCH_IN_MILLISECONDS":
                    stype = "image"
                else:
                    continue  # UNIQUE_* feeds need special handling, skip
                if stype == "image":
                    if img_kept >= IMAGE_CAP_PER_STATE:
                        continue
                    img_kept += 1
                loc = c.get("location", {})
                add(loc.get("description", "DOT camera"), loc.get("longitude"), loc.get("latitude"),
                    stype, c.get("url"), "otc-v1", "US", st, county, loc.get("direction") or "",
                    f"{state} DOT via OpenTrafficCamMap v1", page="https://github.com/AidanWelch/OpenTrafficCamMap")
                n += 1
    print(f"[otc-v1] {n} cameras")


def src_511ny():
    """511 New York — 2.9k cameras, ~1.7k with real HLS video URLs."""
    print("[511ny] New York 511…")
    d = fetch_json("https://511ny.org/api/getcameras?key=SIGNUP&format=json", "511ny.json")
    n = 0
    for c in d:
        if c.get("Disabled") or c.get("Blocked"):
            continue
        vid = c.get("VideoUrl")
        stype = "m3u8" if vid and ".m3u8" in vid else "embed"
        stream = vid if stype == "m3u8" else c.get("Url")
        add(c.get("Name"), c.get("Longitude"), c.get("Latitude"), stype, stream,
            "511ny", "US", "NY", (c.get("RoadwayName") or "").split("[")[0].strip(),
            c.get("DirectionOfTravel") or "", "NYSDOT / 511NY", status="live", page=c.get("Url", ""))
        n += 1
    print(f"[511ny] {n} cameras")


def src_qc():
    """Quebec 511 — official MTQ WFS GeoJSON."""
    print("[qc511] Quebec 511…")
    d = fetch_json(
        "https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0"
        "&request=getfeature&typename=ms:infos_cameras&srsname=EPSG:4326&outputformat=geojson", "qc.json")
    n = 0
    for f in d.get("features", []):
        p, g = f.get("properties", {}), f.get("geometry", {})
        coords = (g.get("coordinates") or [None, None])
        add(p.get("DescriptionLocalisationEn") or p.get("DescriptionLocalisationFr"),
            coords[0], coords[1], "embed", p.get("URL_FLUX_DONNEE"), "qc511",
            "CA", "Quebec", p.get("NomRegionDiffusion", ""), "",
            "Ministère des Transports et de la Mobilité durable du Québec",
            status="live", page="https://www.quebec511.info/")
        n += 1
    print(f"[qc511] {n} cameras")


def src_sg():
    """Singapore LTA / data.gov.sg — real-time traffic images with exact coordinates."""
    print("[sg] Singapore data.gov.sg…")
    d = fetch_json("https://api.data.gov.sg/v1/transport/traffic-images", "sg.json")
    n = 0
    items = d.get("items") or [{}]
    cams = (items[0].get("cameras") or [])
    for c in cams:
        loc = c.get("location") or {}
        add(f"Traffic camera {c.get('camera_id')}", loc.get("longitude"), loc.get("latitude"),
            "dynamic", "https://api.data.gov.sg/v1/transport/traffic-images", "sg",
            "SG", "Singapore", "", "", "LTA / data.gov.sg", status="live",
            page="https://data.gov.sg/datasets/d_e23205535bb3f4d832fac387625959e5/view")
        n += 1
    print(f"[sg] {n} cameras")


def src_fi():
    """Finland Digitraffic — 810 official weather/road cams (GeoJSON + image URL scheme)."""
    print("[fi] Finland Digitraffic…")
    d = fetch_json("https://tie.digitraffic.fi/api/weathercam/v1/stations", "fi.json")
    n = 0
    for f in d.get("features", []):
        p, g = f.get("properties", {}), f.get("geometry", {})
        coords = g.get("coordinates") or [None, None]
        presets = [pr for pr in (p.get("presets") or []) if pr.get("inCollection", True)]
        if not presets:
            continue
        pr = presets[0]
        img = "https://weathercam.digitraffic.fi/%s.jpg" % pr["id"]
        add(p.get("name") or pr.get("id"), coords[0], coords[1], "image", img, "fi",
            "FI", "", (p.get("name") or "").replace("_", " "), "",
            "Liikennevirasto / Digitraffic FI", status="live",
            page="https://tie.digitraffic.fi/")
        n += 1
    print(f"[fi] {n} cameras")


def src_les():
    """Live-Environment-Streams — ~6k curated global outdoor cams, 98 countries."""
    print("[les] Live-Environment-Streams…")
    d = fetch_json(
        "https://raw.githubusercontent.com/willytop8/Live-Environment-Streams/main/streams.geojson",
        "les_streams.geojson")
    n = 0
    for f in d.get("features", []):
        p, g = f.get("properties", {}), f.get("geometry", {})
        if p.get("status") != "active":
            continue
        coords = g.get("coordinates") or [None, None]
        ut = p.get("url_type") or ""
        stype = "m3u8" if ut == "hls" else "youtube" if ut == "youtube" else "embed"
        place = " ".join(filter(None, [p.get("scene_type"), p.get("environment")])).strip()
        add(p.get("name") or p.get("display_name") or "Webcam", coords[0], coords[1],
            stype, p.get("url"), "les", p.get("country_code") or "", "", place, "",
            "Live-Environment-Streams (%s)" % (p.get("source_family") or "community"),
            status="live", page=p.get("url") or "")
        n += 1
    print(f"[les] {n} cameras")


def src_argus():
    """Argus (MIT) — 229k global index; sample per country (cap ARGUS_CAP_PER_COUNTRY)."""
    print("[argus] Argus global index (sampling)…")
    B = "https://raw.githubusercontent.com/GoSlowPoke168/Argus/master/public/"
    core = fetch_json(B + "cameras.core.json", "argus_core.json")
    lab = fetch_json(B + "cameras.labels.json", "argus_labels.json")
    names, cities, cdict = lab.get("name", []), lab.get("city", []), lab.get("cityDict", [])
    lon, lat, ftA, ccA, srcA = core["lon"], core["lat"], core["ft"], core["cc"], core["src"]
    ftN, ccN, srcN = core.get("ftDict", []), core.get("ccDict", []), core.get("srcDict", [])
    TYPEMAP = {"m3u8": "m3u8", "mp4": "mp4", "mjpeg": "mjpeg", "image": "image",
               "image/jpeg": "image", "iframe": "embed", "txdot-json": "image"}
    PLAYABLE = {"m3u8", "mp4", "mjpeg", "image", "image/jpeg"}
    from collections import defaultdict
    buckets = defaultdict(list)
    for i in range(core["count"]):
        ft = ftN[ftA[i]] if ftA[i] < len(ftN) else ""
        if ft not in PLAYABLE:
            continue
        cc = ccN[ccA[i]] if ccA[i] < len(ccN) else "?"
        buckets[cc].append(i)
    selected = []
    for cc, idxs in buckets.items():
        live_first = [i for i in idxs if core["live"][i]] or idxs
        step = max(1, len(live_first) // ARGUS_CAP_PER_COUNTRY)
        selected.extend(live_first[::step][:ARGUS_CAP_PER_COUNTRY])
    print(f"[argus] selected {len(selected)} of {core['count']}")
    chunks = sorted({i // 1000 for i in selected})
    cdat = {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(fetch_json, B + f"cameras.detail/{c}.json", f"argus_det_{c}.json"): c for c in chunks}
        for fut in as_completed(futs):
            try:
                cdat[futs[fut]] = fut.result()
            except Exception as e:
                print("[argus] chunk fail:", e)
    n = 0
    for i in selected:
        c = cdat.get(i // 1000)
        if not c:
            continue
        j = i - int(c.get("from", 0))
        ids = c.get("id") or []
        if j < 0 or j >= len(ids):
            continue
        stream = (c.get("stream") or [""] * len(ids))[j] or ""
        feed = (c.get("feed") or [""] * len(ids))[j] or ""
        route = (c.get("route") or [""] * len(ids))[j] or ""
        ft = ftN[ftA[i]] if ftA[i] < len(ftN) else "image"
        if stream:
            stype, url = "m3u8", stream
        else:
            stype, url = TYPEMAP.get(ft, "image"), feed or route
        if not url:
            continue
        name = names[i] if i < len(names) else ids[j]
        city = cdict[cities[i]] if i < len(cities) and isinstance(cities[i], int) and cities[i] < len(cdict) else ""
        sname = srcN[srcA[i]].replace("opencctv_", "").replace("opencam_", "") if srcA[i] < len(srcN) else "index"
        add(name, lon[i], lat[i], stype, url, "argus",
            ccN[ccA[i]] if ccA[i] < len(ccN) else "", "", city, "",
            "%s via Argus (MIT)" % sname,
            status="live" if core["live"][i] else "unknown", page=route or url)
        n += 1
    print(f"[argus] {n} cameras")


US_STATES_2 = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID",
               "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
               "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
               "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"]


def src_ltc_state(state):
    """LiveTrafficCam per-state registry (official DOT/511/FAA cams, verified live)."""
    import time
    d = None
    for attempt in range(4):
        try:
            d = fetch_json(f"https://livetrafficcam.com/api/cams.json?state={state}", f"ltc_{state}.json")
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(3 * (attempt + 1))  # polite backoff
                continue
            print(f"[ltc] {state} failed: {e}")
            return 0
        except Exception as e:
            print(f"[ltc] {state} failed: {e}")
            return 0
    if d is None:
        return 0
    n = 0
    for c in d.get("cams", []):
        img = c.get("image")
        if not img:
            continue
        url = img if img.startswith("http") else "https://livetrafficcam.com" + img
        if c.get("live_status") != "live":
            continue
        add(c.get("name"), c.get("lng"), c.get("lat"), "image", url, "ltc",
            "US", state, c.get("route") or "", "", c.get("attribution") or "via LiveTrafficCam",
            status=c.get("live_status") or "unknown", page=c.get("official_url") or "")
        n += 1
    return n


def src_ltc_all():
    print("[ltc] LiveTrafficCam (all US states)…")
    total = 0
    with ThreadPoolExecutor(max_workers=2) as ex:
        futs = {ex.submit(src_ltc_state, s): s for s in US_STATES_2}
        for fut in as_completed(futs):
            total += fut.result()
    print(f"[ltc] {total} cameras")


# ------------------------------------------------------------------ dedup ---
TYPE_RANK = {"m3u8": 4, "mp4": 3, "mjpeg": 3, "youtube": 3, "image": 2, "dynamic": 2, "embed": 1}


def dedup(feats):
    best = {}
    for f in feats:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        key = (round(lat, 3), round(lon, 3))
        cur = best.get(key)
        if cur is None or TYPE_RANK.get(p["stype"], 0) > TYPE_RANK.get(cur["properties"]["stype"], 0):
            best[key] = f
    return list(best.values())


def main():
    jobs = [src_otc_master, src_otc_v1, src_511ny, src_qc, src_sg, src_fi, src_ltc_all, src_les, src_argus]
    for job in jobs:
        try:
            job()
        except Exception as e:
            print(f"[WARN] {job.__name__} failed: {e}")

    print(f"raw features: {len(features)}")
    feats = dedup(features)
    print(f"after dedup:  {len(feats)}")

    out = {"type": "FeatureCollection",
           "name": "godseye-cameras",
           "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
           "features": feats}
    path = os.path.join(ROOT, "data", "cameras.geojson")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    mb = os.path.getsize(path) / 1e6
    print(f"wrote {path} ({mb:.1f} MB)")

    stats = {}
    for f in feats:
        p = f["properties"]
        k = f'{p.get("country")}/{p.get("region")}'
        s = stats.setdefault(p["src"], {"cams": 0, "m3u8": 0, "image": 0, "embed": 0, "dynamic": 0, "regions": set()})
        s["cams"] += 1
        s[p["stype"]] = s.get(p["stype"], 0) + 1
        s["regions"].add(k)
    out_stats = {k: {**v, "regions": sorted(v["regions"])} for k, v in stats.items()}
    with open(os.path.join(ROOT, "data", "stats.json"), "w") as f:
        json.dump(out_stats, f, indent=2)
    print("stats:", json.dumps({k: v["cams"] for k, v in out_stats.items()}))

    # progressive-load packs (index + per-region full records)
    try:
        import subprocess
        subprocess.check_call([sys.executable, os.path.join(ROOT, "tools", "build_regions.py")])
    except Exception as e:
        print(f"[WARN] build_regions failed: {e}")


if __name__ == "__main__":
    main()
