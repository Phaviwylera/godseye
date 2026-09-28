# GODSEYE × ARGOS ATLAS — capability gap & build plan

Date: 2026-09-28 · Status: **all three phases shipped (v1 scope)** — one branch, one PR

Final state (2026-09-28):
- ✅ **MARKETS** — `js/markets.js` + `data/markets-geo.json`: live Polymarket data, momentum flag, place pins.
- ✅ **EVENTS** — `js/events.js`: NWS storm alerts (live, keyless) + volcano points (first `refresh-infra`
  snapshot) + FIRMS fires (needs free `FIRMS_MAP_KEY`; degrades to `KEY PENDING`).
- ✅ **INFRA** — `js/infra.js` + `tools/build_infra.py`: power plants (by fuel), harbours (OSM),
  open CABLE submarine routes (2019 vintage, labelled). `refresh-infra` weekly.
- ✅ **SHIPS widened** — five chokepoint corridors added to the AISStream collector
  (Malacca, Hormuz, Suez, Panama, Gibraltar) + nine named waterway markers
  (`data/straits.json`, context labels only).
- ✅ **OFAC cross-check** — `tools/build_ofac.py` (weekly `refresh-ofac`) → `data/ofac.json`;
  `js/ofac.js` flags matches in SHIPS popups/list (IMO match / name match with
  "verify IMO" caution) and AIR popups (registration only when the feed supplies one).
- ✅ **NEWS** — `js/news.js` + `/api/gdelt` relay (both runtimes): GDELT DOC 2.0
  PointData sweep per 15 min, transparent headline-keyword severity, links out.
- ✅ **CONFLICT** — `js/conflict.js` + `tools/build_conflict.py` (Wednesday
  `refresh-conflict`): UCDP/PRIO GED events, last 180 days, death-count colour scale.
- ✅ **COMPANIES** — `js/companies.js` + `data/companies-seed.json` (66 curated
  large caps) + `tools/build_companies.py` (Nominatim HQ geocoding, cached; monthly
  `refresh-companies`): quote link-out, no fetched prices.
- ✅ **COUNTRIES** — `js/countries.js` + `tools/build_countries.py` (monthly
  `refresh-countries`): clickable admin-0 boundaries; `/api/worldbank` relay (both
  runtimes, 1 h cache) answers ten keyless World Bank indicators per card, latest
  year per figure, no interpolation.
- ✅ **ISS PASSES** — `js/iss.js`: SGP4 pass prediction (vendored engine + CelesTrak
  snapshot) over the view centre; epoch stated, stale-warned.
- ✅ **Universal search** — the search box matches vessels (name/MMSI, OFAC flag),
  aircraft (callsign/registration) and open market questions before place geocoding.

Deliberate v1 deviations (documented, not gaps):
- **No frontlines** in CONFLICT — no open, verifiable contact-line GeoJSON exists
  (ISW publishes map images only); a hand-drawn line would be fabrication.
- **COMPANIES is a curated 66-company sample**, not Wikidata-scale: a public
  SPARQL query returns unranked rows, and ranking without notability data would be
  fake curation. Quotes are a link out; v1 fetches no prices (and a guessed quote
  deep-link would be fabrication).
- **PEOPLE layer skipped in v1** — no open source with verified coordinates *and*
  net worth; Forbes is paywalled.
- **Tower audio (liveatc) skipped in v1** — community-stream ToS gray zone.
- **Country cards carry indicators only** (no leader/index panel) — leaders would
  need a second dataset (Wikidata) that v1 defers.

ARGOS ATLAS (argosatlas.com) is a 12-section "world, live" OSINT map. Godseye
already shares its core idea — one 3D globe, open public feeds, attributed
sources — and already implements more of it than the homepage suggests.

**Ground rule.** We build every capability on the *open public data sources*
(ARGOS's own FAQ names most of them: USGS, NASA, WHO, GDELT, UCDP, Polymarket,
OFAC, World Bank, ADS-B, AIS). We do **not** scrape ARGOS's site, clone their
code, or copy their datasets: their code, design and compiled data are theirs
to license. The feature *ideas* and the underlying open feeds are fair game —
and every feed below is available directly from its publisher, which is what
godseye already does for cameras, satellites, ships and transit.

---

## 1. Feature matrix

✅ = godseye has it today · ◐ = partial · ❌ = missing

| # | Capability (ARGOS claim) | Godseye now | Open source to build on | Work |
|---|---|---|---|---|
| 1 | Cameras — 212k cams, 190 countries, favourites, grid | ✅ 24,822 cams (8 agency sources), one-click HLS, **video wall already in `app.js`**, **favourites already in `app.js`** | same public agency portals + more 511/region feeds; dataset rebuild in `tools/build_dataset.py` | add sources (slow grind), then UI is done |
| 2 | Flights — global ADS-B, civil/military split, OFAC aircraft, ocean continuation, tower audio | ✅ **registration + OFAC flag in the popup** (only when the feed carries a registration); trails, cockpit view. ◐ civil/military split + tower audio deferred (see deviations) | **`api.adsb.lol`** (in use) + **OpenSky** (verified live); **OFAC SDN** (built) | done in v1 |
| 3 | Ships — global AIS, dark ships, OFAC vessels, ports & straits | ✅ **ten corridors incl. five chokepoints + nine waterway markers; OFAC IMO/name flags** (name matches carry verify-IMO). ◐ dark-ship plotting refused by standing rule | AISStream (key exists) + Digitraffic fallback; **OFAC SDN** (built) | done in v1 |
| 4 | War — 16 frontlines, GeoConfirmed events, jamming, UCDP history | ◐ **UCDP/PRIO GED events shipped** (180-day window, death-count scale); frontlines deliberately not drawn (no open verifiable source) | **UCDP/GED** (built, Wednesday refresh) | done in v1, frontlines out |
| 5 | AI intel — GDELT geocoded news + severity + risk zones + country cards (World Bank, leaders, market) | ✅ **NEWS layer** (15-min relay sweep, headline-keyword severity) + **country cards** (ten World Bank indicators, latest year each). ◐ risk-zone aggregation + leader panels deferred | **GDELT DOC 2.0** (in relay) + **World Bank API** (in relay, 1 h cache) | done in v1 |
| 6 | Infrastructure — 34,936 power plants, 47,927 airports, 1,081 ports, 694 submarine cables, commodities | ✅ **airports 72,587** (beats ARGOS) + **INFRA layer**: power plants by fuel, harbours (OSM), CABLE submarine routes (2019 vintage, labelled) | Overpass/OSM + open CABLE dataset (built, weekly) | done in v1 |
| 7 | People & companies — 1,594 people (Forbes), 4,123 companies at HQ, 15,583 priced assets | ◐ **COMPANIES layer**: curated 66-company large-cap sample, Nominatim-geocoded HQs, quote link-out; people skipped in v1 (no open verified source) | curated seed + Nominatim (built, monthly) | done in v1 at sample scale |
| 8 | Live events — quakes, NASA fire hotspots, volcanoes, storms, WHO outbreaks | ✅ **EVENTS layer**: quakes (USGS) + NWS storms + FIRMS fires (key-pending state until `FIRMS_MAP_KEY` set) + named volcanoes. ◐ WHO PHEIC deferred | USGS/NWS/FIRMS/OSM (all wired) | done in v1 |
| 9 | Prediction markets — 962 Polymarket markets geolocated, value signals, ticker | ✅ **MARKETS layer**: top by 24 h volume, momentum flag, place pins, universal-search integration | Polymarket Gamma (in use) | done in v1 |
| 10 | Extras — basemaps, favourites/grid, ISS passes, dark vessels, OFAC, cross-links, universal search | ✅ 3 map modes, favourites, wall, ISS position + **ISS PASSES panel**, OFAC (ships+air), **universal search** (ships/air/markets). Tower audio deferred (ToS) | vendored SGP4 + CelesTrak snapshot | done in v1 |

---

## 2. Sources verified live from this sandbox (2026-09-28)

| Source | Endpoint | Result |
|---|---|---|
| USGS quakes | `earthquake.usgs.gov/…/summary/all_day.geojson` | ✅ 210 features (godseye already polls `2.5_day`) |
| OpenSky ADS-B | `opensky-network.org/api/states/all?lamin…` | ✅ live contacts, keyless region boxes |
| Polymarket Gamma | `gamma-api.polymarket.com/markets?active=true` | ✅ full market objects (prices, volume, liquidity) |
| World Bank | `api.worldbank.org/v2/country/US/indicator/NY.GDP.MKTP.CD` | ✅ JSON, no key |
| GDELT DOC 2.0 | `api.gdeltproject.org/api/v2/doc/doc?…&mode=PointData&format=GeoJSON` | ✅ live; rate limit 1 req / 5 s — a 15-min refresh is comfortable |
| NASA FIRMS | `firms.modaps.eosdis.nasa.gov/api/area/csv/[KEY]/VIIRS_NOAA21_NRT/…` | ✅ API confirmed; needs **free MAP_KEY** (register at FIRMS, store as Netlify env like `AISSTREAM_API_KEY`) |
| OFAC SDN | `treasury.gov/ofac/downloads/sdn.xml` | well-known stable endpoint (too large to probe here); matches IMO + aircraft designation entries — build a small offline index in `tools/` |
| Submarine cables | open CABLE GeoJSON (hasan-soliman/CABLE line) | dataset is 2017-era; verify raw URL at build time and label vintage |
| wheretheiss.at / RainViewer / api.adsb.lol / AISStream / Digitraffic | — | ✅ already in production in godseye |

## 3. What we deliberately won't do

- **No dark-ship plotting from nothing.** Godseye's standing rule (and the
  honest one): a vessel is only drawn where AIS actually reported it. ARGOS
  "carries the estimated course" — we can add a *labelled* interpolated
  segment for ships we already track, never fabricated positions.
- **No simulated fleets/trains** (existing rule, kept).
- **No re-hosting of camera footage** (existing rule, kept — link/proxy to
  the agency's own stream only).
- **No scraping of ARGOS** (code, pages, compiled data). Their open feeds are
  public; ARGOS is not a feed.

## 4. Phased implementation

**Phase 1 — fast wins (all keyless, no new registrations):**
1. `EVENTS` layer: NASA FIRMS fires (add free key) + volcanoes, joined to the
   existing quake layer under one chip (quakes → events).
2. `MARKETS` layer: Polymarket Gamma, top-N by volume, geolocated where the
   market is place-bound, simple value-signal flag (price vs 24 h momentum).
3. `POWER` + `PORTS` + `CABLES` static layers: Overpass-built GeoJSON in
   `tools/`, nightly rebuild with the existing `refresh-dataset` action.

**Phase 2 — widen the live layers:**
4. AIR: OpenSky as second source + wider sampling grid; registration + type in
   the card; OFAC aircraft cross-check (offline SDN index).
5. SHIPS: widen AIS corridors (Malacca, Hormuz, Suez, Panama, Gibraltar);
   OFAC IMO cross-check; static port/strait markers with congestion note.
6. `INTEL` layer: GDELT PointData every 15 min → severity-scored news dots +
   risk-zone aggregation; country card (World Bank indicators + leader + live
   index quote).

**Phase 3 — curation-heavy:**
7. `CONFLICT` layer: UCDP/GED events (90-day window) + curated frontline
   lines per theatre (labelled "curated, updated weekly").
8. `COMPANIES` layer: Wikidata HQ-geolocated companies + keyless quotes;
   notable-people subset with open net-worth data.
9. ISS pass prediction (vendored SGP4), tower-audio experiment, universal
   search extended to ships/flights/markets.

Each phase ships as its own PR-able chunk with tests in `tests/` (purity
parsers, like `transit.test.mjs`) and attribution lines, per repo convention.
