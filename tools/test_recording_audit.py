"""Regression checks for chart-local versus merged-video audit timestamps."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recording_audit as audit


class TimelineTests(unittest.TestCase):
    def run_case(self, duration=200, freezes=(), offset=0, exact=False, stale=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version = root / "ver"
            version.mkdir()
            (version / "song.mp4").write_bytes(b"fixture")
            (version / "song.md").write_text("00:00 EXT\n01:40 ADV\n")
            if exact:
                stat = (version / "song.mp4").stat()
                (version / "song.rec.json").write_text(json.dumps({
                    "schema": 1, "video_size": stat.st_size + int(stale),
                    "video_mtime_ms": int(stat.st_mtime * 1000),
                    "segments": [{"code": "EXT", "start": 0, "end": 100.3},
                                 {"code": "ADV", "start": 100.3, "end": 200.3}],
                }))
            chart = {
                "time": [{"beat": [0, 0, 1], "bpm": 60}],
                "note": [
                    {"type": 1, "offset": offset},
                    {"index": 0, "beat": [5, 0, 1]},
                    {"index": 1, "beat": [95, 0, 1]},
                ],
            }
            with patch.object(audit, "fetch_json", return_value=chart), \
                    patch.object(audit, "probe_duration", return_value=duration), \
                    patch.object(audit, "freeze_scan", return_value=list(freezes)):
                return audit.audit_one(
                    "ver/song.mp4", root,
                    {("ver", "song"): {"id": "ver/song.mcz"}},
                    "http://unused", 1.5, 0.25,
                )

    def test_later_chart_is_not_missing(self):
        result = self.run_case()
        self.assertEqual(result["verdict"], "ok")
        self.assertEqual(result["sheets"][1]["last_note"], 195)

    def test_actual_truncation_still_fails(self):
        result = self.run_case(duration=180)
        self.assertEqual(result["verdict"], "bad")
        self.assertTrue(any("超出分段结尾" in fault for fault in result["faults"]))

    def test_later_chart_active_freeze_fails(self):
        result = self.run_case(freezes=[(104.8, 106.4)])
        self.assertEqual(result["verdict"], "bad")
        self.assertEqual(result["freezes"][0]["notes"], 1)

    def test_later_chart_quiet_gap_passes(self):
        result = self.run_case(freezes=[(120, 122)])
        self.assertEqual(result["verdict"], "ok")
        self.assertEqual(result["freezes"][0]["notes"], 0)

    def test_audio_offset_is_applied(self):
        result = self.run_case(freezes=[(106, 107.6)], offset=1000)
        self.assertEqual(result["verdict"], "bad")
        self.assertEqual(result["sheets"][1]["last_note"], 196)

    def test_boundary_checks_next_chart(self):
        result = self.run_case(freezes=[(100.2, 105.2)])
        self.assertEqual(result["verdict"], "bad")
        self.assertEqual(result["freezes"][0]["notes"], 1)

    def test_precise_chapter_avoids_edge_false_positive(self):
        result = self.run_case(duration=200.3, freezes=[(100.3, 105.03)], exact=True)
        self.assertEqual(result["verdict"], "ok")
        self.assertEqual(result["timeline"], "exact")

    def test_stale_metadata_is_not_used(self):
        result = self.run_case(duration=200.3, freezes=[(100.3, 105.03)], exact=True, stale=True)
        self.assertNotIn("timeline", result)
        self.assertEqual(result["verdict"], "bad")


if __name__ == "__main__":
    unittest.main()
