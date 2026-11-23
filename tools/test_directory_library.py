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
from zipfile import ZipFile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'jubeat_viewer/player'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import directory_library as D
import library
import config
import build_directory as B
from package_directory import package_common
import split_background_stories as stories
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


def story_catalog(path, title, *, invalid=False):
    records = {'song': {'id': 'song', 'title': title}}
    if invalid:
        records['other'] = {'id': 'wrong'}
    value = {'documentCount': len(records), 'records': records}
    path.write_text('const data=' + json.dumps(value) + ';', encoding='utf-8')


class StoryBuildTests(unittest.TestCase):
    def test_split_validates_before_switching_and_retains_previous_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, output = root / 'catalog.js', root / 'static'
            story_catalog(source, 'First')
            self.assertEqual(stories.split_catalog(source, output), 1)
            old = stories.read_generation(output)
            old_payload = next(name for name in old if name != stories.INDEX)
            unrelated = output / 'background-story-not-generated.json'
            unrelated.write_text('keep me')
            directory = output / 'background-story-00000000000000000000.json'
            directory.mkdir()

            story_catalog(source, 'Second', invalid=True)
            with self.assertRaisesRegex(ValueError, 'Invalid story ID'):
                stories.split_catalog(source, output)
            self.assertEqual(stories.read_generation(output), old)
            self.assertEqual(set(output.iterdir()), {output / name for name in old} | {unrelated, directory})

            story_catalog(source, 'Second')
            stories.split_catalog(source, output, complete=True)
            current = stories.read_generation(output)
            self.assertIn(stories.COMPLETE.encode(), current[stories.INDEX])
            self.assertFalse((output / old_payload).exists())
            self.assertEqual(stories.read_generation(output / stories.PREVIOUS), old)
            self.assertEqual(unrelated.read_text(), 'keep me')
            self.assertTrue(directory.is_dir())
            before = (output / stories.INDEX).stat()
            stories.split_catalog(source, output, complete=True)
            self.assertEqual((output / stories.INDEX).stat().st_ino, before.st_ino)
            self.assertEqual(stories.read_generation(output / stories.PREVIOUS), old)

    def test_directory_rebuild_prunes_old_payloads_and_rejects_corrupt_source(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp)
            source, output, repo = parent / 'input', parent / 'site', parent / 'repo'
            fixture(source)
            static = repo / 'jubeat_viewer/player/static'
            static.mkdir(parents=True)
            (static / 'index.html').write_text(
                '<html><head><title>Viewer</title></head><body><div id="app"></div>'
                '<div id="panel"></div><script src="static/background-stories-index.js?v=test">'
                '</script></body></html>', encoding='utf-8')
            catalog = static / 'background-stories-data.js'
            story_catalog(catalog, 'Before')
            stories.split_catalog(catalog, static)
            with patch.object(B, 'REPO', repo):
                B.build_directory(source, output, False)
                published = output / 'static'
                old = stories.read_generation(published)
                old_payload = next(name for name in old if name != stories.INDEX)
                self.assertIn(stories.COMPLETE.encode(), old[stories.INDEX])
                self.assertFalse((published / catalog.name).exists())
                (published / catalog.name).write_text('left over from an earlier build')
                (published / 'custom.json').write_text('preserve')

                story_catalog(catalog, 'After')
                stories.split_catalog(catalog, static, complete=True)
                (static / old_payload).write_bytes(old[old_payload])
                B.build_directory(source, output, False)
                current = stories.read_generation(static)
                self.assertEqual(stories.read_generation(published), current)
                self.assertEqual(stories.read_generation(published / stories.PREVIOUS), old)
                self.assertEqual((published / 'custom.json').read_text(), 'preserve')
                self.assertFalse((published / catalog.name).exists())
                payload = next(name for name in current if name != stories.INDEX)
                self.assertEqual({p.name for p in published.glob('background-story-*.json')}, {payload})

                write(output, 'data/export.json', {})
                archive = parent / 'common.zip'
                package_common(output, archive, rebuild=False)
                with ZipFile(archive) as package:
                    names = package.namelist()
                self.assertIn('static/' + payload, names)
                self.assertNotIn('static/' + old_payload, names)
                self.assertFalse(any(stories.PREVIOUS in name for name in names))

                (static / payload).write_bytes(b'{"id":"song","title":"Corrupt"}')
                with self.assertRaisesRegex(ValueError, 'Invalid background story payload'):
                    B.build_directory(source, output, False)
                self.assertEqual(stories.read_generation(published), current)
                self.assertEqual(stories.read_generation(published / stories.PREVIOUS), old)


class DirectoryTests(unittest.TestCase):
    def test_no_mcz_or_old_metadata_and_partial_install(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); fixture(root)
            instance=library.Library(root); instance.load()
            public=json.loads(instance.published_response()[0]); song=public['songs'][0]
            self.assertEqual(song['assets']['audio'], 'songs/v/only/bgm.wav')
            self.assertTrue(song['resourceOnly']); self.assertEqual(song['charts'], [])
            self.assertEqual(song['missing'], ['cover','charts/BSC'])
            self.assertEqual(len(instance.songs),1)
            # 部分安装：只列了版本索引，未安装的那个不报错、也不出现在索引里
            self.assertEqual(public['versionIndexes'], ['data/versions/v.json', 'data/versions/uninstalled.json'])

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
