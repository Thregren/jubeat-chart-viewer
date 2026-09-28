#!/usr/bin/env python3
"""版本号的唯一来源（读仓库根目录的 VERSION 文件）。

以前版本号散在四处：前端 index.html 的 6 个 `?v=`、electron/package.json、
electron/package-lock.json、以及 README / release note 的正文。改一次要手动对一遍，
漏掉就是「浏览器捧着旧 app.js」或者「桌面包里版本号对不上」。

现在只有仓库根的 `VERSION` 是权威值，改版本走：

    python3 tools/set_version.py 0.6.2     # 一次改完所有地方
    python3 tools/set_version.py --check   # 校验是否一致（CI / 发版前跑）

服务端（Server 头、/api/health）与构建脚本都从这里读。
"""
from __future__ import annotations

import re
from pathlib import Path

PLAYER_DIR = Path(__file__).resolve().parent
REPO = PLAYER_DIR.parent.parent
VERSION_FILE = REPO / "VERSION"

# 允许 0.6.2 / 0.6.2-rc1 这种形式
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")

# 前端 index.html 里「静态资源引用上的 ?v=」。
# 必须锚在 src= / href= 上：index.html 顶部那段注释里也写着 "?v="，宽泛的正则
# 会把注释一路吃到最近的 <link 上（第一版就踩了这个坑）。
V_QUERY_RE = re.compile(r'((?:src|href)="static/[^"?]+)\?v=[^"&]+')
V_QUERY_FIND = re.compile(r'(?:src|href)="static/[^"?]+\?v=([^"&]+)"')


def html_versions(html: str) -> set[str]:
    """index.html 里出现的所有静态资源版本号（正常应当恰好一个值）。"""
    return set(V_QUERY_FIND.findall(html))


def read_version() -> str:
    """读 VERSION（去空白）。文件缺失或格式不对就报错，不猜。"""
    try:
        text = VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError as exc:  # pragma: no cover - 只在仓库被搬坏时发生
        raise RuntimeError(f"读不到版本文件 {VERSION_FILE}: {exc}") from exc
    if not SEMVER_RE.match(text):
        raise RuntimeError(f"{VERSION_FILE} 内容不像版本号: {text!r}")
    return text


if __name__ == "__main__":
    print(read_version())
