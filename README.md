# GOD'S EYE — Global Observation Network 🌍👁️

A **3D globe web app** (think Google Earth × Fast & Furious "God's Eye") that maps
**thousands of real, publicly-published CCTV / traffic cameras** at their exact
coordinates. Zoom out, hunt the camera icons, click one — and the **live feed of
that exact location** plays instantly.

![status](https://img.shields.io/badge/cameras-24%2C800%2B-blue) ![countries](https://img.shields.io/badge/countries-120%2B-orange) ![feeds](https://img.shields.io/badge/live%20video-13%2C000%2B-green)


## 🎛️ GODSEYE V3

The interface has been redesigned around a restrained global-intelligence aesthetic rather than a generic neon terminal look:

- custom Earth/iris targeting emblem (`assets/gods-eye-emblem.svg`)
- Michroma display typography + IBM Plex Mono telemetry typography
- animated orbital boot sequence with autonomous system-status rows
- desaturated cyan / graphite visual system with low-intensity glass surfaces
- ambient map grid, vignette and slow scan layer
- camera target-acquisition reticle before the feed opens
- refined HUD, camera index, video wall, route panel, radar, compass and mobile controls
- redesigned PWA/app icon to match the interface

No build step is required; the visual system is contained in the existing HTML/CSS/JS files and the SVG asset.

Netlify runs `python3 tools/build_site.py` and publishes `site/`, which contains
only the app and its camera data. The Python server and repository utilities are
excluded from the public deployment. Search accepts `latitude, longitude` as
well as place names. The offline shell caches app assets; camera data and live
feeds always use the network.

If WebGL cannot start, the camera list still loads and opens feeds without the
map. A feed's status shows when its endpoint was checked; `PLAYING NOW` appears
only after the browser actually starts playback. Scheduled liveness probes now
record a timestamp per camera, and checks older than 48 hours are marked
unverified until refreshed.

The **SATELLITES** layer displays stations and operational GPS satellites.
Positions are SGP4 predictions from [CelesTrak GP JSON orbital elements](https://celestrak.org/NORAD/documentation/gp-data-formats.php),
not live satellite telemetry. `refresh-satellites` updates the small static
snapshot once daily, and the layer refuses a snapshot older than 72 hours.
`satellite.js` 6.0.2 is vendored under its MIT license in `vendor/`.
The **SHIPS** layer displays recent AIS observations from selected corridors near Chennai,
Singapore, Rotterdam, New York and Los Angeles. A scheduled Netlify Function connects
to AISStream for 18 seconds every two minutes and stores a shared snapshot in Netlify
Blobs; the public reader rejects snapshots older than five minutes. This is sampled
coverage, not continuous global vessel tracking. Set `AISSTREAM_API_KEY` in the
Netlify project environment variables with **Functions** scope (Production context),
then redeploy; never place the key in `netlify.toml` or client code. Until configured,
the layer displays “AIS UNAVAILABLE” rather than fabricated vessel positions.

## ✨ Features

| | |
|---|---|
| 🌐 **Real 3D globe** | drag to rotate, scroll to zoom, right-drag to tilt — full globe projection with atmosphere |
 ⛰️ **3D terrain** | real elevation (AWS Terrarium DEM), hillshade relief, toggleable |
 🏙️ **3D buildings** | OpenStreetMap building heights from OpenFreeMap at zoom 15+, toggle saved across visits; availability varies by location |
 🛣️ **Full map detail** | roads, labels, POIs, buildings — OpenStreetMap vector tiles (OpenFreeMap) + Esri satellite |
 🎨 **3 map modes** | GOD'S-EYE dark / streets / satellite |
 📹 **Live CCTV layer** | camera icons pinned at exact real coordinates, colored by feed type |
 📺 **One-click playback** | HLS live video (hls.js), auto-refreshing snapshots, agency portals |
 🔎 **Search** | filter cameras by road/city/country + geocoding place search (Nominatim) |
 ⟳ **Live sync** | background re-sync from official APIs — new cameras merge automatically |
 ✈ **Aircraft tracking** | live aircraft layer with selectable contacts, recent flight trails, follow mode and an oblique cockpit view |
 🎛️ **Sensor looks** | switch between CRT, night vision, simulated FLIR, noir and snow modes; include the look in shareable scene links |
 🌐 **Global context** | jump from a detailed map view to the globe and restore the exact saved camera with one action |
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
| `les` | [Live-Environment-Streams](https://github.com/willytop8/Live-Environment-Streams) | 98 countries | HLS / YouTube Live / portals |
| `argus` | [Argus](https://github.com/GoSlowPoke168/Argus) (MIT) | 174 countries | m3u8 / mp4 / mjpeg / images |

Each camera carries its attribution line from the publishing agency — keep it.

Enable **AIR** to view nearby aircraft. Select an aircraft to draw its recent
track (up to one hour of sightings); use the popup actions to clear it or enter
cockpit view. Cockpit view follows the aircraft from an oblique camera angle and
restores the previous map view when exited. The aircraft status chip toggles
camera follow while a track is selected.

Cycle the visual sensor looks with the **SENSOR** control or select them with
`1`–`5` (`0` restores natural color). FLIR is a stylized color filter, not a
thermal sensor or temperature measurement. Share-view links preserve the
selected look.

Use **GLOBAL VIEW** (or press `G`) to save the current camera and zoom out to a
global view; activate **RETURN VIEW** to restore the saved center, zoom, bearing
and pitch.

## 🚀 Quick start

```bash
python3 server.py          # zero dependencies, Python 3.8+
# open http://localhost:8000
```

The server also provides:

* `/api/proxy?url=…` — streaming relay (fixes CORS + HTTPS mixed-content for feeds)
* `/api/fetch?url=…` — JSON passthrough for source APIs

## 🤖 Automation (GitHub Actions)

* `refresh-dataset` — rebuilds `data/cameras.geojson` from every source **nightly** and pushes (Netlify auto-redeploys)
* `check-liveness` — probes every direct-media feed **weekly**, writes `data/liveness.json` → LIVE / DOWN badges in the UI

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
