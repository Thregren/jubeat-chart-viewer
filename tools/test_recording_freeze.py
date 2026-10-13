"""Real, tiny ffmpeg fixtures for freezes continuing through EOF."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import recording_audit as audit


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe unavailable")
class TerminalFreeze(unittest.TestCase):
    def fixture(self, folder, tail_only=False):
        path = folder / "v" / "song.mp4"
        path.parent.mkdir()
        if tail_only:
            source = "testsrc2=size=64x64:rate=15:duration=1"
            filters = ["-vf", "tpad=stop_mode=clone:stop_duration=2"]
        else:
            source = "color=c=black:s=64x64:r=15:duration=3"
            filters = []
        subprocess.run([audit.FFMPEG, "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", source,
                        *filters, "-c:v", "mpeg4", "-threads", "1", str(path)],
                       check=True, capture_output=True, timeout=15)
        path.with_suffix(".md").write_text("00:00 EXT\n")
        return path

    def test_full_video_freeze_at_eof_fails_active_play_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.fixture(root)
            chart = {"time": [{"beat": [0, 0, 1], "bpm": 60}],
                     "note": [{"index": 0, "beat": [1, 0, 1]}, {"index": 1, "beat": [2, 0, 1]}]}
            with patch.object(audit, "fetch_json", return_value=chart):
                row = audit.audit_one("v/song.mp4", root, {("v", "song"): {"id": "v/song.mcz"}},
                                      "http://unused", 1, 0.25)
            self.assertEqual(row["verdict"], "bad")
            self.assertEqual(len(row["freezes"]), 1)
            self.assertEqual(row["freezes"][0]["notes"], 2)
            self.assertAlmostEqual(row["freezes"][0]["end"], audit.probe_duration(path), places=2)

    def test_motion_followed_by_terminal_freeze_retains_last_interval(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.fixture(Path(tmp), tail_only=True)
            spans = audit.freeze_scan(path, 1)
            self.assertEqual(len(spans), 1)
            start, end = spans[0]
            self.assertGreater(start, 0.5)
            # Lossy inter-frame encoding can move the exact freeze start; the
            # terminal interval must still cover at least the requested second.
            self.assertLessEqual(start, end - 1)
            self.assertAlmostEqual(end, audit.probe_duration(path), places=2)


if __name__ == "__main__":
    unittest.main()
