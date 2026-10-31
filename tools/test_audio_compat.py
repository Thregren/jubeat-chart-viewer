#!/usr/bin/env python3
"""Fixture tests for the WebM and CAF compatibility generators."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "build_audio_webm", ROOT / "deploy" / "build-audio-webm.py"
)
WEBM = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(WEBM)
SPEC = importlib.util.spec_from_file_location(
    "build_audio_caf", ROOT / "deploy" / "build-audio-caf.py"
)
CAF = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(CAF)


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe unavailable"
)
class WebMAudioCompat(unittest.TestCase):
    def test_remuxes_ogg_opus_without_decoding_and_reuses_cached_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "song.ogg"
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                    "-c:a", "libopus", "-b:a", "64k", str(source),
                ],
                check=True,
            )
            target, status = WEBM.build_one(source)
            self.assertEqual(status, "built")
            self.assertEqual(target, source.with_suffix(".webm"))
            self.assertTrue(WEBM.valid_webm(target))
            first_mtime = target.stat().st_mtime_ns
            target, status = WEBM.build_one(source)
            self.assertEqual(status, "cached")
            self.assertEqual(target.stat().st_mtime_ns, first_mtime)

    def test_builds_lossless_opus_in_caf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "song.ogg"
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                    "-c:a", "libopus", "-b:a", "64k", str(source),
                ],
                check=True,
            )
            try:
                target, status = CAF.build_one(source)
            except RuntimeError as error:
                if (
                    "muxing codec currently unsupported" in str(error)
                    or "Not yet implemented in FFmpeg" in str(error)
                ):
                    self.skipTest("local ffmpeg cannot mux Opus in CAF")
                raise
            self.assertEqual(status, "built")
            self.assertEqual(target, source.with_suffix(".caf"))
            self.assertTrue(CAF.valid_caf(target))


if __name__ == "__main__":
    unittest.main()
