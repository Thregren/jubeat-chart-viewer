"""Regression tests for failed builds and publication rollback."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parent))
from site_transaction import SiteTransaction

class BuildTransactions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name) / "site"
        self.root.mkdir(); (self.root / "index.html").write_text("old entry")
        (self.root / "asset.js").write_text("old asset")
    def tearDown(self): self.temp.cleanup()
    def test_failed_build_preserves_all_published_files(self):
        with self.assertRaises(RuntimeError):
            with SiteTransaction(self.root) as build:
                p = build.stage / "index.html"; p.unlink(); p.write_text("incomplete")
                raise RuntimeError("encoding failed")
        self.assertEqual((self.root / "index.html").read_text(), "old entry")
        self.assertEqual((self.root / "asset.js").read_text(), "old asset")
    def test_failed_publication_rolls_back_assets_and_entry(self):
        with SiteTransaction(self.root) as build:
            for name in ("asset.js", "index.html"):
                p = build.stage / name; p.unlink(); p.write_text("new")
            original = os.replace; count = 0
            def replace(src, dst):
                nonlocal count
                count += 1
                if count == 2: raise OSError("disk error during publication")
                return original(src, dst)
            with patch("site_transaction.os.replace", replace):
                with self.assertRaises(OSError): build.publish()
        self.assertEqual((self.root / "asset.js").read_text(), "old asset")
        self.assertEqual((self.root / "index.html").read_text(), "old entry")
    def test_concurrent_builder_cannot_publish_same_directory(self):
        with SiteTransaction(self.root):
            with self.assertRaises(RuntimeError):
                with SiteTransaction(self.root): pass

if __name__ == "__main__": unittest.main()
