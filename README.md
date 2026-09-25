# GOD'S EYE — Global Public CCTV Grid 🌍👁️

A **3D globe web app** (think Google Earth × Fast & Furious "God's Eye") that maps
**thousands of real, publicly-published CCTV / traffic cameras** at their exact
coordinates. Zoom out, hunt the camera icons, click one — and the **live feed of
that exact location** plays instantly.

![status](https://img.shields.io/badge/cameras-18%2C600%2B-blue) ![feeds](https://img.shields.io/badge/live%20video-4%2C600%2B-green)

## ✨ Features

| | |
|---|---|
| 🌐 **Real 3D globe** | drag to rotate, scroll to zoom, right-drag to tilt — full globe projection with atmosphere |
 ⛰️ **3D terrain** | real elevation (AWS Terrarium DEM), hillshade relief, toggleable |
 🛣️ **Full map detail** | roads, labels, POIs, buildings — OpenStreetMap vector tiles (OpenFreeMap) + Esri satellite |
 🎨 **3 map modes** | GOD'S-EYE dark / streets / satellite |
 📹 **Live CCTV layer** | camera icons pinned at exact real coordinates, colored by feed type |
 📺 **One-click playback** | HLS live video (hls.js), auto-refreshing snapshots, agency portals |
 🔎 **Search** | filter cameras by road/city/country + geocoding place search (Nominatim) |
 ⟳ **Live sync** | background re-sync from official APIs — new cameras merge automatically |
 🕹️ **God's Eye HUD** | radar sweep, boot sequence, scanlines, live counters, UTC clock |

## 🗺️ Camera sources (all publicly published by agencies)

| id | source | region | feeds |
|----|--------|--------|-------|
| `otc`, `otc-v1` | [OpenTrafficCamMap](https://github.com/AidanWelch/OpenTrafficCamMap) | US (39 states) | HLS + snapshots |
| `511ny` | [511 New York / NYSDOT](https://511ny.org) | New York | **~1,700 live HLS videos** |
| `qc511` | [Quebec 511 / MTQ](https://www.quebec511.info) | Québec | portal feeds |
| `sg` | [data.gov.sg LTA traffic images](https://data.gov.sg) | Singapore | live snapshots (exact coords) |
| `fi` | [Digitraffic weathercams](https://tie.digitraffic.fi) | Finland | snapshots |
| `ltc` | [LiveTrafficCam](https://livetrafficcam.com) (DOT/511/FAA) | US (all states) | verified live snapshots |

Each camera carries its attribution line from the publishing agency — keep it.

## 🚀 Quick start

```bash
python3 server.py          # zero dependencies, Python 3.8+
# open http://localhost:8000
```

The server also provides:

* `/api/proxy?url=…` — streaming relay (fixes CORS + HTTPS mixed-content for feeds)
* `/api/fetch?url=…` — JSON passthrough for source APIs

## 🧱 Rebuild the dataset

```bash
python3 tools/build_dataset.py          # curated (default)
python3 tools/build_dataset.py --full   # keep every single camera
```

Writes `data/cameras.geojson` + `data/stats.json` from every source in
`data/sources.json` (downloads are cached in `data/_cache/` so it's resumable).

## ➕ Add a camera / source

Cameras are plain GeoJSON — append a Feature to `data/cameras.geojson`
(or better: add an adapter in `tools/build_dataset.py` + `js/sources.js`
for a whole public feed).

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [80.2707, 13.0827] },
  "properties": {
    "id": "in-tn-chennai-marina-001",
    "name": "Marina Beach — north end",
    "src": "mycity", "stype": "m3u8",
    "stream": "https://example.gov.in/live/cam001/playlist.m3u8",
    "country": "IN", "region": "Tamil Nadu", "place": "Chennai",
    "attr": "Chennai Traffic Police", "status": "live",
    "page": "https://example.gov.in/traffic-cameras"
  }
}
```

`stype`: `m3u8` (HLS video) · `image` (jpg snapshot endpoint) · `dynamic` (rotating URL) · `embed` (agency player page)

## ⚖️ Ethics & legality — read this

This project maps **only cameras that agencies deliberately publish to the
public**: highway/traffic DOT cams, weather cams, open-data portals. It does
**not** include, and must never be used to access, private, indoor, residential,
or unauthorized cameras. There is no real-life "God's Eye" into private systems —
that's movie fiction (and a crime). Be a good citizen:

* respect each source's terms of service and rate limits
* keep attributions visible
* don't re-host or mass-archive footage without permission

## 📦 Tech

Vanilla JS + [MapLibre GL](https://maplibre.org) (globe, terrain, vector tiles) +
[hls.js](https://github.com/video-dev/hls.js) + Python stdlib server.
No build step, no npm, runs anywhere.

## 📤 Push to GitHub

```bash
./push-to-github.sh <github-username> <repo-name> <github-token>
```

MIT — see `LICENSE`. Map data © OpenStreetMap contributors, tiles © CARTO /
OpenFreeMap / Esri; terrain © AWS Open Data.
