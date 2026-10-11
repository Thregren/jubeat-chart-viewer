#!/usr/bin/env python3
"""Regressions for pre-play stills versus freezes during active chart playback."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("audit", pathlib.Path(__file__).parent / "recording_audit.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

class TimelineTests(unittest.TestCase):
    def run_case(self, freezes=(), identity=True, playback=3):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            folder = root / "ver"
            folder.mkdir()
            video = folder / "song.mp4"
            video.write_bytes(b"fixture")
            video.with_suffix(".md").write_text("00:01 EXT\n01:44 ADV\n")
            st = video.stat()
            video.with_suffix(".rec.json").write_text(json.dumps({
                "schema": 1, "video_size": st.st_size if identity else 999,
                "video_mtime_ms": int(st.st_mtime * 1000), "from": 0,
                "segments": [
                    {"code": "EXT", "start": 0, "chapter_start": 1, "playback_start": playback, "end": 103},
                    {"code": "ADV", "start": 103, "chapter_start": 104, "playback_start": 106, "end": 206},
                ],
            }))
            chart = {"time": [{"beat": [0, 0, 1], "bpm": 60}],
                     "note": [{"type": 1, "offset": 1000},
                              {"index": 0, "beat": [0, 0, 1]},
                              {"index": 1, "beat": [95, 0, 1]}]}
            with patch.object(audit, "fetch_json", return_value=chart), \
                 patch.object(audit, "probe_duration", return_value=206), \
                 patch.object(audit, "freeze_scan", return_value=list(freezes)):
                return audit.audit_one("ver/song.mp4", root,
                    {("ver", "song"): {"id": "ver/song.mcz"}}, "http://unused", 1.5, .25)

    def test_notes_use_playback_start_not_chapter(self):
        row = self.run_case()
        self.assertEqual(row["verdict"], "ok")
        self.assertEqual([s["last_note"] for s in row["sheets"]], [99, 202])

    def test_declared_hold_is_not_active_freeze(self):
        row = self.run_case(freezes=[(104, 106)])
        self.assertEqual(row["verdict"], "ok")
        self.assertEqual(row["freezes"][0]["reason"], "intentional_preplay_hold")

    def test_freeze_extending_into_first_note_fails(self):
        row = self.run_case(freezes=[(104, 108)])
        self.assertEqual(row["verdict"], "bad")
        self.assertEqual(row["freezes"][0]["notes"], 1)

    def test_stale_identity_cannot_exempt_hold(self):
        row = self.run_case(freezes=[(104, 106)], identity=False)
        self.assertNotEqual(row.get("timeline"), "exact")
        self.assertNotIn("reason", row["freezes"][0])

    def test_invalid_playback_cannot_exempt_real_freeze(self):
        row = self.run_case(freezes=[(104, 108)], playback=999)
        self.assertNotEqual(row.get("timeline"), "exact")
        self.assertEqual(row["verdict"], "bad")

if __name__ == "__main__":
    unittest.main()
