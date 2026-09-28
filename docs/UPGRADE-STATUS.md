# Consolidated upgrade status

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

The full local suite has two pre-existing DNS-dependent relay-cache failures because api-v3.mbta.com resolves with EAI_AGAIN in this runtime. The new targeted tests pass. GitHub CI is the independent full-suite check. Local browser navigation was blocked, so responsive visual and globe interaction verification remain outstanding; source/unit tests are not visual verification.

## Remaining scope — not completed or claimed

- Provider-by-provider worldwide expansion and licence review. There is no enumerable, universally available set of every public feed.
- First valid infrastructure, OFAC, conflict and country snapshots: existing builders need real-source validation, not just synthetic fixtures.
- AI grounded answers, geographic alerting and durable history/playback require a backend, storage/retention decisions and a hosting budget.
- Flight origins/destinations, historical routes and full-ocean tracking depend on provider coverage and licensing. Never infer actual routes from straight-line estimates.
- Paid or protected feeds require authorised provider access; no access-control bypass.
- Netlify was last observed paused for usage limits. A successful GitHub merge is not evidence of a successful deployment.
- Delhi's current key is present in the inherited public transit registry. Treat it as exposed: rotate it and migrate to a server-side environment variable before production hardening. Do not reproduce it in reports or logs.

Sources: https://otd.delhi.gov.in/documentation/ ; https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto
