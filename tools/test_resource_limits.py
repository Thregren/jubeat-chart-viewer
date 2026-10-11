"""Bounded archives, incremental indexing and single-flight transcodes."""
import concurrent.futures
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '铺面查看器/player'))
import media
import library
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

    def test_archive_budget_and_atomic_streaming(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = root/'song.mcz'; dest = root/'audio.ogg'
            with zipfile.ZipFile(source, 'w') as z:
                z.writestr('bgm.ogg', b'a' * 10000); z.writestr('chart.mc', b'{}')
            with patch.object(media, 'read_member', side_effect=AssertionError('whole-member allocation')):
                media.cached_member_file(source, 'bgm.ogg', dest)
            self.assertEqual(dest.read_bytes(), b'a' * 10000)
            with patch.object(media, 'MAX_MEMBER_BYTES', 100):
                with self.assertRaises(ValueError): media.read_member(source, 'bgm.ogg')
            with patch.object(media, 'MAX_ARCHIVE_ENTRIES', 1):
                with self.assertRaises(ValueError): media.read_member(source, 'chart.mc')
            with zipfile.ZipFile(source, 'a') as z: z.writestr('nested/bgm.ogg', b'b')
            with self.assertRaises(FileNotFoundError): media.read_member(source, 'other/bgm.ogg')

    def test_empty_library_is_cached(self):
        with tempfile.TemporaryDirectory() as td, patch.object(library.config, 'INDEX_CACHE', Path(td)/'index.json'):
            lib = library.Library(Path(td)/'music'); lib.root.mkdir()
            with patch.object(lib, '_scan', wraps=lib._scan) as scan:
                lib.load(); lib.load(); self.assertEqual(scan.call_count, 1)
            other = library.Library(lib.root)
            with patch.object(other, '_scan', side_effect=AssertionError('empty cache miss')): other.load()

    def test_only_changed_archives_are_rescanned(self):
        with tempfile.TemporaryDirectory() as td, patch.object(library.config, 'INDEX_CACHE', Path(td)/'index.json'):
            root = Path(td)/'music'; root.mkdir()
            def song(path, _):
                return {'id': path.name, 'title':path.name, 'version':'v', 'charts':[]}
            (root/'a.mcz').write_bytes(b'a'); (root/'b.mcz').write_bytes(b'b')
            lib = library.Library(root)
            with patch.object(library, 'scan_song', side_effect=song) as scan:
                lib.load(); self.assertEqual(scan.call_count, 2); scan.reset_mock()
                lib.load(force=True); self.assertEqual(scan.call_count, 0)
                (root/'a.mcz').write_bytes(b'updated'); lib.load(force=True)
                self.assertEqual([call.args[0].name for call in scan.call_args_list], ['a.mcz'])

if __name__ == '__main__': unittest.main()
