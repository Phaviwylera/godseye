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
- navigation reorganised around the globe itself: option rows ride under the HUD header, only
  + / − zoom floats on the map's edge, and tablets/phones keep the one-finger FAB sheet
- every overlay honours the palette: the weather radar renders in RainViewer's cool
  Universal Blue scheme at low opacity instead of alarm colours

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
then redeploy; never place the key in `netlify.toml` or client code.

When that collector has not answered — no key configured, or the app served locally by
`python3 server.py`, where Netlify Functions do not exist — the layer falls back to
[Digitraffic's open AIS feed](https://www.digitraffic.fi/en/maritime-traffic/), which is
keyless and covers Finnish waters, and the chip says which source the positions came from.
Only when neither source answers does it display “AIS UNAVAILABLE”, and even then a failed
poll holds the last good sweep and reports its age (`◇ 142 VESSELS · HELD · 3 MIN AGO`)
rather than emptying the ocean.
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
| `mbta` | Boston — MBTA subway, Green Line, Silver Line and the whole bus fleet | [MBTA V3 API](https://api-v3.mbta.com/) (keyless) | 🚌/🚆 | **live GPS positions for every vehicle the agency runs** |
| `fi-rail` | Finland — every train running in the country (VR, commuter, freight) | [Digitraffic / rata.digitraffic.fi](https://www.digitraffic.fi/en/railway-traffic/) (keyless, CC 4.0) | 🚆 rail | trains at the station they actually reached + delay vs schedule |
| `ch-rail` | Switzerland — SBB, BLS, PostBus, trams: eight hub departure boards | [transport.opendata.ch](https://transport.opendata.ch/) (keyless) | 🚆/🚊 | live departures with the delay and platform |
| `be-rail` | Belgium — SNCB/NMBS live boards at five hubs | [iRail](https://api.irail.be/) (keyless, CC0) | 🚆 rail | live departures with delay and platform |
| `gcrta-bus` | Cleveland — Greater Cleveland RTA buses & rail | GCRTA GTFS-Realtime (keyless) | 🚌 bus | live GPS positions via the GTFS-RT protobuf reader |
| `delhi-dtc` | Delhi — DTC & cluster buses, every GPS-fitted bus | Open Transit Data, Govt. of NCT of Delhi (registered key in place) | 🚌 bus | **live GPS bus positions every ~10s** |
| `atlanta-marta` | Atlanta — MARTA buses | MARTA GTFS-Realtime (keyless) | 🚌 bus | live GPS bus positions |
| `edmonton-ets` | Edmonton — ETS buses & LRT trains | City of Edmonton open data (keyless) | 🚌 bus | live GPS positions for every reporting vehicle |
| `nl-ovapi` | Netherlands — Qbuzz, RET, GVB, Connexxion, Arriva, EBS, HTM: bus · tram · metro | OVapi national feed (keyless) | 🚌/🚊/🚇 | live GPS for thousands of vehicles in one stream |
| `my-rapid-kl` | Kuala Lumpur — Rapid KL buses, Klang Valley | data.gov.my open data (keyless) | 🚌 bus | live GPS bus positions |

Nine of the feeds (`mbta`, `fi-rail`, `ch-rail`, `be-rail`, `gcrta-bus`, `atlanta-marta`,
`edmonton-ets`, `nl-ovapi`, `my-rapid-kl`) need no key and no signup at all: they were each
verified live before being added to the registry. Two proposed US feeds were checked with
the same rigour and rejected — Louisville TARC and Connecticut CTtransit now answer only at
dead or undocumented endpoints, so they are not in the registry rather than in it and
permanently unavailable.

### Delhi: what is and is not live

`delhi-dtc` is India's only public live transit feed: Delhi's Open Transit Data portal
publishes real bus GPS (updated roughly every ten seconds) as standard GTFS-Realtime
VehiclePositions. A registered key is already in place, so Delhi's buses come online at the
first sweep; parked buses that stop reporting stay for up to thirty minutes and visibly fade
as their report ages. The key lives in a public file like the Seoul sample key — rotate it
freely (register at [otd.delhi.gov.in](https://otd.delhi.gov.in) for a fresh one any time).
If the key is ever reverted to `SIGNUP`, the layer goes back to waiting instead of failing:
it is shown as pending, never as dead.

The **Delhi Metro publishes no real-time train feed anywhere** — DMRC keeps train positions
private, and the OTD portal's realtime API covers buses only. Its November 2025 MoU with
MapmyIndia is a closed commercial channel, not open data. Per this layer's standing rule, no
train marker is drawn without a real operator position, and a simulated fleet is not an
option. The registry entry's note records exactly this so the answer survives the next
request for "live Delhi Metro trains".

## 🛩️ AIRPORTS layer

A third kind of contact joins AIR and TRANSIT: the **static registry itself**. `btn-airports`
draws **72,500+ aerodromes** — every large and medium airport, small airfield, heliport,
seaplane base and balloonport in the public-domain [OurAirports](https://ourairports.com/data/)
dataset — tiered in by zoom so nothing is ever sampled away: destinations from the start,
regional fields from sub-continental zoom, helipads and water aerodromes only up close.
Clicking one shows exactly what the registry knows (code, name, municipality, country, type)
and says plainly that it is a registry position, not live traffic — live aircraft still live
in the AIR layer.

`tools/build_airports.py` converts the official `airports.csv` into the compact positional
format the client reads (`data/airports.json`, ~5 MB), refusing bad coordinates and closed
airfields, and `refresh-airports.yml` re-runs it weekly in CI. Labels, sort order and the
record layout are contract-tested in `tests/airports.test.mjs` and
`tests/test_tool_airports.py`.

Three kinds of feed are supported and labelled differently in every popup:

* **positions** — the operator publishes live vehicle coordinates (OneBusAway networks,
  Umo IQ networks). Vehicles are drawn where they actually are, rotated to their heading,
  and selecting one shows the positions observed for it in the last 30 minutes. Umo
  vehicles that stop reporting are dropped rather than left frozen on the map.
* **arrivals** — the operator publishes arrival predictions but no vehicle coordinates
  (TfL, BART, and the two European departure-board feeds). Each vehicle is drawn at the stop
  it is next due at; TfL trains are de-duplicated by vehicle id so one train appears once, and
  BART — which publishes no vehicle ids at all — is sampled to the departures due within five
  minutes, so one marker is one departure rather than one unique train. A station board
  (`ch-rail`, `be-rail`) keeps at most three departures per station so a hub does not stack
  a dozen markers on one pixel, and a departure that has already left is dropped.
* **station** — the operator publishes which station a train is at, and no coordinates at
  all (Seoul). The train is drawn at that station's coordinate from the bundled table; a
  train at a station the table cannot resolve, or at a name two stations share, is skipped
  rather than placed at a guess. Report times are read as KST (+09:00), so the age shown
  is the feed's, not the viewer's clock, and future-dated reports are treated as skew.

Rail line geometry and stations load once per session; only vehicle positions are polled,
every 60 seconds. Markers fade as their last report ages, so a stale vehicle reads as stale.
Past 2,500 vehicles the layer draws the ones nearest the view and says so in the chip
tooltip. A network whose feed fails is reported as unavailable in the chip tooltip and never
back-filled with guesses.

### Quota budgeting: `pollSec` / `budgetSec` / `maxAgeSec`

Some operators cap requests per key or per IP, and every visitor of a public site shares the
same key *and* the same egress address. Those feeds are budgeted rather than polled, and the
three numbers in `data/transit.json` are one contract:

| knob | meaning | Seoul |
|------|---------|-------|
| `pollSec` | how often the feed is swept. A sweep that finds nothing due costs **zero** requests | 600 |
| `budgetSec` | how often one target (line, station, endpoint) may be re-read upstream | 1500 |
| `maxAgeSec` | how long a report stays on the map before it is refused as stale | 2400 |

`tests/transit.test.mjs` asserts `maxAgeSec >= budgetSec + pollSec` (or the map blanks between
polls of the same target) and `targets × 86400 / budgetSec <= dailyBudget` — Seoul's sixteen
lines cost 921 requests a day at worst, inside the portal's 1,000 — so retuning one knob
without the others fails CI instead of spending the site's key before noon.

Two more rules make the budget survive reality:

* **A failed poll holds the last good sweep.** The chip reads
  `held (daily request limit reached) · 24 min ago` instead of emptying the map, and the rows
  are dropped only once they exceed `maxAgeSec`. A sweep where *no* target answered is still
  reported as the failure it is — leftover rows are never presented as a fresh success, so a
  dead key cannot advertise a fleet it has not reported.
* **A dead target backs off.** After a failure the retry gap doubles (`pollSec`, `2×`, `4×`)
  up to `budgetSec`, so a dead key costs no more than a live one, while a transient blip is
  retried on the very next sweep.

The relay (`netlify/functions/api.mjs`, mirrored by `server.py`) is what makes the budget hold
across visitors: `GET /api/fetch?url=…&window=N` answers every caller from one shared upstream
fetch per window, single-flights concurrent identical URLs, and stores only an HTTP-200 JSON
body under 512 KB — never a playlist, never a relay failure, and never an operator's error
envelope (`{"errorMessage": …}`), so a capped key that recovers is not locked out by the
cache. Seoul asks for a window equal to `budgetSec`; the aircraft layer asks for 20 s.

### Adding a GTFS-Realtime feed (any city)

`js/transit.js` carries a small protobuf reader for GTFS-Realtime, so any agency that
publishes a keyless `VehiclePositions` URL can be added with **no new code**:

```json
{ "id": "my-city-bus", "adapter": "gtfsrt", "mode": "bus", "kind": "positions",
  "base": "https://…/vehiclepositions.pb", "pollSec": 60, "budgetSec": 60, "maxAgeSec": 600,
  "network": "…", "operator": "…", "city": "…", "country": "…",
  "attribution": "…", "page": "…" }
```

Binary payloads travel through `GET /api/fetch?url=…&encoding=base64` so the bytes survive
intact. The reader is unit-tested against a hand-built FeedMessage, including truncated
frames and unknown fields, in `tests/world-transit.test.mjs`.

Colours follow the operator's own brand colour where the feed publishes one (TfL, BART,
Sound Transit); where it does not, markers use the app palette — cyan for rail, teal for
trams, amber for buses. Keep each operator's attribution, which is shown in the chip
tooltip and in every vehicle popup. To add a network, append a feed to
`data/transit.json` and, if it is not one of the supported adapters (`oba`, `tfl`, `bart`,
`umo`, `seoul`, `mbta`, `digitraffic`, `opendata-ch`, `irail`, `gtfsrt`), a parser + adapter
in `js/transit.js` — the parsers are pure functions and are unit-tested in
`tests/transit.test.mjs` and `tests/world-transit.test.mjs`.

Not included, and why: MTA, WMATA, CTA, TfNSW, TransLink, LTA Singapore, Taipei and Tokyo all
require a registered API key — as do Korean buses and the metros of Busan, Daegu, Daejeon and
Gwangju, which is why Korea appears only as Seoul, and only through the portal's public sample
key: it caps every line at five trains, so the layer draws a sample of the fleet and says so.
A key registered at data.seoul.go.kr lifted into `base` in place of `sample` removes the
five-trains-per-line cap, and `budgetSec` can then be lowered to whatever the key's own daily
limit allows — the contract test in `tests/transit.test.mjs` checks the arithmetic. Amtrak's live map returns an encrypted payload; Chennai's CMRL publishes
no real-time feed at all. King County Metro is left out on purpose — its `vehicles-for-agency`
payload is over a megabyte per poll. Dutch NS trains and Kuala Lumpur's LRT/MRT lines are
absent for the same reason Delhi Metro trains are: no positions are published (OVapi
`trainUpdates` and data.gov.my rail categories carry trip updates only), and this layer does
not guess. Louisville TARC and Connecticut CTtransit were evaluated for the registry and
rejected because their published GTFS-Realtime endpoints no longer answer.

## 📡 MARKETS & EVENTS layers

Two more "world, live" layers, built only on keyless or operator-owned public feeds,
with the same standing rule as the rest of the app: **real data only, source cited,
no invented positions.**

**⊙ MARKETS** (`js/markets.js`) — live [Polymarket](https://polymarket.com/) prediction
markets from the public Gamma API, ranked by 24 h volume. A deliberately simple, clearly
labelled momentum flag marks markets whose price moved ≥5 points in a week while 24 h
volume is ≥$100k — information, not advice. Markets tied to a real place (elections,
a capital, a conflict) are pinned on the globe from `data/markets-geo.json`, a curated
recurring-topic table; everything else stays in the list. Refreshes every 10 minutes
through the relay so all visitors share one upstream call per window.

**⌁ EVENTS** (`js/events.js`) — three sources, each drawn only where reported:
* **storms** — NOAA/NWS active weather alerts (US), Severe/Extreme storm events only
  (tornado, hurricane, flood, winter, dust…), keyless JSON, 10-minute refresh.
* **fires** — NASA FIRMS satellite fire hotspots (VIIRS NOAA-21, last day). The free
  MAP_KEY stays server-side: set `FIRMS_MAP_KEY` in the Netlify project env (and as an
  env var or `tools/_cache/firms-key.txt` when running `python3 server.py`). Without it
  the layer degrades to a labelled `FIRES · KEY PENDING` state instead of a fake feed.
* **volcanoes** — every named volcano in OpenStreetMap, built by `tools/build_infra.py`
  into `data/volcanoes.json` (the `refresh-infra` action runs it weekly). Until the first
  snapshot ships, the chip reads `VOLC · PENDING BUILD`.

`tools/build_infra.py` also builds `data/power.json`, `data/ports.json` (OSM named
power-plant / harbour features) and `data/cables.geojson` (the open "CABLE" submarine-cable
dataset, 2019 vintage, labelled as historical) for the upcoming POWER/PORTS/CABLES map
layers. Every dataset has a sanity floor, so a partial download fails loudly instead of
shipping a half-world.

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
 🚇 **Live transit layer** | buses, trams and metro trains with line geometry, stations, contact list and a live status chip, from 15 public operator feeds across four continents — five of them keyless — with quota budgeting so a shared API key survives being public |
 🎛️ **Sensor looks** | switch between CRT, night vision, simulated FLIR, noir and snow modes; include the look in shareable scene links |
 🌐 **Global context** | jump from a detailed map view to the globe and restore the exact saved camera with one action |
 🕹️ **God's Eye HUD** | radar sweep, boot sequence, scanlines, live counters, UTC clock |
 ⚡ **EVENTS layer** | active NWS storm warnings (US), NASA FIRMS satellite fire hotspots and every named OpenStreetMap volcano, drawn only where the source actually reported |
 ⊙ **MARKETS layer** | live Polymarket prediction markets ranked by 24 h volume, a transparent momentum flag, and a place pin for every market bound to a real location (Polymarket Gamma API, keyless) |
 🔌 **Infrastructure snapshots** | `tools/build_infra.py` builds the named-volcano / power-plant / harbour (OSM) and open submarine-cable datasets behind the new layers; the `refresh-infra` action refreshes them weekly |

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
* `refresh-infra` — **weekly** rebuild of the OSM volcano / power-plant / harbour snapshots and the open submarine-cable map (`tools/build_infra.py`)

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
