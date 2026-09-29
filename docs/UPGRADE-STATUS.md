# Consolidated upgrade status

## 2026-09-29 — Delhi visibility, feed honesty

Why a network can be live and still draw nothing, and what now makes that visible:

- **Field-map sniffing in the GTFS-Realtime reader.** `VehiclePosition` has two field maps on
  the public wire — `position 2 / timestamp 5 / stop_id 7 / vehicle 8` (google/transit master
  and the gtfs.org v2.0 reference) and the numbering older producer libraries emit
  (`vehicle 2 / position 3 / stop_id 5 / timestamp 7`). Reading the wrong one decodes zero
  vehicles with no error, which is the exact symptom "I see nothing". The decoder now lets the
  bytes decide: a Position is the only submessage whose first field is a 32-bit float, a
  timestamp is a varint while a stop_id is a string, and the VehicleDescriptor is what is left
  carrying strings. Both maps are covered by hand-built fixtures in
  `tests/world-transit.test.mjs`.
- **Per-feed decode diagnostics.** Every GTFS-Realtime sweep records bytes, entities, how many
  carried a position, how many were stale, how many had unusable coordinates, and the field map
  used. The TRANSIT chip states that per network instead of "no vehicles reported", and the
  all-quiet status line counts networks (`◇ TRANSIT — NO VEHICLES DRAWN · 0/1 NETWORKS`).
- **Relay errors keep their status.** `unavailable` threw away the HTTP code and the relay's own
  message; the chip now reports `HTTP 403 · …` so a rotated operator key is distinguishable from
  a dead URL.
- **Delhi's key moved server-side.** `data/transit.json` names `keyEnv: "DELHI_OTD_KEY"`; the
  relay publishes the value it holds at `/api/transit/keys` (Netlify env, or the local
  environment) and the client splices it into the endpoint. No variable configured → the
  registry URL stands, so a static deploy keeps working. The key in the public file should
  still be treated as exposed and rotated.
- **`tools/probe_transit.py` + weekly CI sweep.** The probe asks every GTFS-Realtime feed
  directly and prints/reports status, size, entity count, drawable count and field map;
  `.github/workflows/probe-transit.yml` runs it weekly and on dispatch, uploads the report and
  commits `data/transit-probe.json`. Its protobuf reader is dependency-free and unit-tested
  offline in `tests/test_probe_transit.py` (13 tests, both field maps).

## Implemented in this package

- Replace sprawling globe toolbars with a collapsed-by-default, keyboard-accessible Map tools panel. Group layers, appearance, cameras, navigation and feed status; support Escape and outside-click dismissal.
- Preserve all existing control IDs and event bindings; keep zoom independent.
- Save up to 12 named map positions locally, with validation and storage-failure handling.
- Generate a camera source/type coverage report from the shipped index on every site build. Indexed cameras are not described as live; historical probes are not current availability.
- Correct NASA FIRMS VIIRS field names and categorical confidence; retain MODIS numeric confidence support.
- Anchor cable popups to the clicked map location and preserve metadata. Prevent duplicate infrastructure listeners and stale toggle completion.
- Correct GTFS-Realtime VehiclePosition fields: position=2, timestamp=5, vehicle=8. Tests previously mirrored the incorrect decoder and are corrected against the official Google transit protobuf specification.
- Live Delhi validation returned HTTP 200 and 651 fresh vehicle records after this correction; before the correction it decoded zero. This observation is not a guarantee of continuous provider availability.

## Verification boundaries

The full local suite has two pre-existing DNS-dependent relay-cache failures (`tests/api.test.mjs`,
`tests/relay-cache.test.mjs` — api-v3.mbta.com resolves with EAI_AGAIN in this runtime). They fail
identically on a clean checkout of `main`. The new targeted tests pass. GitHub CI is the
independent full-suite check. Local browser navigation was blocked, so responsive visual and globe
interaction verification remain outstanding; source/unit tests are not visual verification.

**This environment has no outbound network at all** (every HTTPS connection, including
otd.delhi.gov.in, fails at TLS connect). No feed was verified live here, and none of the
2026-09-29 work claims to be: the probe tool and its weekly CI job are the verification path,
and `data/transit-probe.json` is the record. Until that report exists, any statement that Delhi
"returns 651 vehicles" is unverified and must not be repeated as fact.

## Remaining scope — not completed or claimed

- Provider-by-provider worldwide expansion and licence review. There is no enumerable, universally available set of every public feed.
- First valid infrastructure, OFAC, conflict and country snapshots: existing builders need real-source validation, not just synthetic fixtures.
- AI grounded answers, geographic alerting and durable history/playback require a backend, storage/retention decisions and a hosting budget.
- Flight origins/destinations, historical routes and full-ocean tracking depend on provider coverage and licensing. Never infer actual routes from straight-line estimates.
- Paid or protected feeds require authorised provider access; no access-control bypass.
- Netlify was last observed paused for usage limits. A successful GitHub merge is not evidence of a successful deployment.
- Delhi's key is still present in the inherited public transit registry (it is only a fallback now: `keyEnv: DELHI_OTD_KEY` / `/api/transit/keys` is the path that keeps it out of the page). Treat the in-file key as exposed: rotate it at otd.delhi.gov.in and set the Netlify environment variable. Do not reproduce the key in reports or logs.

Sources: https://otd.delhi.gov.in/documentation/ ; https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto
