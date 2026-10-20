#!/usr/bin/env python3
"""打安卓「曲库资源包」—— 供 App 内「导入资源包」或手工解压用。

包里只装**曲库**（`media/`、`markers/`、`data/`），路径就是站点根开始的相对
路径；前端（`index.html`、`static/`）不装 —— App 每次启动都会从 APK 自己的
assets 里重铺一遍，装了也是被覆盖，纯属浪费体积。

压缩走 `tools/pack_zip.py`：非 ASCII 文件名带 UTF-8 标记、已压过的媒体用
STORED 直接塞。这两点缺一个，安卓上解出来就是一堆乱码名 404。

    python3 tools/pack_android_res.py              # 打到 android/out/dist/
    python3 tools/pack_android_res.py --out /tmp   # 换个输出目录
    python3 tools/pack_android_res.py --verify     # 打完把整包 CRC 校一遍（慢，读全量）

体积约 2.9 GB，超过 GitHub Release 的单文件上限（2 GB），别往 Release 传。
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import time
import zipfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
sys.path.insert(0, str(TOOLS))

from pack_zip import human, pack  # noqa: E402

# 客户端自带前端；歌曲分享页面只供线上访问，不属于可导入的曲库资源。
EXCLUDES = ("index.html", "static", "share", "robots.txt")


def version() -> str:
    v = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    if not v:
        sys.exit("仓库根的 VERSION 是空的")
    return v


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="打安卓曲库资源包")
    ap.add_argument("--src", default=str(REPO / "site"), help="站点目录（默认 site/）")
    ap.add_argument("--out", default=str(REPO / "android" / "out" / "dist"), help="输出目录")
    ap.add_argument("--verify", action="store_true", help="打完做一次全量 CRC 校验")
    args = ap.parse_args()

    src = Path(args.src).resolve()
    if not (src / "data" / "library.json").is_file():
        sys.exit(f"不像是站点目录（缺 data/library.json）：{src}")

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"jubeat-library-{version()}.zip"

    t0 = time.time()
    # A library folder may also contain launch scripts, previews or local guides.
    # Importers accept only these four resource trees, never the website itself.
    resource_roots = {"data", "media", "songs", "markers"}
    excludes = tuple(p.name for p in src.iterdir() if p.name not in resource_roots)
    files, raw = pack(src, out, "", excludes)
    size = out.stat().st_size
    print(f"✓ {out}")
    print(f"  {files} 个文件  ·  原始 {human(raw)}  →  压缩后 {human(size)}  ·  {time.time() - t0:.1f}s")
    print(f"  sha256 {sha256_of(out)}")

    # 归档里没有任何一条需要 ZIP64 才能表示（单个条目、单个偏移都没过 4 GB 线）
    over = [n for n in _entries_over_4g(out)]
    if over:
        print(f"  ! 这些条目超过 4 GB，安卓端可能解不了：{over[:5]}")

    if args.verify:
        t1 = time.time()
        print("▸ 校验中（读全量，慢）…")
        with zipfile.ZipFile(out) as zf:
            bad = zf.testzip()
        if bad:
            sys.exit(f"✗ CRC 校验失败：{bad}")
        print(f"✓ CRC 全部通过（{files} 条）· {time.time() - t1:.1f}s")
    return 0


def _entries_over_4g(path: Path):
    limit = (1 << 32) - 1
    with zipfile.ZipFile(path) as zf:
        for i in zf.infolist():
            if i.file_size > limit or i.compress_size > limit:
                yield i.filename


if __name__ == "__main__":
    raise SystemExit(main())
