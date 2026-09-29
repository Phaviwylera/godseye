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
- navigation reorganised around the globe itself: every option lives in one **MAP TOOLS**
  panel — an arrow chip under the HUD that expands into sections grouped by purpose (VIEW,
  PLAYBACK, LIVE LAYERS, WORLD LAYERS, WEATHER & SPACE, MAP, STATUS), remembers whether it
  was open, toggles with **M**, closes on Escape or a click on the globe, and shows the
  count of active tools when put away. Only + / − zoom still floats on the map's edge, the
  camera registry keeps its own collapse button, and tablets/phones keep the one-finger FAB sheet
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
The **SHIPS** layer displays recent AIS observations from ten corridors: Chennai,
Singapore, Rotterdam, New York, Los Angeles, plus five chokepoints — the western
Strait of Malacca, the Strait of Hormuz, the Suez Canal, the Panama Canal and the
Strait of Gibraltar. The map also marks nine named waterways (Malacca, Hormuz, Suez,
Panama, Gibraltar, Bosphorus, Bab el-Mandeb, Dover, Torres) as context labels — they
are drawn, but the collector only listens where it has boxes. A scheduled Netlify
Function connects to AISStream for 18 seconds every two minutes and stores a shared
snapshot in Netlify Blobs; the public reader rejects snapshots older than five minutes.
This is sampled coverage, not continuous global vessel tracking. Set `AISSTREAM_API_KEY` in the
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
| `hsl-helsinki` | Helsinki — HSL buses, trams and metro, the whole region | HSL open data (keyless) | 🚌/🚊/🚇 | live GPS for the entire regional fleet (913 vehicles measured) |
| `gtt-turin` | Turin — GTT buses and trams | Gruppo Torinese Trasporti (keyless) | 🚌/🚊 | live GPS from the operator's own endpoint (391 measured) |
| `capmetro-austin` | Austin — Capital Metro buses | Capital Metro via the Texas open data portal (keyless) | 🚌 bus | live GPS bus positions (272 measured) |
| `cttransit` | Hartford — CTtransit buses, statewide | CTtransit GTFS-Realtime (keyless) | 🚌 bus | live GPS bus positions (224 measured) |
| `hsr-hamilton` | Hamilton — HSR buses | City of Hamilton open data (keyless) | 🚌 bus | live GPS bus positions (133 measured) |
| `broward-bct` | Fort Lauderdale — Broward County Transit | Broward County Transit (keyless) | 🚌 bus | live GPS bus positions (110 measured) |
| `tep-parma` | Parma — TEP buses | TEP Parma (keyless) | 🚌 bus | live GPS bus positions (62 measured) |
| `actv-venice` | Venice — ACTV buses and water buses | ACTV Venezia (keyless) | 🚌/⛴ | live GPS, including the lagoon fleet (50 measured) |
| `federico-calabria` | Calabria — Autolinee Federico | Autolinee Federico (keyless) | 🚌 bus | live GPS bus positions (30 measured) |
| `guelph-transit` | Guelph — Guelph Transit buses | City of Guelph (keyless) | 🚌 bus | live GPS bus positions (33 measured) |
| `gpmetro-portland` | Portland, Maine — Greater Portland Metro | Greater Portland Metro (keyless) | 🚌 bus | live GPS bus positions (10 measured) |

**26 of the 31 feeds need no key and no signup at all** — every GTFS-Realtime network added on
2026-09-29 is keyless, and each one was measured live before it was allowed into the registry
(see *Checking the feeds* below). Only five carry a key: three OneBusAway Seattle feeds
(public `TEST`), BART's public demo key, and Delhi's registered OTD key — and Delhi's now comes
from the server's own environment when it is configured there.

Nothing here is taken on trust. Louisville TARC was checked and rejected — it answers only at
a dead endpoint. **Connecticut CTtransit was rejected for the same reason in an earlier pass and
is now back in**: probed on 2026-09-29 it answered with 224 drawable vehicles from a live
endpoint, so the earlier note was wrong and has been replaced. The rule is the same in both
directions — a network is listed only while its own feed answers.

### Checking the feeds

`python3 tools/probe_transit.py` asks every GTFS-Realtime feed in the registry directly and
prints what each one answered — HTTP status, payload size, entity count, how many vehicles
are drawable, and which protobuf field map the bytes carry:

```
FEED           CITY            HTTP     BYTES  ENTITIES  DRAWN  MAP       VERDICT
delhi-dtc      Delhi            200  412,904        651    651  current   live
atlanta-marta  Atlanta          200   38,210        180    178  current   live (2 stale)
```

It needs network access, so it is run by hand or by `.github/workflows/probe-transit.yml`
(weekly, and any time you dispatch it), which commits the report to
`data/transit-probe.json`.

A network is **retired** (kept in the registry with the date and reason, no longer polled) once
its operator stops publishing — `gcrta-bus` was retired this way when gtfs.gcrta.org stopped
answering on both http and https. A feed that merely blips is not retired: the probe carries a
`failedSweeps` streak across runs, so one bad sweep is a blip and three in a row is a decision.
Three networks added on 2026-09-29 (`gtt-turin`, `tep-parma`, `gpmetro-portland`) measured real
fleets and then answered 404/503 on later sweeps the same morning: they stay in, their notes say
they are intermittent, and the chip reports them per sweep.

The same job also selects **candidates** — keyless, HTTPS vehicle-position feeds from the
[Mobility Database](https://database.mobilitydata.org/) catalog, deduplicated by operator host
and skipping whatever the catalog itself flags as an unstable URL
(`tools/build_transit_candidates.py`) — and probes those into
`data/transit-probe-candidates.json`. A candidate is a proposal, not a registry entry: it is
promoted into `data/transit.json` only after the probe has watched it answer with real
vehicles. That is how the eleven networks added on 2026-09-29 were chosen — 29 candidates
probed, 17 answered with real fleets, 11 promoted with a city and a centre they could be
placed at, and the other six left as candidates rather than guessed into the map. The protobuf reader is dependency-free and is unit-tested offline
in `tests/test_probe_transit.py` against hand-built frames for **both** field maps —
`position 2 / timestamp 5 / vehicle 8` (google/transit master, the gtfs.org v2.0 reference)
and the numbering older producer libraries emit (`vehicle 2 / position 3 / stop_id 5 /
timestamp 7`). Getting that wrong is the one failure that draws nothing at all for a network
that is publishing perfectly good vehicles, so the layer no longer guesses: the bytes say
which map they carry, and the chip reports which one was used.

### Delhi: what is and is not live

`delhi-dtc` is India's only public live transit feed: Delhi's Open Transit Data portal
publishes real bus GPS (updated roughly every ten seconds) as standard GTFS-Realtime
VehiclePositions. A registered key is already in place, so Delhi's buses come online at the
first sweep; parked buses that stop reporting stay for up to thirty minutes and visibly fade
as their report ages.

**Where the key lives now.** The registry entry names `keyEnv: "DELHI_OTD_KEY"`. Set that
variable in the Netlify project (Functions scope) or in the local environment and the layer
takes the key from `/api/transit/keys` — served by the relay, never shipped in the page. With
no variable configured it falls back to the key in `data/transit.json`, which is public:
treat it as exposed and rotate it at
[otd.delhi.gov.in](https://otd.delhi.gov.in) whenever you get the chance. If the key is
reverted to `SIGNUP`, the layer goes back to waiting instead of failing: it is shown as
pending, never as dead.

**If Delhi looks empty, the chip says why.** Every GTFS-Realtime sweep records what it saw —
bytes, entities, how many carried a position, how many were stale, and which protobuf field
map the bytes used — and the TRANSIT chip spells it out per network: `the operator answered
with 412904 bytes carrying no vehicle entities` and `unavailable (HTTP 403 · …)` are
different problems with different fixes, and neither is allowed to look like plain silence.

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

## 🌍 World layers (ARGOS-parity set)

Six "world" layers, built only on keyless or operator-owned public feeds, with the
same standing rule as the rest of the app: **real data only, source cited,
no invented positions.** Every layer degrades to a labelled state
(`PENDING BUILD`, `KEY PENDING`, `UNAVAILABLE`) instead of a fabricated feed.

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
* **fires** — NASA FIRMS satellite fire hotspots (the relay requests VIIRS NOAA-21 NRT,
  world, last day; the parser also understands the MODIS product's header). The
  free MAP_KEY stays server-side: set `FIRMS_MAP_KEY` in the Netlify project env (and as an
  env var or `tools/_cache/firms-key.txt` when running `python3 server.py`). Without it the
  layer degrades to a labelled `FIRES · KEY PENDING` state instead of a fake feed. The
  parser reads the area API's real header for both products (`latitude`,
  `longitude`, `bright_ti4` / `brightness`, `confidence` as `l/n/h` or 0–100, `acq_time`
  as HHMM UTC, `frp`, `daynight`), and both relays check that a payload really is a
  header-and-rows sweep before caching it: FIRMS answers a bad key or an exhausted quota
  with **HTTP 200 and a line of prose**, which is reported as the upstream error it is
  (or held behind the last good sweep) rather than drawn as a world with no fires.
  Popups state brightness in kelvin, the feed's own confidence label, FRP in MW and the
  UTC acquisition time.
* **volcanoes** — every named volcano in OpenStreetMap, built by `tools/build_infra.py`
  into `data/volcanoes.json` (the `refresh-infra` action runs it weekly). Until the first
  snapshot ships, the chip reads `VOLC · PENDING BUILD`.

**⬡ INFRA** (`js/infra.js`) — critical infrastructure as map layers: named power
plants (coloured by fuel type: solar, wind, hydro, nuclear, coal, gas, oil) and named
harbours from OpenStreetMap, plus the open "CABLE" submarine-cable routes (2019
vintage — every popup says so, with the route's published length, ready-for-service year
and owners). `tools/build_infra.py` builds `data/power.json`,
`data/ports.json` and `data/cables.geojson`; `refresh-infra` runs it weekly. Each
dataset degrades independently to a `PENDING BUILD` chip until its first snapshot.

**◈ NEWS** (`js/news.js`) — geolocated world headlines from the [GDELT DOC 2.0
API](https://www.gdeltproject.org/data.html#doc): the relay (`/api/gdelt`, in both
`server.py` and the Netlify function) runs one fixed PointData sweep per 15 minutes —
an OR of conflict/disaster headline terms, 250 geocoded articles. Severity is a
transparent headline-keyword score (CASUALTIES / USE OF FORCE / CONFRONTATION /
DISASTER / GENERAL); the popup links out to the source article — godseye never
re-hosts article text. If GDELT throttles, the relay keeps the last good sweep.

**☒ CONFLICT** (`js/conflict.js`) — recent [UCDP/PRIO GED](https://ucdp.unic.ch)
conflict events (last 180 days, geolocated rows only) via `tools/build_conflict.py`
into `data/conflict.json`; `refresh-conflict` runs it on a Wednesday schedule. Colour
is a transparent death-count scale; classification is UCDP's, and **no frontlines are
drawn** — no open, verifiable contact-line dataset exists, and a hand-drawn line would
be fabrication. If UCDP moves its release file, the tool tells you exactly which URL
to update (`UCDP_FALLBACK_URLS`) instead of shipping a broken parse.

**▣ COMPANIES** (`js/companies.js`) — headquarters of a curated large-cap sample
(`data/companies-seed.json`: 66 exchange-listed companies with tickers) geocoded via
OSM Nominatim by `tools/build_companies.py` into `data/companies.json` (monthly via
`refresh-companies`, geocode cache in `tools/_cache/`). Quotes are a **link out** to a
ticker price search — v1 deliberately fetches no prices, and a guessed quote
deep-link would be fabrication. No coordinates are invented: an unresolvable HQ is
dropped, and the run refuses to ship under its floor.

**OFAC cross-check** (`js/ofac.js` + `tools/build_ofac.py`) — the US Treasury's public
[SDN list](https://ofac.treasury.gov/specially-designated-nationals-and-specially-designated-terrorists-list)
is built weekly (`refresh-ofac`) into `data/ofac.json` (aircraft registrations, vessel
IMOs and names). The SHIPS and AIR layers flag matches — always labelled with the
matched field: an IMO or registration match is stated as such, and a vessel **name**
match carries an explicit `verify IMO — ships share names` caution. A match is a flag
for human verification, never a verdict, and aircraft are only checked when the feed
actually supplies a registration.

**⊞ COUNTRIES** (`js/countries.js`) — clickable admin-0 boundaries
(`tools/build_countries.py` → `data/countries.json`, monthly via `refresh-countries`).
Clicking a country opens a card with ten keyless [World Bank](https://data.worldbank.org/)
indicators (GDP, population, inflation, unemployment, life expectancy, internet use,
military spend, electricity use, under-5 mortality) through the `/api/worldbank`
relay (both runtimes, 1 h cache). Every figure states its year; missing data says
"no data" — no interpolation, no invented figures. Territories whose boundary file
lacks an ISO code say so instead of guessing.

**☄ ISS PASSES** (`js/iss.js`) — next visible passes of the station over the current
view centre, computed locally with SGP4 from the CelesTrak snapshot the SATELLITES
layer already ships. The panel states the elements' epoch and warns when they go
stale; observer = view centre, 50 m a.s.l. No live telemetry is claimed.

**Universal search** — the left-panel search box matches named things on the map
before the world: vessel names/MMSIs (with their OFAC flag), aircraft callsigns/
registrations, and open market questions, plus the usual place geocoding. Layers that
are switched off contribute nothing.

Every one of these builders has a sanity floor (record counts, size guards, shape
checks), so a partial or error-page download fails loudly instead of shipping a
half-world.

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
 🚇 **Live transit layer** | buses, trams and metro trains with line geometry, stations, contact list and a live status chip, from 31 public operator feeds across 11 countries on three continents — 26 of them keyless — with quota budgeting so a shared API key survives being public |
 🎛️ **Sensor looks** | switch between CRT, night vision, simulated FLIR, noir and snow modes; include the look in shareable scene links |
 🌐 **Global context** | jump from a detailed map view to the globe and restore the exact saved camera with one action |
 🕹️ **God's Eye HUD** | radar sweep, boot sequence, scanlines, live counters, UTC clock |
 ⚡ **EVENTS layer** | active NWS storm warnings (US), NASA FIRMS satellite fire hotspots and every named OpenStreetMap volcano, drawn only where the source actually reported |
 ⊙ **MARKETS layer** | live Polymarket prediction markets ranked by 24 h volume, a transparent momentum flag, and a place pin for every market bound to a real location (Polymarket Gamma API, keyless) |
 ⬡ **INFRA layer** | named power plants (by fuel type) and harbours from OSM + open submarine-cable routes (2019 vintage, labelled historical) |
 ◈ **NEWS layer** | geolocated world headlines (GDELT DOC 2.0) on a 15-minute relay sweep, severity as a transparent headline-keyword score, links out to source articles |
 ☒ **CONFLICT layer** | last 180 days of UCDP/PRIO GED conflict events, coloured by reported deaths; no frontlines — none exist in an open verifiable source |
 ▣ **COMPANIES layer** | HQs of a curated 66-company large-cap sample (Nominatim geocoded); quote link-out, no fetched prices, no invented coordinates |
 ⊞ **COUNTRY cards** | clickable admin-0 boundaries + ten World Bank indicators per country (latest year per figure, no interpolation), through a 1 h-cached keyless relay |
 🚩 **OFAC cross-check** | Treasury SDN list flags on ship (IMO/name) and aircraft (registration) popups, always labelled by matched field, name matches carry a verify-IMO caution |
 ☄ **ISS passes** | next visible station passes over the view centre, SGP4 from the CelesTrak snapshot, epoch-stated, stale-warned |
 🔎 **Universal search** | the search box matches vessels, aircraft and open markets on the map before falling back to place geocoding |
 🔌 **Infrastructure snapshots** | `tools/build_infra.py` / `build_conflict.py` / `build_companies.py` / `build_countries.py` / `build_ofac.py` build every static dataset behind these layers; the `refresh-*` actions keep them current |

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
* `refresh-ofac` — **weekly** rebuild of `data/ofac.json` from the Treasury SDN XML (`tools/build_ofac.py`)
* `refresh-conflict` — **Wednesday** rebuild of `data/conflict.json` from the UCDP/PRIO GED release (`tools/build_conflict.py`)
* `refresh-companies` — **monthly** HQ re-geocoding of the curated large-cap sample (`tools/build_companies.py`, Nominatim, cached)
* `refresh-countries` — **monthly** refresh of admin-0 country boundaries + ISO codes (`tools/build_countries.py`)

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
