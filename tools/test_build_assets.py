"""Source replacement and portable package regressions using tiny fixtures."""
import json
import io
from PIL import Image
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch
import site_builder as builder
from pack_zip import pack
from package_site import hashed_path, stage_portable
from build_php_package import stage as stage_php
from site_transaction import SiteTransaction
from smoke_test import make_fixture

REPO = Path(__file__).resolve().parent.parent

class BuildAssets(unittest.TestCase):
    def test_source_replaced_with_same_mtime_rebuilds_chart_and_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root/'song.mcz'; out = root/'site'
            song = {'id': 'song.mcz', 'audio': 'bgm.ogg', 'cover': 'cover.png', 'charts': [{'code': 'EXT', 'file': 'EXT.mc', 'level': '8'}]}
            cover = io.BytesIO(); Image.new('RGB', (32,32)).save(cover, 'PNG')
            def write(value):
                with zipfile.ZipFile(source, 'w') as zf:
                    zf.writestr('bgm.ogg', value)
                    zf.writestr('cover.png', cover.getvalue())
                    zf.writestr('EXT.mc', json.dumps({'note': [{'index': 0, 'beat': [0,0,1]}], 'value': value}))
            write('old'); original = source.stat()
            with patch.object(builder.config, 'LIBRARY', root), patch.object(builder, 'WANT_OPUS', False), patch.object(builder.audio_opus, 'encode', side_effect=lambda data, _: (data, 'cached')), patch.object(builder.audio_opus, 'profile', return_value='fixture'):
                builder.build_song(song, out, False, False, builder.Stats())
                stamp = (out/'media/audio/song.ogg').stat().st_mtime_ns
                builder.build_song(song, out, False, False, builder.Stats())
                self.assertEqual(stamp, (out/'media/audio/song.ogg').stat().st_mtime_ns)
                write('new'); os.utime(source, ns=(original.st_atime_ns, original.st_mtime_ns))
                builder.build_song(song, out, False, False, builder.Stats())
            self.assertEqual((out/'media/audio/song.ogg').read_text(), 'new')
            self.assertEqual(json.loads((out/'data/charts/song/EXT.json').read_text())['value'], 'new')

    def test_copied_marker_or_sound_detects_preserved_timestamp_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);src=root/'sound.wav';dest=root/'site/media/se/sound.wav'
            src.write_bytes(b'old'); stamp=src.stat()
            self.assertTrue(builder.copy_fresh(src,dest,False))
            self.assertFalse(builder.copy_fresh(src,dest,False))
            src.write_bytes(b'new');os.utime(src,ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
            self.assertTrue(builder.copy_fresh(src,dest,False))
            self.assertEqual(dest.read_bytes(),b'new')

    def test_history_keeps_current_and_expires_only_after_grace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); hashed = root/'media/audio/_hashed'; hashed.mkdir(parents=True)
            live, old = hashed/'live.ogg', hashed/'old.ogg'; live.write_bytes(b'l'); old.write_bytes(b'o')
            rel = live.relative_to(root).as_posix()
            with patch.object(builder.time, 'time', return_value=1000000):
                builder.retain_hashes(root, {rel}, 1)
            self.assertTrue(old.exists())
            with patch.object(builder.time, 'time', return_value=1086401):
                builder.retain_hashes(root, {rel}, 1)
            self.assertTrue(live.exists()); self.assertFalse(old.exists())

    def test_portable_package_has_one_payload_and_complete_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); env = os.environ | make_fixture(root/'fixture'); site = root/'site'
            result = subprocess.run([sys.executable, str(REPO/'tools/build_site.py'), '--out', str(site), '--jobs', '1'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            before = (site/'data/library.json').read_bytes()
            (site/'.htaccess').write_text('DirectoryIndex index.php')
            archive = root/'portable.zip'; pack(site, archive)
            unpack = root/'unpacked'
            with zipfile.ZipFile(archive) as zf:
                self.assertIn('.htaccess', zf.namelist())
                self.assertFalse(any(hashed_path(name) or name.startswith('.build-state/') for name in zf.namelist()))
                zf.extractall(unpack)
            self.assertEqual(before, (site/'data/library.json').read_bytes())
            stage_portable(site, root/'desktop-site')
            stage_php(site, root/'php-site')
            for staged in [root/'desktop-site',root/'php-site']:
                self.assertEqual((staged/'data/library.json').read_bytes(), (unpack/'data/library.json').read_bytes())
                self.assertFalse(any(hashed_path(p.relative_to(staged).as_posix()) for p in staged.rglob('*') if p.is_file()))
            self.assertTrue((root/'php-site/.htaccess').is_file())
            catalog = json.loads((unpack/'data/library.json').read_text())
            for song in catalog['songs']:
                for rel in song['assets'].values(): self.assertTrue((unpack/rel).is_file(), rel)
            result = subprocess.run([sys.executable, str(REPO/'tools/verify_site.py'), '--out', str(unpack), '--quiet', '--min-markers', '1'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payloads = [p for p in unpack.rglob('*.ogg') if p.is_file()]
            self.assertEqual(len(payloads), len(catalog['songs']))

    def test_archive_failure_preserves_previous_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); src=root/'src';src.mkdir();(src/'asset.txt').write_text('new')
            out=root/'archive.zip';out.write_bytes(b'previous complete archive')
            with patch('pack_zip._write', side_effect=OSError('disk full')):
                with self.assertRaises(OSError): pack(src,out)
            self.assertEqual(out.read_bytes(),b'previous complete archive')
            self.assertEqual(list(root.glob('archive.zip.tmp-*')),[])

    def test_pack_refuses_a_concurrent_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);site=root/'site';site.mkdir();(site/'index.html').write_text('old')
            out=root/'archive.zip';out.write_bytes(b'previous')
            with SiteTransaction(site):
                with self.assertRaisesRegex(RuntimeError, '正在构建'): pack(site,out)
                with self.assertRaises(RuntimeError): stage_portable(site,root/'portable')
            self.assertEqual(out.read_bytes(),b'previous')

if __name__ == '__main__': unittest.main()
