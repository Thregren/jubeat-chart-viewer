#!/usr/bin/env python3
"""把 site/ 打成一个「PHP 环境解压即用」的整包（含曲库）。

用法：
    python3 tools/build_php_package.py                 # 产出 dist-php/jubeat-site-php.zip
    python3 tools/build_php_package.py --no-zip        # 只准备目录，不压缩
    python3 tools/build_php_package.py --site site --out dist-php

包里 = site/ 的全部内容 + deploy/php/ 里的入口文件（index.php、.htaccess、README 等）。
体量大约 2.9 GB（音频已经是 Ogg，压不动），所以用硬链接铺目录，再压一份 zip。
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pack_zip import pack  # noqa: E402  （同目录下的打包工具，保证文件名 UTF-8 安全）

ROOT = Path(__file__).resolve().parent.parent
PHP_FILES = ["index.php", ".htaccess", "nginx-php.conf.example", "start.sh", "README.txt"]


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{int(n)} B" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def stage(site: Path, pkg: Path) -> tuple[int, int]:
    """把 site/ 铺到 pkg/（同盘用硬链接，省一份 2.9 GB 的拷贝）。"""
    if pkg.exists():
        shutil.rmtree(pkg)
    pkg.mkdir(parents=True)
    files = links = 0
    for src in sorted(site.rglob("*")):
        rel = src.relative_to(site)
        if src.is_dir():
            (pkg / rel).mkdir(parents=True, exist_ok=True)
            continue
        dst = pkg / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(src, dst)          # 硬链接：不占额外空间
            links += 1
        except OSError:
            shutil.copy2(src, dst)     # 跨盘 / 不支持硬链接时退化成拷贝
        files += 1
    for name in PHP_FILES:
        src = ROOT / "deploy" / "php" / name
        if not src.exists():
            sys.exit(f"缺少 deploy/php/{name}")
        shutil.copy2(src, pkg / name)
        if name.endswith(".sh"):
            os.chmod(pkg / name, 0o755)      # 解压出来就能直接 ./start.sh
    return files, links


def make_zip(pkg: Path, out_zip: Path) -> None:
    # 用 tools/pack_zip.py 打包：非 ASCII（日文曲名）文件名会带 UTF-8 标记，
    # 用 zip(1) 打出来的包在 Linux 上解压会变乱码，曲目路径一乱就全 404
    pack(pkg, out_zip, prefix=pkg.name + "/")


def main() -> int:
    ap = argparse.ArgumentParser(description="构建 PHP 版整包（含曲库）")
    ap.add_argument("--site", default=str(ROOT / "site"), help="静态站点目录（默认 site/）")
    ap.add_argument("--out", default=str(ROOT / "dist-php"), help="输出目录（默认 dist-php/）")
    ap.add_argument("--name", default="jubeat-site-php", help="包内顶层目录名")
    ap.add_argument("--no-zip", action="store_true", help="只准备目录，不压缩")
    args = ap.parse_args()

    site = Path(args.site).resolve()
    if not (site / "index.html").is_file():
        sys.exit(f"{site} 里没有 index.html：先跑 python3 tools/build_site.py --out site")

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    pkg = out / args.name

    t0 = time.time()
    files, links = stage(site, pkg)
    size = sum(p.stat().st_size for p in pkg.rglob("*") if p.is_file())
    print(f"✓ 铺好目录 {pkg}")
    print(f"  文件 {files} 个（硬链接 {links} 个）· 合计 {human(size)} · 用时 {time.time() - t0:.1f}s")

    if not args.no_zip:
        t1 = time.time()
        zip_path = out / f"{args.name}.zip"
        make_zip(pkg, zip_path)
        print(f"✓ 打包完成 {zip_path}（{human(zip_path.stat().st_size)}）· 用时 {time.time() - t1:.1f}s")
        print("  上传到宝塔站点根目录后「解压」即可，详见包内 README.txt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
