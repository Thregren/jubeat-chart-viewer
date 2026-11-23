import datetime
import hashlib
import io
import json
import sqlite3
import struct
import sys
import tempfile
import unittest
from contextlib import ExitStack, closing
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest import mock

sys.path.insert(0, str((Path(__file__).resolve().parent.parent / "deploy/visitors")))

from ip2region import HEADER_BYTES, INDEX_BYTES, VECTOR_BYTES, VECTOR_COLUMNS

spec = spec_from_file_location("visitor_report", Path(__file__).resolve().parent.parent / "deploy/visitors/visitor-report.py")
report = module_from_spec(spec)
spec.loader.exec_module(report)


def make_geo_data():
    start = HEADER_BYTES + VECTOR_COLUMNS * VECTOR_COLUMNS * VECTOR_BYTES
    location = "甲国|乙省|丙城|0|0".encode()
    data = bytearray(start + INDEX_BYTES)
    struct.pack_into("<HHIIIHH", data, 0, 3, 0, 100, start, len(data), 4, 4)
    vector = HEADER_BYTES + (VECTOR_COLUMNS + 1) * VECTOR_BYTES
    struct.pack_into("<II", data, vector, start, start)
    address = b"\x01\x01\x01\x01"
    struct.pack_into("<4s4sHI", data, start, address, address, len(location), len(data))
    return bytes(data) + location


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
        def payload(at, event_id, **fields):
            return json.dumps({"event": "page", "event_id": event_id, "visitor": "v",
                               "time": datetime.datetime.fromtimestamp(at, report.TZ).isoformat(), **fields})

        with tempfile.TemporaryDirectory() as temp:
            db = Path(temp) / "visitors.sqlite"
            with closing(sqlite3.connect(db)) as connection, connection:
                connection.execute("CREATE TABLE events(at INTEGER,payload TEXT)")
                rows = [
                    (90, payload(110, "old-db")),
                    (100, payload(90, "old-payload")),
                    (101, payload(101, "a", ua="curl/8")),
                    (102, payload(102, "a")),
                    (103, payload(103, "a", visitor="x")),
                    (104, payload(104, "b", bot=True)),
                    (105, payload(105, "b", event="unsupported")),
                    (106, "invalid JSON"),
                    (107, payload(107, "b", event="app_ready")),
                    (108, payload(108, "c", visitor="")),
                    (109, payload(109, "c")),
                ]
                connection.executemany("INSERT INTO events VALUES(?,?)", rows)
            with closing(report.load_events(db, 100)) as events:
                with mock.patch.object(report.json, "loads", wraps=json.loads) as decode:
                    self.assertEqual(next(events)["event_id"], "a")
                    self.assertEqual(decode.call_count, 3)
                tail = list(events)
            self.assertEqual([event["event_id"] for event in tail], ["b", "c"])
            totals = report.aggregate(tail, 110)["totals"]
            self.assertEqual(totals["visitors"], 1)
            self.assertEqual(totals["page_views"], 0)

    def test_aggregate_preserves_first_categories_and_public_ip(self):
        midnight = int(datetime.datetime(2026, 10, 30, tzinfo=report.TZ).timestamp())
        rows = [
            {"event": "page", "visitor": "v1", "_at": midnight - 2, "ua": "iPhone Safari/1", "ip": "127.0.0.1"},
            {"event": "song", "visitor": "v2", "_at": midnight - 1, "device": "平板", "browser": "Edge",
             "ip": "2606:4700:4700::1111", "song": "alpha", "title": "原曲"},
            {"event": "song", "visitor": "v1", "_at": midnight, "device": "电脑", "browser": "Firefox",
             "ip": "1.1.1.1", "song": "alpha", "title": "后来的曲名"},
            {"event": "song", "visitor": "v2", "_at": midnight + 1, "ip": "8.8.8.8", "song": "alpha"},
            {"event": "song", "visitor": "v1", "_at": midnight + 2, "ip": "9.9.9.9"},
            {"event": "chart_ready", "visitor": "v3", "_at": midnight + 3},
        ]
        reader = mock.Mock()
        reader.search.return_value = "甲国|乙省|0|0|0"
        result = report.aggregate(iter(rows), midnight + 4, reader)

        reader.search.assert_called_once_with("1.1.1.1")
        self.assertEqual(result, {
            "generated_at": "2026-10-30T00:00:04+08:00", "window_days": 7, "timezone": "Asia/Shanghai",
            "totals": {"visitors": 3, "page_views": 1, "song_selections": 4, "song_visitors": 2},
            "daily": [
                {"date": "2026-10-29", "visitors": 2, "page_views": 1, "song_selections": 1},
                {"date": "2026-10-30", "visitors": 3, "page_views": 0, "song_selections": 3},
            ],
            "funnel": {"chart_ready": 1, "page": 1, "song": 4},
            "devices": {"手机": 1, "平板": 1, "未知": 1},
            "browsers": {"Edge": 1, "Safari": 1, "其他/未知": 1},
            "geography": [{"country": "甲国", "province": "乙省", "city": "乙省",
                           "visitors": 1, "page_views": 1, "song_selections": 2}],
            "top_songs": [{"song": "alpha", "title": "原曲", "selections": 3, "visitors": 2}],
        })


class RegionCache(unittest.TestCase):
    def setUp(self):
        resources = ExitStack()
        self.addCleanup(resources.close)
        self.data = make_geo_data()
        expected = hashlib.sha1(f"blob {len(self.data)}\0".encode() + self.data).hexdigest()
        resources.enter_context(mock.patch.multiple(report, SIZE=len(self.data), GIT_BLOB_SHA1=expected))
        self.path = Path(resources.enter_context(tempfile.TemporaryDirectory())) / "ip2region.xdb"

    def test_cached_reader_uses_the_verified_buffer(self):
        self.path.write_bytes(self.data)
        with mock.patch.object(report.Reader, "_load", autospec=True, side_effect=report.Reader._load) as load:
            reader = report.ensure_geo(self.path, allow_download=False)
        load.assert_called_once()
        self.assertIs(load.call_args.args[1], reader.data)
        self.assertEqual(reader.search("1.1.1.1"), "甲国|乙省|丙城|0|0")

    def test_rejects_damaged_cache_without_using_mirrors(self):
        contents = (self.data[:-1] + b"x", self.data[:-1], self.data + b"x")
        with mock.patch.object(report.urllib.request, "urlopen") as download:
            for data in contents:
                with self.subTest(size=len(data)):
                    self.path.write_bytes(data)
                    with self.assertRaises(ValueError):
                        report.ensure_geo(self.path, allow_download=True)
                    self.assertEqual(self.path.read_bytes(), data)
            download.assert_not_called()

    def test_matching_digest_still_requires_a_valid_format(self):
        data = b"\x00" + self.data[1:]
        digest = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        self.path.write_bytes(data)
        with mock.patch.object(report, "GIT_BLOB_SHA1", digest):
            with self.assertRaisesRegex(ValueError, "Unsupported IP2region database format"):
                report.ensure_geo(self.path, allow_download=False)

    def test_download_retries_and_publishes_the_same_verified_buffer(self):
        class ShortReads(io.BytesIO):
            def readinto(self, buffer):
                return super().readinto(buffer[:8192])

        responses = (io.BytesIO(self.data[:-1]), ShortReads(self.data))
        with mock.patch.object(report.urllib.request, "urlopen", side_effect=responses) as download:
            with mock.patch.object(report.Reader, "_load", autospec=True, side_effect=report.Reader._load) as load:
                reader = report.ensure_geo(self.path, allow_download=True)
        self.assertEqual(download.call_count, 2)
        load.assert_called_once()
        self.assertEqual(self.path.read_bytes(), self.data)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(reader.search("1.1.1.1"), "甲国|乙省|丙城|0|0")
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])


if __name__ == "__main__":
    unittest.main()
