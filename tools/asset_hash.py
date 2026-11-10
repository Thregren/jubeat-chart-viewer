#!/usr/bin/env python3
"""共享的流式 SHA-256：所有打包器用它算整包 / 资源的校验和。"""
from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_file(path: Path | str) -> str:
    """按 1 MiB 分块读文件，返回 hexdigest（与原各处实现逐字节一致）。"""
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()
