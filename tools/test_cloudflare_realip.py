import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sync_cloudflare_realip import parse_ranges, render_edge_map, render_realip, sync


class CloudflareRanges(unittest.TestCase):
    def test_validates_family_and_renders_both_use_cases(self):
        v4 = parse_ranges([f"10.{i}.0.0/24" for i in range(5)], 4)
        v6 = parse_ranges([f"2001:db8:{i}::/48" for i in range(5)], 6)
        realip = render_realip(v4, v6)
        edge = render_edge_map(v4, v6)
        self.assertIn("real_ip_header CF-Connecting-IP;", realip)
        self.assertEqual(realip.count("10."), 5)
        self.assertEqual(realip.count("2001:db8:"), 5)
        self.assertEqual(edge.count("10."), 5)
        self.assertEqual(edge.count("2001:db8:"), 5)
        self.assertIn("127.0.0.1/32 1;", edge)
        with self.assertRaises(ValueError):
            parse_ranges(["2001:db8::/32"], 4)

    def test_atomic_refresh_from_offline_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "ips-v4").write_text("\n".join(f"10.{i}.0.0/24" for i in range(5)))
            (root / "ips-v6").write_text("\n".join(f"2001:db8:{i}::/48" for i in range(5)))
            conf = root / "realip.conf"
            edge = root / "edge-map.conf"
            result = sync(conf, edge, root)
            self.assertEqual((result["v4"], result["v6"]), (5, 5))
            self.assertIn("real_ip_header", conf.read_text())
            self.assertIn("$jubeat_cloudflare_edge", edge.read_text())


if __name__ == "__main__":
    unittest.main()
