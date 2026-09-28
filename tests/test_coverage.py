import unittest
from tools.build_coverage import summarize


class CoverageTest(unittest.TestCase):
    def test_counts_are_not_misrepresented_as_live(self):
        result = summarize([
            {'properties': {'id': 'a', 'source': 'dot', 'stype': 'image', 'country': 'US'}},
            {'properties': {'id': 'b', 'source': 'dot', 'stype': 'm3u8', 'country': 'US'}},
        ], {'sources': [{'id': 'dot', 'name': 'DOT', 'url': 'https://example.test/?key=secret'}]},
            {'s': {'a': 1}, 'generated': '2026-01-01'})
        row = result['sources'][0]
        self.assertEqual(row['indexed'], 2)
        self.assertEqual(row['last_probe_success'], 1)
        self.assertEqual(row['unprobed'], 1)
        self.assertEqual(row['types'], {'image': 1, 'm3u8': 1})
        self.assertNotIn('secret', str(result))
