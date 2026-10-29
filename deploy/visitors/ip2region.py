# Copyright 2022 The Ip2Region Authors. All rights reserved.
# Use of this source code is governed by an Apache-2.0-style license.
"""Minimal IPv4 xdb reader vendored for private visitor aggregation."""
from __future__ import annotations

import ipaddress
import struct

HEADER_BYTES = 256
VECTOR_COLUMNS = 256
VECTOR_BYTES = 8
INDEX_BYTES = 14


class Reader:
    def __init__(self, path):
        with open(path, "rb") as stream:
            self.data = stream.read()
        if len(self.data) < HEADER_BYTES + VECTOR_COLUMNS * VECTOR_COLUMNS * VECTOR_BYTES:
            raise ValueError("IP2region database is too small")
        version, _policy, self.created_at, self.start_index, self.end_index, ip_version, pointer_bytes = struct.unpack_from("<HHIIIHH", self.data, 0)
        if version != 3 or ip_version != 4 or pointer_bytes != 4:
            raise ValueError("Unsupported IP2region database format")
        if not (HEADER_BYTES <= self.start_index < self.end_index <= len(self.data)):
            raise ValueError("Invalid IP2region index bounds")

    def _compare(self, packed, offset):
        # The xdb IPv4 segment stores address bytes in reverse order.
        return (packed > self.data[offset:offset + 4][::-1]) - (packed < self.data[offset:offset + 4][::-1])

    def search(self, address):
        packed = ipaddress.IPv4Address(address).packed
        vector = HEADER_BYTES + (packed[0] * VECTOR_COLUMNS + packed[1]) * VECTOR_BYTES
        start, end = struct.unpack_from("<II", self.data, vector)
        if not start or not end or end < start or end + INDEX_BYTES > len(self.data):
            return ""
        low, high = 0, (end - start) // INDEX_BYTES
        while low <= high:
            middle = (low + high) // 2
            offset = start + middle * INDEX_BYTES
            if self._compare(packed, offset) < 0:
                high = middle - 1
            elif self._compare(packed, offset + 4) > 0:
                low = middle + 1
            else:
                length, data_offset = struct.unpack_from("<HI", self.data, offset + 8)
                if not length or data_offset + length > len(self.data):
                    return ""
                return self.data[data_offset:data_offset + length].decode("utf-8", "replace")
        return ""
