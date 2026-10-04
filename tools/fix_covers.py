#!/usr/bin/env python3
"""把曲库里「苹果变体 PNG」封面就地转成标准 PNG。

背景
----
曲库（`music/*/*.mcz`）里有一部分封面是 iOS 工具链产出的 PNG：

  1. CgBI 变体：签名后多一个 `CgBI` 私有块，IDAT 是**裸 deflate**（没有 zlib 头），
     像素按 BGRA 存放且做了预乘。Safari / macOS 能显示，Chrome / Firefox 显示裂图。
  2. 裸 deflate 变体：`CgBI` 块被剥掉了，但 IDAT 依然是裸 deflate + BGRA。
  3. 前缀变体：签名后多插了 4 字节文件长度，之后才是正常的 PNG 块。

这三种都转成标准 PNG（zlib 头 + RGBA 非预乘），转换是无损的：
原图什么样，转出来就什么样，只是换了个能被所有浏览器解开的容器。

用法
----
    python3 tools/fix_covers.py [--dry-run] [--verify] [--only PATH ...] [--json OUT]

约定
----
* 只改封面成员，其它成员原样复制；先写临时文件再原子替换，中途失败不会破坏原档。
* 已经是标准 PNG 的封面原样保留（连字节都不动）。
* `--verify` 会重新解一遍改完的档，确认每个封面都能解码。
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import zipfile
import zlib
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parent
MUSIC = REPO / "music"

_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _rel(path: Path, base: Path) -> str:
    """尽量给出相对路径，方便报告里读。"""
    try:
        return str(path.relative_to(base.parent))
    except ValueError:
        return str(path)
# PNG 规范里 IHDR 必须是第一个块
_IHDR_LEN = b"\x00\x00\x00\x0d"


class CoverError(ValueError):
    """封面不是能识别的 PNG（或用了不支持的特性）。"""


def _is_type(t: bytes) -> bool:
    return len(t) == 4 and all(65 <= c <= 90 or 97 <= c <= 122 for c in t)


def _strip_prefix(data: bytes) -> bytes:
    """去掉「签名后多插 4 字节」的前缀变体。"""
    if not data.startswith(_PNG_SIG):
        raise CoverError("不是 PNG")
    if _is_type(data[12:16]):
        return data
    if _is_type(data[16:20]):
        return data[:8] + data[12:]
    raise CoverError("PNG 块表异常")


def _chunks(data: bytes):
    i = 8
    end = len(data)
    while i + 8 <= end:
        ln = struct.unpack(">I", data[i : i + 4])[0]
        typ = data[i + 4 : i + 8]
        body = data[i + 8 : i + 8 + ln]
        if len(body) != ln:
            raise CoverError("块长度越界")
        yield typ, body
        i += 12 + ln


def is_standard_png(data: bytes) -> bool:
    """标准 PNG：第一个块必须是 IHDR，且没有 CgBI。"""
    if not data.startswith(_PNG_SIG):
        return False
    if data[8:12] != _IHDR_LEN or data[12:16] != b"IHDR":
        return False
    try:
        for typ, _ in _chunks(data):
            if typ == b"CgBI":
                return False
    except CoverError:
        return False
    return True


def _unfilter(raw: bytes, w: int, h: int, bpp: int, stride: int) -> bytearray:
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        if pos >= len(raw):
            raise CoverError("像素数据不完整")
        ft = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        if len(line) != stride:
            raise CoverError("扫描行不完整")
        pos += stride
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ft != 0:
            raise CoverError(f"未知行过滤器 {ft}")
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return out


def _encode_png(w: int, h: int, ct: int, bd: int, pixels: bytes) -> bytes:
    stride = len(pixels) // h if h else 0
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += pixels[y * stride : (y + 1) * stride]

    def chunk(t: bytes, b: bytes) -> bytes:
        return (
            struct.pack(">I", len(b))
            + t
            + b
            + struct.pack(">I", zlib.crc32(t + b) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, bd, ct, 0, 0, 0)
    return (
        _PNG_SIG
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def decode_to_pixels(data: bytes) -> tuple[int, int, int, int, bytearray, str]:
    """解出 (宽, 高, 颜色类型, 位深, RGBA/RGB 像素, 备注)。"""
    data = _strip_prefix(data)
    w = h = ct = bd = None
    idat = bytearray()
    note = []
    for typ, body in _chunks(data):
        if typ == b"IHDR":
            w, h, bd, ct, _comp, _filt, inter = struct.unpack(">IIBBBBB", body)
            if inter:
                raise CoverError("不支持隔行扫描")
        elif typ == b"IDAT":
            idat += body
        elif typ == b"CgBI":
            note.append("cgbi")
    if w is None:
        raise CoverError("没有 IHDR")
    if bd != 8 or ct not in (6, 2):
        raise CoverError(f"不支持的位深/颜色类型 bd={bd} ct={ct}")
    try:
        raw = zlib.decompress(bytes(idat))
    except zlib.error:
        raw = zlib.decompress(bytes(idat), -15)
        note.append("raw-deflate")
    bpp = 4 if ct == 6 else 3
    stride = w * bpp
    px = _unfilter(raw, w, h, bpp, stride)
    if ct == 6:
        px[0::4], px[2::4] = px[2::4], px[0::4]
        if any(a != 255 for a in px[3::4]):
            note.append("unpremul")
            for i in range(3, len(px), 4):
                a = px[i]
                if a and a != 255:
                    for k in (i - 3, i - 2, i - 1):
                        px[k] = min(255, px[k] * 255 // a)
    else:
        px[0::3], px[2::3] = px[2::3], px[0::3]
    return w, h, ct, bd, px, "+".join(note) or "plain"


def convert(data: bytes) -> bytes:
    w, h, ct, bd, px, _note = decode_to_pixels(data)
    return _encode_png(w, h, ct, bd, bytes(px))


def cover_members(names: list[str]) -> list[str]:
    """曲库里可能存在的封面成员（0/jkt.png、0/jkt_50000095.png 等）。"""
    out = []
    for n in names:
        base = os.path.basename(n).lower()
        if base.startswith("jkt") and base.endswith((".png", ".jpg", ".jpeg")):
            out.append(n)
    return out


def rewrite(mcz: Path, replacements: dict[str, bytes]) -> None:
    tmp = mcz.with_name(mcz.name + ".tmp")
    try:
        with zipfile.ZipFile(mcz) as src, zipfile.ZipFile(
            tmp, "w", zipfile.ZIP_DEFLATED
        ) as dst:
            for info in src.infolist():
                blob = replacements.get(info.filename)
                if blob is None:
                    blob = src.read(info.filename)
                new_info = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                new_info.compress_type = info.compress_type
                new_info.external_attr = info.external_attr
                new_info.internal_attr = info.internal_attr
                new_info.create_system = info.create_system
                dst.writestr(new_info, blob)
        os.replace(tmp, mcz)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="把曲库封面里的苹果变体 PNG 转成标准 PNG")
    ap.add_argument("--music", default=str(MUSIC), help="曲库目录（默认 music/）")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写档")
    ap.add_argument("--verify", action="store_true", help="改完后再解一遍确认")
    ap.add_argument("--only", nargs="*", default=None, help="只处理这些 .mcz 路径")
    ap.add_argument("--json", default=None, help="把结果写到这个 JSON")
    args = ap.parse_args()

    music = Path(args.music)
    targets = sorted(music.glob("*/*.mcz"))
    if args.only:
        want = {str(Path(p)) for p in args.only}
        targets = [p for p in targets if str(p) in want or p.name in want]

    fixed: list[dict] = []
    ok = 0
    bad: list[dict] = []
    t0 = time.time()
    for mcz in targets:
        try:
            with zipfile.ZipFile(mcz) as z:
                members = cover_members(z.namelist())
                blobs = {m: z.read(m) for m in members}
        except (zipfile.BadZipFile, OSError) as exc:
            bad.append({"file": str(mcz), "error": f"读档失败：{exc}"})
            continue
        if not members:
            continue
        replacements: dict[str, bytes] = {}
        for m, blob in blobs.items():
            if is_standard_png(blob):
                try:
                    decode_to_pixels(blob)
                    ok += 1
                except CoverError as exc:
                    bad.append({"file": str(mcz), "member": m, "error": str(exc)})
                continue
            try:
                fixed_blob = convert(blob)
                decode_to_pixels(fixed_blob)
            except CoverError as exc:
                bad.append({"file": str(mcz), "member": m, "error": str(exc)})
                continue
            replacements[m] = fixed_blob
            fixed.append(
                {
                    "file": _rel(mcz, music),
                    "member": m,
                    "before": len(blob),
                    "after": len(fixed_blob),
                }
            )
        if replacements and not args.dry_run:
            try:
                rewrite(mcz, replacements)
            except OSError as exc:
                bad.append({"file": str(mcz), "error": f"写档失败：{exc}"})

    if args.verify and not args.dry_run:
        for item in list(fixed):
            mcz = REPO / item["file"]
            try:
                with zipfile.ZipFile(mcz) as z:
                    decode_to_pixels(z.read(item["member"]))
            except (CoverError, KeyError, zipfile.BadZipFile) as exc:
                bad.append({"file": item["file"], "error": f"回读失败：{exc}"})

    report = {
        "music": str(music),
        "scanned": len(targets),
        "already_ok": ok,
        "converted": len(fixed),
        "bad": bad,
        "items": fixed,
        "dry_run": bool(args.dry_run),
        "elapsed_s": round(time.time() - t0, 2),
    }
    if args.json:
        Path(args.json).write_text(
            json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    print(
        f"扫描 {report['scanned']} 个档：标准封面 {ok} 张，"
        f"{'待' if args.dry_run else '已'}转换 {len(fixed)} 张，异常 {len(bad)} 个"
    )
    for b in bad[:20]:
        print("  ！", b)
    return 0


if __name__ == "__main__":
    sys.exit(main())
