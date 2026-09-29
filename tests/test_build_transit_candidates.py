"""Offline tests for tools/build_transit_candidates.py.

The CSV fetch needs the network, but the selector is the part that has to be right: a feed
that slips through with a key requirement, an http:// URL or a trip-updates-only endpoint
would sit in the registry permanently unavailable, which is the one thing the registry's
notes promise never happens.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import build_transit_candidates as builder  # noqa: E402

HEADER = ("mdb_source_id,data_type,entity_type,location.country_code,location.subdivision_name,"
          "location.municipality,provider,name,urls.direct_download,urls.authentication_type,"
          "urls.license,urls.latest,status")


def row(**overrides):
    base = {
        "mdb_source_id": "1", "data_type": "gtfs-rt", "entity_type": "vp",
        "location.country_code": "IS", "location.subdivision_name": "Capital Region",
        "location.municipality": "Reykjavik", "provider": "Strætó", "name": "Strætó vehicles",
        "urls.direct_download": "https://straeto.is/realtime/vehiclepositions.pb",
        "urls.authentication_type": "0", "urls.license": "https://creativecommons.org/licenses/by/4.0/",
        "urls.latest": "https://straeto.is/realtime", "status": "active",
    }
    # overrides arrive as column names with '.' flattened to '__' for readability
    base.update({key.replace("__", "."): value for key, value in overrides.items()})
    return {key: base[column] for key, column in builder.FIELDS.items()}


class Selection(unittest.TestCase):
    def test_a_keyless_https_vehicle_feed_is_selected(self):
        picked = builder.select_candidates([row()])
        self.assertEqual(len(picked), 1)
        self.assertEqual(picked[0]["base"], "https://straeto.is/realtime/vehiclepositions.pb")
        self.assertEqual(picked[0]["country"], "IS")
        self.assertEqual(picked[0]["operator"], "Strætó")
        self.assertIn("Mobility Database", picked[0]["source"])

    def test_keyed_http_and_non_vehicle_feeds_are_refused(self):
        rows = [
            row(urls__direct_download="https://a.example/vp.pb", urls__authentication_type="1"),
            row(urls__direct_download="http://b.example/vp.pb"),
            row(urls__direct_download="https://c.example/vp.pb?key=SECRET"),
            row(urls__direct_download="https://d.example/tu.pb", entity_type="tu"),
            row(urls__direct_download="https://e.example/static.zip", data_type="gtfs"),
        ]
        self.assertEqual(builder.select_candidates(rows), [],
                         "a keyed, http, key-in-URL, trip-updates-only or static feed is never proposed")

    def test_a_feed_already_in_the_registry_is_not_proposed_again(self):
        registry = {"feeds": [
            {"id": "already", "base": "https://straeto.is/realtime/vehiclepositions.pb"},
            {"id": "other-host", "base": "https://elsewhere.example/feed.pb"},
        ]}
        self.assertEqual(builder.select_candidates([row()], registry.get("feeds")), [])
        moved = row(urls__direct_download="https://straeto.is/realtime/vehiclepositions.pb?v=2")
        self.assertEqual(len(builder.select_candidates([moved], registry.get("feeds"))), 0,
                         "the same endpoint with a query string is the same feed")

    def test_selection_spreads_across_countries_and_respects_the_cap(self):
        rows = [
            row(mdb_source_id="1", location__country_code="IS", location__municipality="Reykjavik",
                urls__direct_download="https://a.example/vp.pb"),
            row(mdb_source_id="2", location__country_code="IS", location__municipality="Akureyri",
                urls__direct_download="https://b.example/vp.pb"),
            row(mdb_source_id="3", location__country_code="EE", location__municipality="Tallinn",
                urls__direct_download="https://c.example/vp.pb"),
        ]
        one_each = builder.select_candidates(rows, per_country=1)
        self.assertEqual([c["country"] for c in one_each], ["EE", "IS"])
        both = builder.select_candidates(rows, per_country=2)
        self.assertEqual(len(both), 3)
        self.assertEqual(len(builder.select_candidates(rows, per_country=2, limit=2)), 2)

    def test_missing_or_unexpected_columns_cannot_crash_the_run(self):
        self.assertEqual(builder.select_candidates([{key: "" for key in builder.FIELDS}]), [])
        self.assertEqual(builder.select_candidates([]), [])

    def test_a_catalogue_row_without_a_country_is_still_kept_but_marked(self):
        picked = builder.select_candidates([row(location__country_code="")])
        self.assertEqual(len(picked), 1)
        self.assertEqual(picked[0]["country"], "XX")


if __name__ == "__main__":
    unittest.main()
