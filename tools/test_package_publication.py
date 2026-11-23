import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

import package_publication
import pack_web_library
import package_directory


class PackagePublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.output = self.root / 'output'

    @staticmethod
    def fake_build(root, output, version, volume, verify):
        rows = []
        for name, content in [('library.zip', version.encode()), ('part1.zip', (version + '1').encode())]:
            (output / name).write_bytes(content)
            rows.append({'name': name, 'kind': 'web-volume', 'bytes': len(content),
                         'sha256': hashlib.sha256(content).hexdigest()})
        manifest = {'version': version, 'assets': rows}
        (output / 'packages.json').write_text(json.dumps(manifest))
        (output / 'SHA256SUMS').write_text(''.join(r['sha256'] + '  ' + r['name'] + '\n' for r in rows))
        return manifest

    def run_pack(self, version):
        with patch.object(pack_web_library, '_pack', side_effect=self.fake_build):
            return pack_web_library.pack(self.source, self.output, version)

    def assert_publication(self, version):
        manifest = json.loads((self.output / 'packages.json').read_text())
        self.assertEqual(manifest['version'], version)
        sums = ''.join(row['sha256'] + '  ' + row['name'] + '\n' for row in manifest['assets'])
        self.assertEqual((self.output / 'SHA256SUMS').read_text(), sums)
        for row in manifest['assets']:
            self.assertEqual(hashlib.sha256((self.output / row['name']).read_bytes()).hexdigest(), row['sha256'])

    def test_web_volumes_keep_share_pages_images_and_bundled_samples(self):
        static = self.source / 'static'
        static.mkdir()
        (static / 'background-stories-data.js').write_text('story build input')
        (self.source / 'index.html').write_text('<title>test</title>')
        data = self.source / 'data'
        data.mkdir()
        for name in ('library', 'markers'):
            (data / (name + '.json')).write_text('{}')
        share = self.source / 'share'
        (share / 'images').mkdir(parents=True)
        (share / 'a.html').write_text('song')
        (share / 'images/a.jpg').write_bytes(b'og image')
        (share / 'images/old.jpg').write_bytes(b'unreferenced image')
        (share / 'manifest.json').write_text(json.dumps({
            'songs': 1, 'pages': [{'page': 'share/a.html', 'image': 'share/images/a.jpg'}],
        }))
        sample = 'ub-v2-clap.wav'
        original = pack_web_library.REPO / 'jubeat_viewer/player/static' / sample
        (static / sample).write_bytes(original.read_bytes())
        with patch.object(pack_web_library, 'load_directory', return_value=({'songs': []}, set())):
            manifest = pack_web_library.pack(self.source, self.output, 'A', verify_crc=True)
            names = set()
            for row in manifest['assets']:
                with zipfile.ZipFile(self.output / row['name']) as archive:
                    if row['kind'] == 'web-volume':
                        names.update(archive.namelist())
                    else:
                        self.assertFalse(any(name.startswith('share/') for name in archive.namelist()))
            self.assertTrue({'share/manifest.json', 'share/a.html', 'share/images/a.jpg',
                             'static/' + sample}.issubset(names))
            self.assertNotIn('share/images/old.jpg', names)
            self.assertNotIn('static/background-stories-data.js', names)
            self.assertEqual(manifest['bundledSamples'], {
                'static/' + sample: hashlib.sha256(original.read_bytes()).hexdigest(),
            })
            (static / sample).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, '打击音与源码不符'):
                pack_web_library.pack(self.source, self.output, 'B')
            self.assert_publication('A')

    def test_old_generation_survives_failure_before_switch(self):
        self.run_pack('A')
        old = (self.output / '.web-packages.current').resolve()
        real_link = package_publication.atomic_link
        def fail_switch(target, link, directory=False):
            if link.name == '.web-packages.current':
                raise OSError('injected switch failure')
            return real_link(target, link, directory)
        with patch.object(package_publication, 'atomic_link', side_effect=fail_switch):
            with self.assertRaises(OSError):
                self.run_pack('B')
        self.assert_publication('A')
        self.assertEqual((self.output / '.web-packages.current').resolve(), old)
        self.run_pack('B')
        self.assert_publication('B')
        self.assertEqual(json.loads((old / 'packages.json').read_text())['version'], 'A')

    def test_migrates_existing_files_without_changing_paths(self):
        self.output.mkdir()
        self.fake_build(self.source, self.output, 'A', 1, False)
        self.run_pack('B')
        self.assert_publication('B')
        self.assertTrue((self.output / 'packages.json').is_symlink())
        releases = self.output / '.web-packages.releases'
        versions = {json.loads(p.read_text())['version'] for p in releases.glob('*/packages.json')}
        self.assertEqual(versions, {'A', 'B'})

    def test_interrupted_legacy_migration_is_repeatable(self):
        self.output.mkdir()
        self.fake_build(self.source, self.output, 'A', 1, False)
        original = package_publication.atomic_link
        count = 0
        def fail_after_one_link(target, link, directory=False):
            nonlocal count
            if link.name != '.web-packages.current':
                count += 1
                if count == 2:
                    raise OSError('injected migration failure')
            return original(target, link, directory)
        with patch.object(package_publication, 'atomic_link', side_effect=fail_after_one_link):
            with self.assertRaises(OSError):
                self.run_pack('B')
        self.assert_publication('A')
        self.run_pack('B')
        self.assert_publication('B')

    def test_new_manifest_omits_removed_volume(self):
        self.run_pack('A')
        def fewer(root, output, version, volume, verify):
            manifest = self.fake_build(root, output, version, volume, verify)
            (output / 'part1.zip').unlink()
            manifest['assets'].pop()
            (output / 'packages.json').write_text(json.dumps(manifest))
            (output / 'SHA256SUMS').write_text(''.join(
                r['sha256'] + '  ' + r['name'] + '\n' for r in manifest['assets']))
            return manifest
        with patch.object(pack_web_library, '_pack', side_effect=fewer):
            pack_web_library.pack(self.source, self.output, 'B')
        self.assert_publication('B')
        self.assertEqual(len(json.loads((self.output / 'packages.json').read_text())['assets']), 1)

    def test_killed_writer_before_switch_keeps_previous_generation(self):
        self.run_pack('A')
        script = '''
import os, sys
from pathlib import Path
sys.path.insert(0, 'tools')
import pack_web_library, package_publication
from test_package_publication import PackagePublicationTests
pack_web_library._pack = PackagePublicationTests.fake_build
original = package_publication.atomic_link
def interrupted(target, link, directory=False):
    if link.name == '.web-packages.current':
        os._exit(71)
    return original(target, link, directory)
package_publication.atomic_link = interrupted
pack_web_library.pack(Path(sys.argv[1]), Path(sys.argv[2]), 'B')
'''
        proc = subprocess.run([sys.executable, '-B', '-c', script, str(self.source), str(self.output)])
        self.assertEqual(proc.returncode, 71)
        self.assert_publication('A')
        self.run_pack('B')
        self.assert_publication('B')

    def test_killed_writer_during_each_stage_keeps_published_files(self):
        self.run_pack('A')
        script = """
import os, sys
from pathlib import Path
sys.path.insert(0, 'tools')
import pack_web_library
def interrupted(root, output, version, volume, verify):
    for n in range(3):
        (output / ('volume' + str(n))).write_bytes(b'data')
        if n == int(sys.argv[3]):
            os._exit(72)
pack_web_library._pack = interrupted
pack_web_library.pack(Path(sys.argv[1]), Path(sys.argv[2]), 'B')
"""
        for point in range(3):
            proc = subprocess.run([sys.executable, '-B', '-c', script, str(self.source),
                                   str(self.output), str(point)])
            self.assertEqual(proc.returncode, 72)
            self.assert_publication('A')
        self.run_pack('B')
        self.assert_publication('B')

    def test_concurrent_writers_are_rejected(self):
        with package_publication.publication_lock(self.output.parent, self.output.name):
            with self.assertRaises(RuntimeError):
                self.run_pack('A')

    def test_unsupported_symlinks_do_not_change_legacy_files(self):
        self.output.mkdir()
        self.fake_build(self.source, self.output, 'A', 1, False)
        with patch.object(Path, 'symlink_to', side_effect=OSError('not supported')):
            with self.assertRaisesRegex(RuntimeError, '符号链接'):
                self.run_pack('B')
        self.assert_publication('A')

    def test_real_zip_output_survives_failed_rebuild(self):
        (self.source / 'data').mkdir()
        (self.source / 'static').mkdir()
        (self.source / 'data/library.json').write_text('{}')
        (self.source / 'data/markers.json').write_text('{}')
        (self.source / 'static/app.js').write_text('old')
        (self.source / 'index.html').write_text('entry')
        with patch.object(pack_web_library, 'load_directory', return_value=({'songs': []}, set())):
            old = pack_web_library.pack(self.source, self.output, 'A', verify_crc=True)
            (self.source / 'static/app.js').write_text('new')
            original_write = zipfile.ZipFile.write
            def fail_write(archive, *args, **kwargs):
                if 'web-B.' in str(archive.filename):
                    raise OSError('injected write failure')
                return original_write(archive, *args, **kwargs)
            with patch.object(zipfile.ZipFile, 'write', fail_write):
                with self.assertRaises(OSError):
                    pack_web_library.pack(self.source, self.output, 'B', verify_crc=True)
            self.assertEqual(json.loads((self.output / 'packages.json').read_text()), old)
            for row in old['assets']:
                self.assertEqual(hashlib.sha256((self.output / row['name']).read_bytes()).hexdigest(), row['sha256'])
            new = pack_web_library.pack(self.source, self.output, 'B', verify_crc=True)
            self.assertEqual(json.loads((self.output / 'packages.json').read_text()), new)

    def test_common_package_and_report_switch_together(self):
        output = self.root / 'common.zip'
        def build(root, path, rebuild):
            path.write_bytes(root.read_bytes())
            report = {'bytes': path.stat().st_size,
                      'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            path.with_suffix('.zip.json').write_text(json.dumps(report))
            return report
        source = self.root / 'data'
        source.write_bytes(b'A')
        with patch.object(package_directory, '_package_common', side_effect=build):
            package_directory.package_common(source, output)
            source.write_bytes(b'B')
            real_link = package_publication.atomic_link
            def fail_switch(target, link, directory=False):
                if link.name == '.common.zip.current':
                    raise OSError('interrupted')
                return real_link(target, link, directory)
            with patch.object(package_publication, 'atomic_link', side_effect=fail_switch):
                with self.assertRaises(OSError):
                    package_directory.package_common(source, output)
            self.assertEqual(output.read_bytes(), b'A')
            report = json.loads(output.with_suffix('.zip.json').read_text())
            self.assertEqual(report['sha256'], hashlib.sha256(b'A').hexdigest())
            package_directory.package_common(source, output)
            self.assertEqual(output.read_bytes(), b'B')

    def test_common_package_abrupt_exit_leaves_old_pair(self):
        output = self.root / 'common.zip'
        source = self.root / 'data'
        source.write_bytes(b'A')
        def build(root, path, rebuild):
            path.write_bytes(root.read_bytes())
            report = {'bytes': path.stat().st_size,
                      'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            path.with_suffix('.zip.json').write_text(json.dumps(report))
            return report
        with patch.object(package_directory, '_package_common', side_effect=build):
            package_directory.package_common(source, output)
        script = """
import hashlib,json,os,sys
from pathlib import Path
sys.path.insert(0, 'tools')
import package_directory
def interrupted(root, path, rebuild):
    path.write_bytes(b'B')
    path.with_suffix('.zip.json').write_text(json.dumps({'bytes': 1, 'sha256': hashlib.sha256(b'B').hexdigest()}))
    os._exit(73)
package_directory._package_common = interrupted
package_directory.package_common(Path(sys.argv[1]), Path(sys.argv[2]))
"""
        proc = subprocess.run([sys.executable, '-B', '-c', script, str(source), str(output)])
        self.assertEqual(proc.returncode, 73)
        self.assertEqual(output.read_bytes(), b'A')
        report = json.loads(output.with_suffix('.zip.json').read_text())
        self.assertEqual(report['sha256'], hashlib.sha256(b'A').hexdigest())

    def test_common_legacy_pair_migration(self):
        output = self.root / 'common.zip'
        output.write_bytes(b'old')
        report_path = output.with_suffix('.zip.json')
        report_path.write_text(json.dumps({'bytes': 3, 'sha256': hashlib.sha256(b'old').hexdigest()}))
        source = self.root / 'data'
        source.write_bytes(b'new')
        def build(root, path, rebuild):
            path.write_bytes(root.read_bytes())
            report = {'bytes': path.stat().st_size,
                      'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            path.with_suffix('.zip.json').write_text(json.dumps(report))
            return report
        with patch.object(package_directory, '_package_common', side_effect=build):
            package_directory.package_common(source, output)
        self.assertEqual(output.read_bytes(), b'new')
        self.assertEqual(json.loads(report_path.read_text())['sha256'], hashlib.sha256(b'new').hexdigest())
        versions = {p.read_bytes() for p in (self.root / '.common.zip.releases').glob('*/common.zip')}
        self.assertEqual(versions, {b'old', b'new'})


if __name__ == '__main__':
    unittest.main()
