#!/usr/bin/env python3
"""Fixture tests for the WebM and CAF compatibility generators."""

from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
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


class CompatibilityScheduleTests(unittest.TestCase):
    def test_cache_probes_once_and_rebuild_validates_new_file(self):
        for module, suffix, header in (
            (CAF, '.caf', b'caff'), (WEBM, '.webm', WEBM.EBML_HEADER)
        ):
            with self.subTest(container=suffix), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                valid = header + b'valid encode'
                for name in ('a', 'b'):
                    (root / f'{name}.ogg').write_bytes(b'source')
                    (root / f'{name}{suffix}').write_bytes(valid)
                probes = []
                encodes = []

                def run(command, **kwargs):
                    output = Path(command[-1])
                    if command[0] == 'ffmpeg':
                        encodes.append(Path(command[command.index('-i') + 1]).name)
                        output.write_bytes(valid)
                        return subprocess.CompletedProcess(command, 0, stdout='', stderr='')
                    probes.append(output.name)
                    if output.read_bytes() != valid:
                        return subprocess.CompletedProcess(command, 1, stdout='', stderr='bad cache')
                    result = {'streams': [{'codec_name': 'opus'}], 'format': {'format_name': suffix[1:]}}
                    return subprocess.CompletedProcess(command, 0, stdout=json.dumps(result), stderr='')

                def build(*options):
                    output = io.StringIO()
                    with patch.object(sys, 'argv', ['builder', '--root', str(root), *options]), \
                            patch.object(shutil, 'which', return_value='/fake/bin'), \
                            patch.object(shutil, 'disk_usage', return_value=Mock(free=2 * 1024**3)), \
                            patch.object(subprocess, 'run', side_effect=run), redirect_stdout(output):
                        self.assertEqual(module.main(), 0)
                    return json.loads(output.getvalue()[output.getvalue().index('{'):])

                self.assertEqual(build()['cached'], 2)
                self.assertEqual(probes, [f'a{suffix}', f'b{suffix}'])
                self.assertEqual(encodes, [])

                probes.clear()
                corrupt = root / f'b{suffix}'
                corrupt.write_bytes(header + b'bad encode')
                dry_run = build('--dry-run')
                self.assertEqual((dry_run['cached'], dry_run['pending']), (1, 1))
                self.assertEqual(encodes, [])
                self.assertEqual(probes, [f'a{suffix}', f'b{suffix}'])

                probes.clear()
                result = build()
                self.assertEqual((result['cached'], result['built'], result['failed']), (1, 1, 0))
                self.assertEqual(encodes, ['b.ogg'])
                self.assertEqual(probes[:2], [f'a{suffix}', f'b{suffix}'])
                self.assertEqual(len(probes), 3)
                self.assertTrue(probes[2].endswith(f'{suffix}.tmp'))
                self.assertEqual(corrupt.read_bytes(), valid)

    def test_caf_header_reads_only_four_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'song.caf'
            path.write_bytes(b'not caf at all')
            stream = Mock(wraps=io.BytesIO(path.read_bytes()))
            stream.__enter__ = Mock(return_value=stream)
            stream.__exit__ = Mock(return_value=False)
            with patch.object(Path, 'open', return_value=stream), patch.object(subprocess, 'run') as run:
                self.assertFalse(CAF.valid_caf(path))
            stream.read.assert_called_once_with(4)
            run.assert_not_called()


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
