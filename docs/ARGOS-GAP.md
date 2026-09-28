# GODSEYE × ARGOS ATLAS — capability gap & build plan

Date: 2026-09-28 · Status: analysis complete, phases pending

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
| 2 | Flights — global ADS-B, civil/military split, OFAC aircraft, ocean continuation, tower audio | ◐ AIR layer via `api.adsb.lol` (4-region sampling), trails, cockpit view | **`api.adsb.lol`** (in use) + **OpenSky** (verified live, keyless region boxes); OFAC SDN (see §4) | widen sampling grid; add registration/OFAC card fields |
| 3 | Ships — global AIS, dark ships, OFAC vessels, ports & straits | ◐ SHIPS via AISStream corridor collector (Netlify fn) + keyless Digitraffic fallback; trails | AISStream (key exists), widen corridors; static port/strait GeoJSON from OSM (Un/LOCODE + `harbour` tags) | more corridors; OFAC IMO match; port/strait markers |
| 4 | War — 16 frontlines, GeoConfirmed events, jamming, UCDP history | ❌ | **UCDP/GED event dataset** (open, daily, geocoded) for events; no clean *open* frontline GeoJSON exists (ISW publishes map images only) | UCDP event layer; frontlines = curated static lines per theatre, clearly labelled |
| 5 | AI intel — GDELT geocoded news + severity + risk zones + country cards (World Bank, leaders, market) | ❌ | **GDELT DOC 2.0 PointData** (verified live; ≥5 s between calls, we poll every 15 min); **World Bank API** (verified live); leaders/market via Wikidata + keyless quotes | `js/intel` module already hosts quakes+radar+air — news layer fits the same pattern |
| 6 | Infrastructure — 34,936 power plants, 47,927 airports, 1,081 ports, 694 submarine cables, commodities | ◐ **airports already bundled: 72,587** (beats ARGOS); no plants/ports/cables | power plants + ports: **Overpass/OSM** (`power=plant`, `harbour`/`port` tags) → static GeoJSON, rebuilt nightly like cameras; cables: open **CABLE GeoJSON** datasets (hasan-soliman/CABLE line; ~2017 vintage, label as such) | dataset tools + 3 new map layers |
| 7 | People & companies — 1,594 people (Forbes), 4,123 companies at HQ, 15,583 priced assets | ❌ | Forbes is paywalled → open substitute: **Wikidata SPARQL** (companies with HQ geo, notable people with location & net-worth property) + keyless quote feeds for assets | curation + 1 layer; lower fidelity than Forbes, fully open |
| 8 | Live events — quakes, NASA fire hotspots, volcanoes, storms, WHO outbreaks | ◐ **quakes live** (USGS M2.5+/24 h, 5-min poll) + **RainViewer radar** live | **NASA FIRMS** (verified API; free MAP_KEY, same Netlify-env pattern as AISStream); volcanoes: Smithsonian/USGS open feeds; WHO PHEIC: static snapshot scrape with citation | new "EVENTS" layer joining quakes |
| 9 | Prediction markets — 962 Polymarket markets geolocated, value signals, ticker | ❌ | **Polymarket Gamma API** (verified live, keyless, rich: prices, volume, liquidity, end dates) | new layer: top markets by volume/liquidity, geolocate the place-bound ones, simple value-signal flag |
| 10 | Extras — basemaps, favourites/grid, ISS passes, dark vessels, OFAC, cross-links, universal search | ◐ 3 map modes ✅, favourites ✅, wall ✅, ISS position ✅ (wheretheiss), **SGP4 `satellite.js` vendored** (passes computable offline), cross-card links partial | ISS passes from vendored SGP4; tower audio via liveatc.net community streams (check their ToS before shipping) | polish + a couple of small systems |

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
