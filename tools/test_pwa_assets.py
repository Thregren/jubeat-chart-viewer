"""Check PWA references against a real fixture build, including hashed manifest URLs."""
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urljoin, urlsplit
from smoke_test import make_fixture

REPO = Path(__file__).resolve().parent.parent

class PwaAssets(unittest.TestCase):
    def test_built_manifest_resolves_icons_at_advertised_sizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = os.environ | make_fixture(root / 'fixture')
            out = root / 'site'
            result = subprocess.run([sys.executable, str(REPO/'tools/build_site.py'), '--out', str(out), '--jobs', '1'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            html = (out/'index.html').read_text()
            manifest_ref = re.search(r'rel="manifest" href="([^"]+)"', html).group(1)
            self.assertIn('.json.', manifest_ref)  # Build addresses manifest by its content hash.
            manifest = json.loads((out/urlsplit(manifest_ref).path).read_text())
            base = 'https://fixture.test/' + manifest_ref
            self.assertEqual(urljoin(base, manifest['start_url']), 'https://fixture.test/')
            self.assertEqual(urljoin(base, manifest['scope']), 'https://fixture.test/')
            self.assertEqual(manifest['display'], 'standalone')
            self.assertEqual({icon['sizes'] for icon in manifest['icons']}, {'192x192','512x512'})
            for icon in manifest['icons']:
                url = urlsplit(urljoin(base, icon['src']))
                self.assertEqual(url.netloc, 'fixture.test')
                data = (out/url.path.lstrip('/')).read_bytes()
                self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
                width, height = struct.unpack('>II', data[16:24])
                self.assertEqual(icon['sizes'], f'{width}x{height}')
                self.assertEqual(icon['type'], 'image/png')
            apple = re.search(r'rel="apple-touch-icon"[^>]+href="([^"]+)"', html).group(1)
            self.assertTrue((out/urlsplit(apple).path).is_file())

if __name__ == '__main__':
    unittest.main()
