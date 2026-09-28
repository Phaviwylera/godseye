#!/usr/bin/env python3
"""God's Eye — aerodrome registry builder unit tests (stdlib unittest, no deps)."""
import importlib.util
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


HEADER = "id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code,local_code\n"
ROWS = (
    HEADER
    + '1,KJFK,large_airport,"John F Kennedy International Airport",40.6413,-73.7781,13,NA,US,US-NY,New York,yes,KJFK,JFK,KJFK,\n'
    + '2,EDDH,medium_airport,"Hamburg Helmut Schmidt Airport",53.6304,9.9882,53,EU,DE,DE-HH,Hamburg,yes,EDDH,HAM,,\n'
    + '3,SMALL,small_airport,"Pine Airstrip",67.1,-120.3,400,NA,CA,CA-NT,Fort Smith,no,,,,\n'
    + '4,HELI,heliport,"Rooftop Helipad",52.5,13.4,30,EU,DE,DE-BE,Berlin,yes,,,,\n'
    + '5,GOODBYE,closed,"Old Field",52.6,13.5,30,EU,DE,DE-BE,Berlin,no,,,,\n'
    + '6,BOGUS,small_airport,"Nowhere Strip",95.0,190.0,10,,XX,XX-XX,,no,,,,\n'
    + '7,SPB,seaplane_base,"Harbour Water Aerodrome",49.3,-123.1,0,NA,CA,CA-BC,Vancouver,no,,,,\n'
)


class TestAirportsBuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_module("build_airports", os.path.join(ROOT, "tools", "build_airports.py"))
        cls.mod.MIN_RECORDS = 3  # the guard's job is CI download protection, not sample size

    def test_compaction_keeps_every_non_closed_type_with_code_precedence(self):
        doc = self.mod.build(ROWS)
        self.assertEqual(doc["count"], 5)               # closed + bogus coords are refused
        self.assertEqual(doc["skipped"]["closed"], 1)
        self.assertEqual(doc["skipped"]["bad"], 1)
        by_code = {r[3]: r for r in doc["records"]}
        self.assertEqual(by_code["JFK"], [-73.7781, 40.6413, "l", "JFK", "John F Kennedy International Airport", "New York", "US"])
        self.assertEqual(by_code["HAM"][2], "m")        # IATA wins; full registry name rides along
        self.assertEqual(by_code["HAM"][3], "HAM")
        self.assertEqual(by_code["HAM"][4], "Hamburg Helmut Schmidt Airport")
        self.assertEqual(by_code["SMALL"][2], "s")      # small fields need no scheduled service
        self.assertEqual(by_code["HELI"][2], "h")
        self.assertEqual(by_code["SPB"][2], "w")

    def test_output_is_sorted_large_first_for_early_exit(self):
        doc = self.mod.build(ROWS)
        kinds = [r[2] for r in doc["records"]]
        self.assertLess(kinds.index("l"), kinds.index("m"))
        self.assertLess(kinds.index("m"), kinds.index("s"))

    def test_meta_carries_attribution_and_type_legend(self):
        doc = self.mod.build(ROWS)
        self.assertIn("OurAirports", doc["source"]["name"])
        self.assertEqual(doc["source"]["license"], "public domain")
        self.assertEqual(set(doc["types"].values()), {"large airport", "medium airport", "small airport", "heliport", "seaplane base", "balloonport"})

    def test_guards_refuse_non_csv_and_suspicious_counts(self):
        with self.assertRaises(ValueError):
            self.mod.build("not,a,catalog\n1,2,3\n")
        with self.assertRaises(ValueError):
            self.mod.MAX_RECORDS = 2
            self.mod.build(ROWS)
        self.mod.MAX_RECORDS = 120000


if __name__ == "__main__":
    unittest.main()
