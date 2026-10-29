import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sync_cloudflare_realip import parse_ranges, render, sync


class CloudflareRanges(unittest.TestCase):
    def test_validates_family_and_renders_both_use_cases(self):
        v4 = parse_ranges([f"10.{i}.0.0/24" for i in range(5)], 4)
        v6 = parse_ranges([f"2001:db8:{i}::/48" for i in range(5)], 6)
        text = render(v4, v6)
        self.assertIn("real_ip_header CF-Connecting-IP;", text)
        self.assertEqual(text.count("10."), 10)
        self.assertEqual(text.count("2001:db8:"), 10)
        self.assertIn("allow 127.0.0.1;", text)
        self.assertTrue(text.endswith("deny all;\n"))
        with self.assertRaises(ValueError):
            parse_ranges(["2001:db8::/32"], 4)

    def test_atomic_refresh_from_offline_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "ips-v4").write_text("\n".join(f"10.{i}.0.0/24" for i in range(5)))
            (root / "ips-v6").write_text("\n".join(f"2001:db8:{i}::/48" for i in range(5)))
            conf = root / "realip.conf"
            result = sync(conf, root)
            self.assertEqual((result["v4"], result["v6"]), (5, 5))
            self.assertIn("deny all;", conf.read_text())


if __name__ == "__main__":
    unittest.main()
