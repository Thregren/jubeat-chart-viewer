"""Synthetic directory-only regression tests. No real music library is opened."""
import contextlib
import functools
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '铺面查看器/player'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import directory_library as D
import library
import config
import build_directory as B
from serve import RangeHandler
from http.server import ThreadingHTTPServer


def write(root, name, value):
    path = root / name; path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


def fixture(root):
    entry = dict(id='v/only', title='ID 1', version='v', charts=[], resourceOnly=True,
                 missing=['cover', 'charts/BSC'], assets={'audio':'songs/v/only/bgm.wav'})
    write(root, 'data/library.json', dict(format=D.FORMAT, songs=[], versions=[],
        versionIndexes=['data/versions/v.json', 'data/versions/uninstalled.json']))
    write(root, 'data/versions/v.json', dict(format=D.FORMAT, songs=[entry], versions=['v']))
    path=root/'songs/v/only/bgm.wav'; path.parent.mkdir(parents=True); path.write_bytes(b'RIFFsyntheticWAVE')
    # Even if present, these must not be opened or queried in directory mode.
    (root/'old.mcz').write_bytes(b'never-open-this')
    return entry


class DirectoryTests(unittest.TestCase):
    def test_no_mcz_or_old_metadata_and_partial_install(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); fixture(root)
            with patch.object(library, 'mcz_paths', side_effect=AssertionError('old scan')), \
                 patch.object(library, 'official_levels', side_effect=AssertionError('old levels')), \
                 patch.object(library.Library, '_read_cache', side_effect=AssertionError('old cache')):
                instance=library.Library(root); instance.load()
                public=json.loads(instance.published_response()[0]); song=public['songs'][0]
                self.assertEqual(song['assets']['audio'], 'songs/v/only/bgm.wav')
                self.assertTrue(song['resourceOnly']); self.assertEqual(song['charts'], [])
                self.assertEqual(song['missing'], ['cover','charts/BSC'])
                self.assertEqual(len(instance.songs),1)

    def test_duplicate_and_unsafe_paths_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); entry=fixture(root)
            for value in ['../x','/x','a\\b','https://x','a//b','a/./b']:
                with self.assertRaises(ValueError): D.asset_path(root,value)
            write(root,'data/versions/v.json',dict(format=D.FORMAT,songs=[entry,entry]))
            with self.assertRaises(ValueError): D.load_directory(root)

    def test_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as outside:
            root=Path(temp); (root/'escape').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError): D.asset_path(root,'escape/x')

    def test_chart_requires_explicit_path_and_resource_flag(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); entry=fixture(root)
            for changes in [dict(resourceOnly=False),dict(charts=[{'code':'EXT'}])]:
                write(root,'data/versions/v.json',dict(format=D.FORMAT,songs=[dict(entry,**changes)]))
                with self.assertRaises(ValueError): D.load_directory(root)

    def test_builder_preserves_wav_and_never_scans_zip(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'input';root.mkdir();fixture(root)
            out=Path(temp)/'site'
            with patch.object(library, 'mcz_paths', side_effect=AssertionError('old scan')):
                stats=B.build_directory(root,out,False)
            self.assertEqual(stats['mczOpened'],0);self.assertFalse(stats['legacyMetadataRead'])
            self.assertEqual((out/'songs/v/only/bgm.wav').read_bytes(),b'RIFFsyntheticWAVE')
            self.assertFalse((out/'old.mcz').exists())
            (root/'songs/v/only/bgm.wav').unlink()
            with self.assertRaises(ValueError):B.build_directory(root,out,False)

    def test_explicit_missing_library_does_not_fallback(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict('os.environ',{'JUBEAT_LIBRARY':temp}):
            self.assertEqual(config.resolve_library(),Path(temp).resolve())

    def test_static_wav_range(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);fixture(root)
            handler=functools.partial(RangeHandler,directory=str(root))
            httpd=ThreadingHTTPServer(('127.0.0.1',0),handler)
            thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
            try:
                conn=http.client.HTTPConnection(*httpd.server_address,timeout=5)
                conn.request('GET','/songs/v/only/bgm.wav',headers={'Range':'bytes=0-3'})
                response=conn.getresponse();self.assertEqual(response.status,206)
                self.assertEqual(response.read(),b'RIFF');self.assertIn('audio/',response.getheader('Content-Type'))
                conn.close()
            finally: httpd.shutdown();httpd.server_close();thread.join()

if __name__=='__main__':unittest.main()
