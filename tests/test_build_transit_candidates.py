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

# the canonical CSV column for each logical field: the first alias the tool tries
CANON = {key: aliases[0] for key, aliases in builder.FIELD_ALIASES.items()}

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
    return {key: base.get(column, "") for key, column in CANON.items()}


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
        self.assertEqual(builder.select_candidates([{key: "" for key in CANON}]), [])
        self.assertEqual(builder.select_candidates([]), [])

    def test_a_catalogue_row_without_a_country_is_still_kept_but_marked(self):
        picked = builder.select_candidates([row(location__country_code="")])
        self.assertEqual(len(picked), 1)
        self.assertEqual(picked[0]["country"], "XX")


class SchemaDrift(unittest.TestCase):
    def test_columns_are_resolved_against_the_header_not_assumed(self):
        resolved = builder.resolve_columns(["mdb_source_id", "data_type", "entity_type",
                                            "location.country_code", "urls.direct_download",
                                            "urls.authentication_type", "provider"])
        self.assertEqual(resolved["dataType"], "data_type")
        self.assertEqual(resolved["url"], "urls.direct_download")
        self.assertEqual(resolved["country"], "location.country_code")

    def test_a_renamed_column_is_still_found(self):
        resolved = builder.resolve_columns(["source_id", "datatype", "entitytype",
                                            "country_code", "direct_download_url",
                                            "authentication_type"])
        self.assertEqual(resolved["id"], "source_id")
        self.assertEqual(resolved["dataType"], "datatype")
        self.assertEqual(resolved["country"], "country_code")
        self.assertEqual(resolved["url"], "direct_download_url")

    def test_an_unrecognised_header_resolves_to_nothing_and_says_so(self):
        resolved = builder.resolve_columns(["a", "b", "c"])
        self.assertEqual(resolved, {})
        rows = builder.normalise_rows(__import__("csv").DictReader(
            __import__("io").StringIO("a,b,c\n1,2,3\n")), resolved)
        self.assertEqual(builder.select_candidates(rows), [])

    def test_two_rows_on_one_operator_host_are_one_candidate(self):
        rows = [row(mdb_source_id="1", urls__direct_download="https://one.example/vp.pb"),
                row(mdb_source_id="2", urls__direct_download="https://one.example/vp.pb?v=2"),
                row(mdb_source_id="3", urls__direct_download="https://two.example/vp.pb")]
        self.assertEqual(len(builder.select_candidates(rows, per_country=5)), 2)

    def test_a_feed_the_catalog_flags_as_unstable_is_not_proposed(self):
        counts = {}
        rows = [row(urls__direct_download="https://steady.example/vp.pb"),
                row(urls__direct_download="https://wobbly.example/vp.pb",
                    is_producer_url_unstable="true")]
        picked = builder.select_candidates(rows, per_country=5, counts=counts)
        self.assertEqual([c["base"] for c in picked], ["https://steady.example/vp.pb"])
        self.assertEqual(counts["unstable"], 1)

    def test_the_filter_counts_explain_why_the_selection_is_small(self):
        counts = {}
        rows = [row(), row(urls__authentication_type="1"),
                row(urls__direct_download="https://only-trips.example/tu.pb", entity_type="tu")]
        builder.select_candidates(rows, counts=counts)
        self.assertEqual(counts["rows"], 3)
        self.assertEqual(counts["gtfsrt"], 3)
        self.assertEqual(counts["vehiclePositions"], 2, "the trip-updates-only feed is counted out")
        self.assertEqual(counts["keyless"], 1)
        self.assertEqual(counts["https"], 1)


if __name__ == "__main__":
    unittest.main()
