"""Concurrent cache writes retain complete files and stable single-flight locks."""
import concurrent.futures
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parent.parent / '铺面查看器/player/media.py'
spec = importlib.util.spec_from_file_location('viewer_media', path)
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)

class CacheConcurrency(unittest.TestCase):
    def test_lock_references_survive_key_pressure(self):
        first = media.lock_for('retained-before-acquire')
        for i in range(10000):
            media.lock_for(str(i))
        self.assertIs(media.lock_for('retained-before-acquire'), first)
        self.assertLessEqual(len({id(media.lock_for(str(i))) for i in range(10000)}), 256)

    def test_concurrent_atomic_writes_have_distinct_temporaries(self):
        with tempfile.TemporaryDirectory() as root:
            dest = Path(root) / 'cache.bin'
            barrier = threading.Barrier(2)
            replace = media.os.replace
            paths = []
            def concurrent_replace(src, target):
                paths.append(src)
                barrier.wait(timeout=5)
                replace(src, target)
            payloads = [b'A' * 10000, b'B' * 12000]
            with patch.object(media.os, 'replace', concurrent_replace):
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    list(pool.map(lambda data: media.write_atomic(dest, data), payloads))
            self.assertEqual(len(set(paths)), 2)
            self.assertIn(dest.read_bytes(), payloads)
            self.assertEqual(list(Path(root).glob('*.tmp*')), [])

    def test_failed_replace_cleans_temporary_and_preserves_destination(self):
        with tempfile.TemporaryDirectory() as root:
            dest = Path(root) / 'cache.bin'
            dest.write_bytes(b'old')
            with patch.object(media.os, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):
                    media.write_atomic(dest, b'new')
            self.assertEqual(dest.read_bytes(), b'old')
            self.assertEqual(list(Path(root).glob('*.tmp*')), [])

if __name__ == '__main__':
    unittest.main()
