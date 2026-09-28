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
Ships use a teal vessel symbol; selecting one shows only its actually observed positions
from the last 30 minutes as a dashed trail and waypoint dots. A trail appears after
a second distinct position arrives.

The **TRANSIT** layer draws the live bus, tram, metro and light-rail networks that their
own operators publish openly for riders: coloured rail line geometry, station dots
(zoom 10.5+) and every vehicle the feed currently reports. Click a vehicle for its route,
destination, next stop, ETA, speed and delay; click a rail station for the next trains due
there; click the chip for a sortable contact list. Data comes from `data/transit.json` and
is fetched live — nothing is bundled or simulated. The one exception is Seoul's station
coordinates: that feed reports station names and no positions at all, so a static station
table (`data/kr-stations.json`, a CC0 extract of Wikidata) is bundled to place them.

| id | network | adapter | mode | provides |
|----|---------|---------|------|----------|
| `st-rail` | Seattle — Sound Transit Link, T Line, Sounder | OneBusAway (public `TEST` key) | 🚆 rail | **live GPS train positions** |
| `st-streetcar` | Seattle Streetcar | OneBusAway | 🚊 tram | live GPS tram positions |
| `ps-bus` | Seattle — Community Transit, Pierce Transit, Everett Transit | OneBusAway | 🚌 bus | live GPS bus positions |
| `tfl` | London — Underground, DLR, Elizabeth line, Overground, Trams | TfL Unified API (keyless) | 🚆 rail | live predictions per train + line status |
| `bart` | San Francisco — BART | BART API (public demo key) | 🚆 rail | live per-station departures |
| `ttc` | Toronto — TTC buses & streetcars | Umo IQ (keyless) | 🚌/🚊 | live GPS bus + tram positions |
| `stl` | Laval — Société de transport de Laval | Umo IQ | 🚌 bus | live GPS bus positions |
| `omnitrans` | San Bernardino — Omnitrans | Umo IQ | 🚌 bus | live GPS bus positions |
| `portland-sc` | Portland Streetcar | Umo IQ | 🚊 tram | live GPS tram positions |
| `seoul-metro` | Seoul — Metropolitan Subway, lines 1–9 + Gyeongui–Jungang, Suin–Bundang, Shinbundang, AREX, Ui, Seohae, Sillim | Seoul open API (public sample key) + bundled Wikidata stations | 🚆 rail | trains at the station they last reported (max 5 per line — the sample key's cap) |

Three kinds of feed are supported and labelled differently in every popup:

* **positions** — the operator publishes live vehicle coordinates (OneBusAway networks,
  Umo IQ networks). Vehicles are drawn where they actually are, rotated to their heading,
  and selecting one shows the positions observed for it in the last 30 minutes. Umo
  vehicles that stop reporting are dropped rather than left frozen on the map.
* **arrivals** — the operator publishes arrival predictions but no vehicle coordinates
  (TfL, BART). Each vehicle is drawn at the stop it is next due at; TfL trains are
  de-duplicated by vehicle id so one train appears once, and BART — which publishes no
  vehicle ids at all — is sampled to the departures due within five minutes, so one
  marker is one departure rather than one unique train.
* **station** — the operator publishes which station a train is at, and no coordinates at
  all (Seoul). The train is drawn at that station's coordinate from the bundled table; a
  train at a station the table cannot resolve, or at a name two stations share, is skipped
  rather than placed at a guess. Report times are read as KST (+09:00), so the age shown
  is the feed's, not the viewer's clock, and future-dated reports are treated as skew.

Rail line geometry and stations load once per session; only vehicle positions are polled,
every 60 seconds. Seoul is the exception the shared key forces: the portal caps this API at
1,000 requests a day for everyone, so the first poll covers all sixteen lines and afterwards
two lines are re-polled per refresh, each line keeping its last report until it comes round
again or for 15 minutes, whichever is sooner. Markers fade as their last report ages, so a
stale vehicle reads as stale. Past 2,500 vehicles the layer draws the ones nearest the view
and says so in the chip tooltip. A network whose feed fails is reported as unavailable in the
chip tooltip and never back-filled with guesses.

Colours follow the operator's own brand colour where the feed publishes one (TfL, BART,
Sound Transit); where it does not, markers use the app palette — cyan for rail, teal for
trams, amber for buses. Keep each operator's attribution, which is shown in the chip
tooltip and in every vehicle popup. To add a network, append a feed to
`data/transit.json` and, if it is not OneBusAway / TfL / BART / Umo / Seoul, a parser +
adapter in `js/transit.js` — the parsers are pure functions and are unit-tested in
`tests/transit.test.mjs`.

Not included, and why: MTA, WMATA, CTA, TfNSW, TransLink, LTA Singapore, Taipei and Tokyo all
require a registered API key — as do Korean buses and the metros of Busan, Daegu, Daejeon and
Gwangju, which is why Korea appears only as Seoul, and only through the portal's public sample
key: it caps every line at five trains, so the layer draws a sample of the fleet and says so.
A key registered at data.seoul.go.kr lifted into `base` in place of `sample` removes both the
cap and the rotation. Amtrak's live map returns an encrypted payload; Chennai's CMRL publishes
no real-time feed at all. King County Metro is left out on purpose — its `vehicles-for-agency`
payload is over a megabyte per poll.

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
 ✈ **Aircraft tracking** | live aircraft layer with selectable contacts, recent flight trails, a dedicated tracked-aircraft pin, follow mode and an oblique cockpit view |
 🚇 **Live transit layer** | buses, trams and metro trains with line geometry, stations, contact list and a live status chip, from 10 public operator feeds (Seoul's through a rate-limited sample key) |
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
| `les` | [Live-Environment-Streams](https://github.com/willytop8/Live-Environment-Streams) | 98 countries | HLS / YouTube Live / publisher page links |
| `argus` | [Argus](https://github.com/GoSlowPoke168/Argus) (MIT) | 174 countries | m3u8 / mp4 / mjpeg / images |

Each camera carries its attribution line from the publishing agency — keep it.

Enable **AIR** to view aircraft icons. Click the aircraft count to open a
selectable contact list. At world zoom AIR samples four regions
(Chennai, Singapore, London and New York); zoom in to search around the map
center. The four-region sample is not a complete worldwide aircraft feed.
Plane markers use heading-aligned aircraft icons; click a contact in the list
to zoom to it.
Select an aircraft for the ships-style inspection view: a large teal pin marks
and rotates with the latest observed position, every distinct sample in the last
hour becomes a waypoint dot, and a dashed line links them into the recent trail.
FIRST OBSERVED and LATEST label the sampled endpoints; the live feed does not
provide a verified flight origin or destination. The inspection popup also shows
a live telemetry strip — altitude (bright) and ground speed (dim) over the last
hour, plus altitude, ground speed, vertical speed and distance to the nearest
bundled airport. Use the map's + and −
controls or a trackpad to zoom; a camera cluster opens its member list and
zooms in to reveal camera icons. Terrain activates at close zoom to keep the
globe responsive. Use the popup actions to clear a track or enter cockpit view.
Cockpit view follows the aircraft from an oblique camera angle and restores
the previous map view when exited.

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
