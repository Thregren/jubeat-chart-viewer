#!/usr/bin/env python3
"""共享的流式 SHA-256 与「内容哈希文件名」判定。

哈希文件名在这套构建里决定三件事：打包时哪些是别名、GC 时哪些可以被回收、
站点自检时哪些算「索引里没提到的孤儿」。以前这套判定散在 site_gc /
package_site / verify_site / web_assets 四处，还各写了一遍正则，漏改一处就是
误删线上资源或者漏打包 —— 现在只有这里一份。

命名有两套（都满足「哈希是倒数第二个路径段的一部分」）：

* 前端资源：`static/sfx.js` + `.<hash>` + 原扩展名 → `static/sfx.js.<hash>.js`
  （`hash_frontend` 直接拼上原后缀）。还原用 `canonical_frontend()`。
* 版本索引：`data/versions/jubeat.json` → `data/versions/jubeat.<hash>.json`
  （`publish_catalog` 先去掉 `.json` 再加 `.<hash>.json`）。还原用
  `canonical_version_index()`。

两套的还原规则不同，所以不要试图用一个正则搞定：前者要连原扩展名一起吃掉，
后者只吃哈希那一段。
"""
from __future__ import annotations

import hashlib
import re
from pathlib import PurePosixPath

# 哈希是「倒数第二个」路径段的一部分：name.<20 位十六进制>.ext
HASHED_RE = re.compile(r"\.[a-f0-9]{20}(?=\.[^.]+$)")
# 前端别名：吃 `.<hash>` 与原扩展名（static/sfx.js.<hash>.js → static/sfx.js）
_FRONTEND_ALIAS_RE = re.compile(r"\.[a-f0-9]{20}\.[^.]+$")
# 版本索引别名：只吃 `.<hash>`（data/versions/x.<hash>.json → data/versions/x.json）
_VERSION_ALIAS_RE = re.compile(r"\.[a-f0-9]{20}(?=\.json$)")


def sha256_file(path) -> str:
    """按 1 MiB 分块读文件，返回 hexdigest（与原各处实现逐字节一致）。"""
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_hashed(rel) -> bool:
    """这个站点内相对路径是不是内容哈希产物（含 `_hashed` 目录）。"""
    text = str(rel)
    return "_hashed" in PurePosixPath(text).parts or bool(HASHED_RE.search(text))


def canonical_frontend(rel) -> str:
    """前端资源的别名 → 原文件名：`static/sfx.js.<hash>.js` → `static/sfx.js`。"""
    return _FRONTEND_ALIAS_RE.sub("", str(rel))


def canonical_version_index(rel) -> str:
    """版本索引的别名 → 原文件名：`data/versions/x.<hash>.json` → `data/versions/x.json`。"""
    return _VERSION_ALIAS_RE.sub("", str(rel))
