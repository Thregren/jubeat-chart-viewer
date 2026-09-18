#!/usr/bin/env python3
"""把目录打成 zip —— 关键是**非 ASCII 文件名要带 UTF-8 标记**。

用 `zip` 命令行打出来的包，中文 / 日文文件名默认不带 UTF-8 标记
（general purpose flag 0x800），Linux 上解压会变成乱码文件名，
结果就是谱面、封面、音源全部 404。Python 的 zipfile 对非 ASCII 名字
会自动置这个标记，所以统一走这里。

另外：已经压过的媒体（png/jpg/ogg…）用 STORED 直接塞进去（省 CPU，也压不动），
文本类（json/html/js/css…）用 DEFLATE。
"""
from __future__ import annotations

import argparse
import sys
import time
import zipfile
from pathlib import Path

# 已经压缩过的格式：直接存
STORED_EXT = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".bmp",
    ".ogg", ".oga", ".mp3", ".m4a", ".aac", ".flac", ".wav",
    ".woff", ".woff2", ".ttf", ".otf", ".zip", ".gz", ".7z",
}


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{int(n)} B" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def _write(zf: zipfile.ZipFile, path: Path, arcname: str) -> None:
    info = zipfile.ZipInfo.from_file(path, arcname)      # 保留权限位（.sh 的可执行位）
    info.compress_type = (
        zipfile.ZIP_STORED if path.suffix.lower() in STORED_EXT else zipfile.ZIP_DEFLATED
    )
    with open(path, "rb") as src, zf.open(info, "w") as dst:
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            dst.write(chunk)


def pack(
    src: Path,
    out: Path,
    prefix: str = "",
    excludes: tuple[str, ...] = (),
    extra: tuple[tuple[Path, str], ...] = (),
) -> tuple[int, int]:
    """把 src 打进 out；prefix 是包内前缀（"" = 文件直接落在 zip 根）。"""
    if out.exists():
        out.unlink()
    files = 0
    total = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(src.rglob("*")):
            if path.is_dir():
                continue
            rel = path.relative_to(src).as_posix()
            if any(rel == e or rel.startswith(e.rstrip("/") + "/") for e in excludes):
                continue
            if path.name == ".DS_Store" or path.name.startswith("._"):
                continue
            _write(zf, path, prefix + rel)
            files += 1
            total += path.stat().st_size
        for src_file, arcname in extra:
            _write(zf, src_file, arcname)
            files += 1
    return files, total


def main() -> int:
    ap = argparse.ArgumentParser(description="打 zip（UTF-8 文件名安全）")
    ap.add_argument("src", help="要打包的目录")
    ap.add_argument("out", help="输出 zip 路径")
    ap.add_argument("--prefix", default="", help="包内前缀目录（结尾带 /），默认无")
    ap.add_argument("--exclude", action="append", default=[], help="排除的相对路径/目录（可多次）")
    ap.add_argument("--extra", action="append", default=[], help="额外塞进去的文件：源路径:包内路径")
    args = ap.parse_args()

    src = Path(args.src).resolve()
    if not src.is_dir():
        sys.exit(f"不是目录：{src}")
    extra: list[tuple[Path, str]] = []
    for spec in args.extra:
        src_file, _, arcname = spec.partition(":")
        extra.append((Path(src_file), arcname or Path(src_file).name))

    t0 = time.time()
    files, total = pack(src, Path(args.out), args.prefix, tuple(args.exclude), tuple(extra))
    out = Path(args.out)
    print(f"✓ {out}  ·  {files} 个文件  ·  原始 {human(total)}  →  压缩后 {human(out.stat().st_size)}"
          f"  ·  {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
