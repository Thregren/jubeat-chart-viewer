"""Single-flight transcodes and bounded archive handling."""
import concurrent.futures
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'jubeat_viewer/player'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_opus


class Resources(unittest.TestCase):
    def test_transcode_single_flight(self):
        calls = []
        def encode(cmd, **kwargs):
            calls.append(cmd[-1]); time.sleep(.02)
            Path(cmd[-1]).write_bytes(b'OggSOpusHead' + b'\0' * 2000)
            return type('Result', (), {'returncode': 0})()
        with tempfile.TemporaryDirectory() as td, patch.object(audio_opus, 'ffmpeg', return_value='ffmpeg'), patch.object(audio_opus, 'profile', return_value='test'), patch.object(audio_opus.subprocess, 'run', side_effect=encode):
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: audio_opus.encode(b'same source', Path(td)), range(8)))
            self.assertEqual(len(calls), 1)
            self.assertTrue(all(data.startswith(b'OggS') for data, status in results))
            self.assertEqual(len(list(Path(td).glob('*.tmp-*'))), 0)

    def test_encode_file_writes_atomically_and_rejects_non_opus(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = root/'bgm.wav'; source.write_bytes(b'RIFF' + b'\0' * 64)
            dest = root/'out'/'bgm.ogg'
            produced = []
            def encode(cmd, **kwargs):
                produced.append(cmd)
                Path(cmd[-1]).write_bytes(b'OggSOpusHead' + b'\0' * 2000)
                return type('Result', (), {'returncode': 0})()
            with patch.object(audio_opus, 'ffmpeg', return_value='ffmpeg'), \
                    patch.object(audio_opus.subprocess, 'run', side_effect=encode):
                audio_opus.encode_file(source, dest)
            self.assertTrue(dest.read_bytes().startswith(b'OggSOpusHead'))
            self.assertIn(str(source), produced[0])
            self.assertIn('libopus', produced[0])
            self.assertEqual(list(dest.parent.glob('*.tmp-*')), [])

            def bad(cmd, **kwargs):
                Path(cmd[-1]).write_bytes(b'not an opus file')
                return type('Result', (), {'returncode': 0})()
            dest.unlink()
            with patch.object(audio_opus, 'ffmpeg', return_value='ffmpeg'), \
                    patch.object(audio_opus.subprocess, 'run', side_effect=bad):
                with self.assertRaises(ValueError):
                    audio_opus.encode_file(source, dest)
            self.assertFalse(dest.exists())
            self.assertEqual(list(dest.parent.glob('*.tmp-*')), [])

    def test_missing_ffmpeg_is_an_error_for_the_publish_path(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = root/'bgm.wav'; source.write_bytes(b'RIFF')
            with patch.object(audio_opus, 'ffmpeg', return_value=None):
                with self.assertRaises(RuntimeError):
                    audio_opus.encode_file(source, root/'bgm.ogg')


if __name__ == '__main__': unittest.main()
