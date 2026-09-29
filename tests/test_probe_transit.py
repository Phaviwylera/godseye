"""Offline tests for tools/probe_transit.py.

The probe itself needs the network, so what is tested here is the part that must never be
wrong: the dependency-free protobuf reader and the verdict logic. Every frame is built
byte by byte, because a parser that is only ever checked against its own output proves
nothing — the same rule the JS GTFS-RT reader is held to.

The live sweep runs weekly in CI (.github/workflows/probe-transit.yml), where there is a
network; these tests run everywhere, including offline.
"""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import probe_transit as probe  # noqa: E402

NOW = 1760000000.0                      # a fixed "now" so epoch maths is reproducible


# ----------------------------------------------------------------------- frame builders
def varint(n):
    out = []
    while n >= 0x80:
        out.append((n & 0x7F) | 0x80)
        n //= 128
    out.append(n)
    return bytes(out)


def tag(field, wire):
    return varint(field * 8 + wire)


def ld(field, payload):
    return tag(field, 2) + varint(len(payload)) + payload


def txt(field, value):
    return ld(field, value.encode("utf-8"))


def num(field, value):
    return tag(field, 0) + varint(value)


def f32(field, value):
    import struct
    return tag(field, 5) + struct.pack("<f", value)


def position(lat, lon, bearing=0.0, speed=0.0):
    return f32(1, lat) + f32(2, lon) + f32(3, bearing) + f32(5, speed)


def current_map(lat, lon, at, route="244", label="DL1PD4567", vid="veh1", stop_id="STOP-77",
                bearing=0.0, speed=0.0):
    """The field map in google/transit master + the gtfs.org v2.0 reference."""
    return ld(4,
              ld(1, txt(1, "trip-1") + txt(2, "11:28:25") + txt(5, route))
              + ld(8, txt(1, vid) + txt(2, label))
              + ld(2, position(lat, lon, bearing, speed))
              + txt(7, stop_id)
              + num(5, int(at)))


def legacy_map(lat, lon, at, route="244", label="DL1PD4567", vid="veh1", stop_id="STOP-77"):
    """The numbering older producer libraries emit: vehicle 2 · position 3 · stop_id 5 · timestamp 7."""
    return ld(4,
              ld(1, txt(1, "trip-1") + txt(2, "11:28:25") + txt(5, route))
              + ld(2, txt(1, vid) + txt(2, label))
              + ld(3, position(lat, lon))
              + txt(5, stop_id)
              + num(4, 3)                       # current_stop_sequence in the legacy map
              + num(7, int(at)))


def feed_message(entities, header_at=NOW):
    head = ld(1, txt(1, "2.0") + num(3, int(header_at)) + txt(4, "probe-fixture"))
    return head + b"".join(ld(2, txt(1, f"entity-{i}") + body) for i, body in enumerate(entities))


class WireReader(unittest.TestCase):
    def test_varints_and_wire_types_round_trip(self):
        self.assertEqual(probe.read_varint(varint(0), 0), (0, 1))
        self.assertEqual(probe.read_varint(varint(300), 0), (300, 2))
        self.assertEqual(probe.read_varint(varint(int(NOW)), 0), (int(NOW), len(varint(int(NOW)))))

    def test_a_frame_with_every_wire_type_is_parsed(self):
        frame = txt(2, "hi") + f32(1, 1.5) + num(3, 9) + tag(4, 1) + b"\x01" * 8
        fields = probe.read_fields(frame)
        self.assertEqual([f[0] for f in fields], [2, 1, 3, 4])
        self.assertEqual(probe.string(fields, 2), "hi")
        self.assertAlmostEqual(probe.fixed(fields, 1), 1.5, places=5)
        self.assertEqual(probe.num(fields, 3), 9)

    def test_a_truncated_or_unknown_frame_refuses_instead_of_guessing(self):
        with self.assertRaises(ValueError):
            probe.read_fields(txt(1, "hi")[:-1])
        with self.assertRaises(ValueError):
            probe.read_fields(tag(1, 7))
        with self.assertRaises(ValueError):
            probe.read_varint(b"\x80\x80", 0)


class VehiclePositionDecoding(unittest.TestCase):
    def test_the_current_field_map_decodes(self):
        payload = feed_message([current_map(28.6139, 77.209, NOW - 15, speed=7.2, bearing=91.5)])
        vehicles, report = probe.decode_vehicle_positions(payload, max_age_sec=600, now=NOW)
        self.assertEqual(len(vehicles), 1)
        self.assertEqual(report["map"], "current")
        self.assertEqual(report["entities"], 1)
        self.assertEqual(report["kept"], 1)
        self.assertAlmostEqual(vehicles[0]["lat"], 28.6139, places=4)
        self.assertAlmostEqual(vehicles[0]["lon"], 77.209, places=4)
        self.assertEqual(vehicles[0]["route"], "244")
        self.assertEqual(vehicles[0]["label"], "DL1PD4567")
        self.assertEqual(vehicles[0]["stopId"], "STOP-77")
        self.assertEqual(vehicles[0]["observed"], int(NOW) - 15)

    def test_the_legacy_field_map_decodes_rather_than_yielding_nothing(self):
        payload = feed_message([legacy_map(28.5355, 77.391, NOW - 30, route="392", label="DL1PC2222")])
        vehicles, report = probe.decode_vehicle_positions(payload, max_age_sec=600, now=NOW)
        self.assertEqual(len(vehicles), 1, "a legacy frame must not decode to an empty city")
        self.assertEqual(report["map"], "legacy")
        self.assertAlmostEqual(vehicles[0]["lat"], 28.5355, places=4)
        self.assertEqual(vehicles[0]["route"], "392")
        self.assertEqual(vehicles[0]["label"], "DL1PC2222")
        self.assertEqual(vehicles[0]["stopId"], "STOP-77", "the legacy stop_id at field 5 is a stop")
        self.assertEqual(vehicles[0]["observed"], int(NOW) - 30, "and field 7 is the timestamp")

    def test_both_maps_in_one_feed_are_each_read_on_their_own_terms(self):
        payload = feed_message([
            current_map(28.61, 77.21, NOW - 10, vid="cur", label="CURRENT-1", route="1"),
            legacy_map(28.62, 77.22, NOW - 20, vid="leg", label="LEGACY-1", route="2", stop_id="S2"),
        ])
        vehicles, report = probe.decode_vehicle_positions(payload, max_age_sec=600, now=NOW)
        self.assertEqual(len(vehicles), 2)
        self.assertIn(report["map"], ("current", "legacy"))
        self.assertEqual({v["label"] for v in vehicles}, {"CURRENT-1", "LEGACY-1"})
        self.assertEqual({v["stopId"] for v in vehicles}, {"STOP-77", "S2"})

    def test_stale_null_island_and_positionless_entities_are_counted_not_drawn(self):
        payload = feed_message([
            current_map(28.61, 77.21, NOW - 5000, vid="stale"),          # far beyond any window
            current_map(0.0, 0.0, NOW - 10, vid="nullisland"),           # the Atlantic, not Delhi
            ld(4, ld(1, txt(1, "trip-9"))),                              # no position at all
            current_map(28.63, 77.23, NOW - 10, vid="good"),
        ])
        vehicles, report = probe.decode_vehicle_positions(payload, max_age_sec=600, now=NOW)
        self.assertEqual(len(vehicles), 1)
        self.assertEqual(vehicles[0]["label"], "DL1PD4567")
        self.assertEqual(report["entities"], 4)
        self.assertEqual(report["withPosition"], 3)
        self.assertEqual(report["stale"], 1)
        self.assertEqual(report["badCoords"], 1)

    def test_a_feed_with_no_entities_is_reported_as_empty_not_missing(self):
        payload = feed_message([])
        vehicles, report = probe.decode_vehicle_positions(payload, max_age_sec=600, now=NOW)
        self.assertEqual(vehicles, [])
        self.assertEqual(report["entities"], 0)
        self.assertGreater(report["bytes"], 0, "an answer with no vehicles is not the same as no answer")
        self.assertEqual(report["headerSeconds"], int(NOW))

    def test_an_undecodable_payload_raises_for_the_probe_to_report(self):
        with self.assertRaises(ValueError):
            probe.decode_vehicle_positions(b"\x08\xff\xff\xff", now=NOW)


class Verdicts(unittest.TestCase):
    def test_verdicts_follow_the_counts_and_never_invent_a_reason(self):
        self.assertEqual(probe.verdict_for({"entities": 100, "kept": 100}), "live")
        self.assertEqual(probe.verdict_for({"entities": 100, "kept": 98}), "live (2 dropped)")
        self.assertEqual(probe.verdict_for({"entities": 60, "kept": 0}),
                         "empty: answered with entities but none are drawable")
        self.assertEqual(probe.verdict_for({"entities": 0, "kept": 0}),
                         "empty: answered with no vehicle entities")

    def test_format_rows_names_every_column_the_probe_reports(self):
        rows = [{
            "id": "delhi-dtc", "city": "Delhi", "status": 200, "bytes": 412904,
            "entities": 651, "kept": 651, "map": "current", "verdict": "live",
        }, {
            "id": "atlanta-marta", "city": "Atlanta", "status": 403, "bytes": 0,
            "entities": 0, "kept": 0, "map": None, "verdict": "unreachable",
        }]
        table = probe.format_rows(rows)
        self.assertIn("delhi-dtc", table)
        self.assertIn("current", table)
        self.assertIn("unreachable", table)
        self.assertIn("651", table)


class ClockOffsets(unittest.TestCase):
    def test_a_feed_running_on_local_time_is_named_not_silently_corrected(self):
        report = {"newestSeconds": NOW - 19800, "entities": 651, "kept": 0, "stale": 651}
        hint = probe.clock_hint(report, now=NOW)
        self.assertIn("5.50 h behind", hint)
        self.assertIn("+5.50 h correction would make them fresh", hint)

    def test_a_fresh_feed_gets_no_clock_lecture(self):
        self.assertEqual(probe.clock_hint({"newestSeconds": NOW - 30}, now=NOW), "")

    def test_a_payload_without_any_timestamp_says_so(self):
        self.assertEqual(probe.clock_hint({"newestSeconds": None}, now=NOW), "")

    def test_decoding_records_whether_entities_carry_their_own_timestamps(self):
        payload = feed_message([
            current_map(28.61, 77.21, NOW - 10, vid="a"),
            current_map(28.62, 77.22, NOW - 20, vid="b"),
        ])
        _, report = probe.decode_vehicle_positions(payload, max_age_sec=600, now=NOW)
        self.assertEqual(report["explicitTimestamps"], 2)
        self.assertEqual(report["newestSeconds"], int(NOW) - 10)
        header_only = feed_message([ld(4, ld(1, txt(1, "trip-1")) + ld(2, position(28.61, 77.21)))])
        _, report2 = probe.decode_vehicle_positions(header_only, max_age_sec=600, now=NOW)
        self.assertEqual(report2["explicitTimestamps"], 0, "no per-entity timestamp: the header's is used")
        self.assertEqual(report2["kept"], 1)


class FailureStreaks(unittest.TestCase):
    def test_a_single_blip_is_not_a_verdict(self):
        rows = probe.annotate_history([{"id": "a", "verdict": "live"}], None, "2026-09-29T09:00:00Z")
        self.assertEqual(rows[0]["failedSweeps"], 0)
        self.assertEqual(rows[0]["lastLiveAt"], "2026-09-29T09:00:00Z")

    def test_consecutive_failures_accumulate_and_a_recovery_resets_them(self):
        history = {"feeds": [{"id": "a", "verdict": "unreachable", "failedSweeps": 1,
                              "lastLiveAt": "2026-09-28T09:00:00Z", "sweepsObserved": 4}]}
        again = probe.annotate_history([{"id": "a", "verdict": "unreachable"}], history, "2026-09-29T09:00:00Z")
        self.assertEqual(again[0]["failedSweeps"], 2, 'two in a row is a decision, not a blip')
        self.assertEqual(again[0]["lastLiveAt"], "2026-09-28T09:00:00Z", 'and the last known-good sweep is kept')
        self.assertEqual(again[0]["sweepsObserved"], 5)
        healed = probe.annotate_history([{"id": "a", "verdict": "live"}], {"feeds": again}, "2026-09-29T10:00:00Z")
        self.assertEqual(healed[0]["failedSweeps"], 0)

    def test_a_feed_absent_from_the_previous_report_starts_clean(self):
        rows = probe.annotate_history([{"id": "new", "verdict": "unreachable"}],
                                      {"feeds": [{"id": "other", "verdict": "live"}]}, "now")
        self.assertEqual(rows[0]["failedSweeps"], 1)
        self.assertIsNone(rows[0]["lastLiveAt"])


class Keys(unittest.TestCase):
    def test_a_server_side_key_replaces_only_the_key_parameter(self):
        feed = {"id": "delhi-dtc", "keyEnv": "DELHI_OTD_KEY",
                "base": "https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=PUBLICKEY"}
        os.environ.pop("DELHI_OTD_KEY", None)
        self.assertEqual(probe.endpoint_for(feed), feed["base"], "no env key: the registry URL stands")
        os.environ["DELHI_OTD_KEY"] = "SECRET/KEY+1"
        try:
            url = probe.endpoint_for(feed)
        finally:
            os.environ.pop("DELHI_OTD_KEY", None)
        self.assertTrue(url.startswith("https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key="))
        self.assertNotIn("PUBLICKEY", url)
        self.assertIn("SECRET", url)

    def test_a_feed_without_key_env_is_never_rewritten(self):
        feed = {"id": "atlanta-marta", "base": "https://gtfs-rt.itsmarta.com/x.pb?key=abc"}
        os.environ["DELHI_OTD_KEY"] = "SECRET"
        try:
            self.assertEqual(probe.endpoint_for(feed), feed["base"])
        finally:
            os.environ.pop("DELHI_OTD_KEY", None)


if __name__ == "__main__":
    unittest.main()
