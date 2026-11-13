"""Cheap file identity shared by indexing, media caching and static builds."""
from __future__ import annotations

import hashlib
from pathlib import Path


def source_revision(path: Path) -> str:
    """Invalidate on replacement or edits, even when an old mtime is restored.

    This is an identity for local cache validation, not a content checksum.
    ctime detects in-place writes; device/inode detect atomic replacements.
    """
    stat = Path(path).stat()
    identity = (stat.st_dev, stat.st_ino, stat.st_size,
                stat.st_mtime_ns, stat.st_ctime_ns)
    return hashlib.sha256(":".join(map(str, identity)).encode("ascii")).hexdigest()
