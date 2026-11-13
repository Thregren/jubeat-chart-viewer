#!/usr/bin/env python3
"""两条构建流水线共用的发布尾。

`build_directory.py`（原样直发）与 `compress_directory.py`（WAV → Opus 精简库）
在写完全部资源之后要做的事完全一样：版本索引别名 → marker 图集 → 前端文件名
哈希 → 分享页 → build.json。以前这段在两边各写一遍，改一处漏一处。

顺序不能变：`publish_catalog` 得先把 `data/library.json` 的版本索引替换成带哈希
的别名，`hash_frontend` 才会去重写 index.html 里的引用，最后分享页再按新入口生成。
"""
from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def app_version() -> str:
    return (REPO / 'VERSION').read_text(encoding='utf-8').strip()


def write_json(path: Path, value) -> None:
    """构建产物 JSON：缩进 2 便于 diff，原子写入且权限 0644。"""
    from media import write_atomic
    write_atomic(path, json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8'))


def publish_site(out: Path, songs: list, *, marker_manifest: dict | None = None,
                 version: str | None = None) -> None:
    """发布尾：版本别名、marker 图集、前端哈希、分享页。

    marker_manifest 为 None 表示这次不带 marker（`--no-markers`），此时跳过图集
    生成，但仍要保证 `data/markers.json` 存在（调用方负责写入空清单）。
    """
    from web_assets import publish_catalog, optimize_markers, hash_frontend

    publish_catalog(out)
    if marker_manifest is not None:
        optimize_markers(out, marker_manifest)
    hash_frontend(out)
    from build_share_pages import build_share_pages
    build_share_pages(out, out, version=version or app_version(), songs=songs)
