import hashlib
import json
import argparse
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cos_activation
import deploy_cos


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.target, self.stage = root / 'site', root / '.stage'
        self.state, self.conf = root / '.stage.state.json', root / 'site.conf'
        self.target.mkdir()
        (self.target / 'old').write_text('old')
        self.conf.write_text('    location /media/ {\n    }\n')
        self.assertEqual(cos_activation.prepare(self.stage, self.state, 'hash'), 'staged')
        (self.stage / 'new').write_text('new')
        self.commands = []
        self.runner = lambda cmd, **kw: self.commands.append(cmd)
        self.fetch = lambda *args, **kwargs: b'{"format":"jubeat-directory-v1"}'

    def activate(self):
        return cos_activation.activate(self.target, self.stage, self.state, 'hash',
                                       '1', self.conf, self.runner, self.fetch)

    def test_cleanup_failure_and_lost_response_resume(self):
        with patch.object(cos_activation.shutil, 'rmtree', side_effect=OSError('injected')):
            with self.assertRaises(OSError):
                self.activate()
        self.assertEqual(json.loads(self.state.read_text())['phase'], 'activated')
        self.assertTrue((self.target / 'new').exists())
        self.assertEqual(self.activate(), 'complete')
        self.assertEqual(self.activate(), 'complete')
        self.assertEqual(cos_activation.prepare(self.stage, self.state, 'hash'), 'complete')

    def test_interrupted_between_renames(self):
        original = Path.rename
        def rename(path, target):
            if path == self.stage:
                raise OSError('lost process')
            return original(path, target)
        with patch.object(Path, 'rename', rename):
            with self.assertRaises(OSError):
                self.activate()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.activate(), 'complete')
        self.assertTrue((self.target / 'new').exists())

    def test_interrupted_before_first_rename(self):
        original = Path.rename
        def rename(path, target):
            if path == self.target:
                raise OSError('lost process')
            return original(path, target)
        with patch.object(Path, 'rename', rename):
            with self.assertRaises(OSError):
                self.activate()
        self.assertTrue((self.target / 'old').exists())
        self.assertEqual(self.activate(), 'complete')

    def test_missing_stage_after_state_creation_recovers(self):
        stage = self.target.parent / 'fresh-stage'
        state = self.target.parent / 'fresh-state'
        state.write_text(json.dumps({'fingerprint': 'hash', 'phase': 'staged'}))
        self.assertEqual(cos_activation.prepare(stage, state, 'hash'), 'staged')
        self.assertTrue(stage.is_dir())

    def test_health_failure_restores_previous_site(self):
        self.fetch = lambda *args, **kwargs: b'{"format":"wrong"}'
        with self.assertRaises(RuntimeError):
            self.activate()
        self.assertTrue((self.target / 'old').exists())
        self.assertEqual(json.loads(self.state.read_text())['phase'], 'staged')
        self.fetch = lambda *args, **kwargs: b'{"format":"jubeat-directory-v1"}'
        self.assertEqual(self.activate(), 'complete')

    def test_unowned_retired_directory_is_preserved(self):
        old = self.target.with_name('.site-retired-1')
        old.mkdir()
        (old / 'keep').write_text('keep')
        with self.assertRaises(RuntimeError):
            self.activate()
        self.assertTrue((old / 'keep').exists())

    def test_stage_validation_checks_sample_digest_and_share_references(self):
        root = self.target.parent
        target = root / 'www' / 'wwwroot' / 'example'
        packages = root / 'packages'
        packages.mkdir()
        stage = target.parent / '.example-unified-1'
        for directory in ('data', 'static', 'share/images'):
            (stage / directory).mkdir(parents=True)
        (stage / 'index.html').write_text('<title>test</title>')
        (stage / 'data/library.json').write_text(json.dumps({
            'format': 'jubeat-directory-v1', 'songs': [], 'versionIndexes': [],
        }))
        sample = 'static/test.wav'
        (stage / sample).write_bytes(b'bundled bytes')
        (stage / 'share/a.html').write_text('song')
        (stage / 'share/images/a.jpg').write_bytes(b'image')
        (stage / 'share/manifest.json').write_text(json.dumps({
            'songs': 1, 'pages': [{'page': 'share/a.html', 'image': 'share/images/a.jpg'}],
        }))
        (packages / 'packages.json').write_text(json.dumps({
            'version': '1', 'assets': [], 'songs': 0, 'charts': 0, 'shareManifest': True,
            'bundledSamples': {sample: hashlib.sha256(b'bundled bytes').hexdigest()},
        }))
        args = argparse.Namespace(packages=str(packages), report=str(root / 'report'),
                                  bucket='bucket', region='region', instance='instance',
                                  instance_region='region', target=str(target),
                                  prefix='prefix', mode='activate', activate=False)

        def run_locally(_instance, _region, script):
            if "print(prepare(" in script:
                return "staged"
            return subprocess.check_output(['sh'], input=script, text=True, stderr=subprocess.PIPE)

        with patch.object(deploy_cos, 'tat', side_effect=run_locally):
            self.assertEqual(deploy_cos.deploy(args)['validation'], 'validated 0 0')
            for path in ('songs/extra.WAV', 'share/images/a.jpg', sample):
                with self.subTest(path=path):
                    file = stage / path
                    file.parent.mkdir(exist_ok=True)
                    if path == 'share/images/a.jpg':
                        file.unlink()
                    else:
                        file.write_bytes(b'unexpected')
                    with self.assertRaises(subprocess.CalledProcessError):
                        deploy_cos.deploy(args)
                    file.unlink(missing_ok=True)
                    (stage / sample).write_bytes(b'bundled bytes')
                    (stage / 'share/images/a.jpg').write_bytes(b'image')

    def test_deployer_resumes_remote_cutover_without_staged_volumes(self):
        root = self.target.parent
        packages = root / 'packages'
        packages.mkdir()
        (packages / 'packages.json').write_text(json.dumps({
            'version': '1',
            'assets': [{'kind': 'web-volume', 'name': 'missing.zip',
                        'bytes': 10, 'sha256': 'a' * 64}],
        }))
        args = argparse.Namespace(packages=str(packages), report=str(root / 'report'),
                                  bucket='bucket', region='region', instance='instance',
                                  instance_region='region', target='/www/wwwroot/example',
                                  prefix='prefix', mode='activate', activate=True)
        with patch.object(deploy_cos, 'tat', side_effect=['activated', 'complete']) as tat:
            state = deploy_cos.deploy(args)
        self.assertEqual(state['status'], 'complete')
        self.assertEqual(tat.call_count, 2)


if __name__ == '__main__':
    unittest.main()
