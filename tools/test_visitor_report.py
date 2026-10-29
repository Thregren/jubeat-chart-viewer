import datetime
import sqlite3
import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str((Path(__file__).resolve().parent.parent / "deploy/visitors")))

from importlib.util import module_from_spec, spec_from_file_location
spec = spec_from_file_location("visitor_report", Path(__file__).resolve().parent.parent / "deploy/visitors/visitor-report.py")
report = module_from_spec(spec)
spec.loader.exec_module(report)


class VisitorReport(unittest.TestCase):
    def test_aggregate_is_private_and_builds_top_ten(self):
        now = int(datetime.datetime(2026, 10, 29, 12, tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp())
        events = []
        for index in range(12):
            song = f"v/song-{index}"
            for hit in range(index + 1):
                events.append({"event": "song", "event_id": f"s{index}-{hit}", "visitor": "visitor-" + str(index % 3),
                               "time": "2026-10-29T03:00:00Z", "_at": now, "song": song, "title": song,
                               "chart": "EXT", "ua": "Mozilla/5.0 (iPhone)", "ip": "127.0.0.1"})
        result = report.aggregate(events, now)
        self.assertEqual(len(result["top_songs"]), 10)
        self.assertEqual(result["top_songs"][0]["selections"], 12)
        self.assertNotIn("ip", str(result))
        self.assertNotIn("visitor-", str(result))

    def test_reads_only_recent_events_and_filters_bots(self):
        with tempfile.TemporaryDirectory() as temp:
            db = Path(temp) / "visitors.sqlite"
            with sqlite3.connect(db) as connection:
                connection.execute("CREATE TABLE events(at INTEGER,payload TEXT)")
                rows = [
                    (100, '{"event":"page","event_id":"a","visitor":"v","time":"1970-01-01T00:01:40Z","ua":"Mozilla","ip":"1.1.1.1"}'),
                    (100, '{"event":"page","event_id":"b","visitor":"x","time":"1970-01-01T00:01:40Z","ua":"curl/8","ip":"1.1.1.1"}'),
                ]
                connection.executemany("INSERT INTO events VALUES(?,?)", rows)
            events = report.load_events(db, 0)
            self.assertEqual([event["event_id"] for event in events], ["a"])


if __name__ == "__main__":
    unittest.main()
