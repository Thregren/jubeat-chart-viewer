"""Source replacement and portable package regressions using tiny fixtures."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile
from package_site import hashed_path, stage_portable
from build_php_package import stage as stage_php
from site_transaction import SiteTransaction
from smoke_test import make_fixture
from pack_zip import pack

REPO = Path(__file__).resolve().parent.parent


class BuildAssets(unittest.TestCase):
    def test_library_archive_excludes_online_pages_and_local_helpers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);site=root/'site';(site/'data').mkdir(parents=True)
            (site/'data/library.json').write_text(json.dumps({'format':'jubeat-directory-v1','songs':[],'versionIndexes':[]}))
            for name in ['index.html','static/app.js','share/song.html','启动查看器.py','使用说明.txt']:
                path=site/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('not a library resource')
            result=subprocess.run([sys.executable,str(REPO/'tools/pack_android_res.py'),'--src',str(site),'--out',str(root/'out'),'--verify'],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            with zipfile.ZipFile(next((root/'out').glob('*.zip'))) as archive:
                self.assertEqual(archive.namelist(),['data/library.json'])

    def test_portable_package_has_one_payload_and_complete_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); env = os.environ | make_fixture(root/'fixture'); site = root/'site'
            result = subprocess.run([sys.executable, str(REPO/'tools/build_site.py'),
                                     '--library', env['JUBEAT_LIBRARY'], '--out', str(site)],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            before = (site/'data/library.json').read_bytes()
            (site/'.htaccess').write_text('DirectoryIndex index.php')
            archive = root/'portable.zip'; pack(site, archive)
            unpack = root/'unpacked'
            with zipfile.ZipFile(archive) as zf:
                self.assertIn('.htaccess', zf.namelist())
                self.assertFalse(any((hashed_path(name) and not name.startswith('markers/')) or name.startswith('.build-state/') for name in zf.namelist()))
                zf.extractall(unpack)
            self.assertEqual(before, (site/'data/library.json').read_bytes())
            stage_portable(site, root/'desktop-site')
            stage_php(site, root/'php-site')
            for staged in [root/'desktop-site',root/'php-site']:
                self.assertEqual((staged/'data/library.json').read_bytes(), (unpack/'data/library.json').read_bytes())
                self.assertFalse(any((hashed_path(p.relative_to(staged).as_posix()) and 'markers' not in p.relative_to(staged).parts) for p in staged.rglob('*') if p.is_file()))
            marker_data=json.loads((unpack/'data/markers.json').read_text())
            for design in marker_data['designs']:
                for atlas in design.get('atlases',{}).values():self.assertTrue((unpack/'markers'/atlas['file']).is_file())
            self.assertTrue((root/'php-site/.htaccess').is_file())
            catalog = json.loads((unpack/'data/library.json').read_text())
            for song in catalog['songs']:
                for rel in song['assets'].values(): self.assertTrue((unpack/rel).is_file(), rel)
            result = subprocess.run([sys.executable, str(REPO/'tools/verify_site.py'), '--out', str(unpack), '--quiet', '--min-markers', '1'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payloads = [p for p in unpack.rglob('*.wav') if p.is_file()]
            audios = [rel for song in catalog['songs'] for rel in (song.get('assets') or {}).values() if rel.endswith('.wav')]
            self.assertEqual(len(payloads), len(audios))

    def test_archive_failure_preserves_previous_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); src=root/'src';src.mkdir();(src/'asset.txt').write_text('new')
            out=root/'archive.zip';out.write_bytes(b'previous complete archive')
            with mock.patch('pack_zip._write', side_effect=OSError('disk full')):
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
