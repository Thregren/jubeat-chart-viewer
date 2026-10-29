import struct
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy/visitors"))
from ip2region import HEADER_BYTES, VECTOR_BYTES, VECTOR_COLUMNS, Reader


class RegionReader(unittest.TestCase):
    def test_valid_header_and_empty_vector(self):
        start = HEADER_BYTES + VECTOR_COLUMNS * VECTOR_COLUMNS * VECTOR_BYTES
        data = bytearray(start + 15)
        struct.pack_into("<HHIIIHH", data, 0, 3, 0, 100, start, start + 1, 4, 4)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "ip2region.xdb"
            path.write_bytes(data)
            reader = Reader(path)
            self.assertEqual(reader.created_at, 100)
            self.assertEqual(reader.search("1.1.1.1"), "")

    def test_rejects_wrong_ip_family(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "ip2region.xdb"
            data = bytearray(HEADER_BYTES + VECTOR_COLUMNS * VECTOR_COLUMNS * VECTOR_BYTES + 15)
            struct.pack_into("<HHIIIHH", data, 0, 3, 0, 100, len(data)-15, len(data)-14, 4, 4)
            path.write_bytes(data)
            with self.assertRaises(ValueError):
                Reader(path).search("2001:db8::1")


if __name__ == "__main__":
    unittest.main()
