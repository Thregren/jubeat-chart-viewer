#!/usr/bin/env python3
"""生成安卓启动图标 —— 纯标准库写 PNG，不依赖 PIL。

jubeat 的记号本来就是 4×4 的方块栅格，照着做一个：深色底 + 16 个圆角小方块，
颜色沿对角线从青到黄绿铺开。4 倍超采样再盒式降采样，边缘才不毛。
图是「用代码画出来的」，所以不往仓库塞二进制素材，改一行重跑就行。

    python3 tools/make_android_icon.py            # 写进 android/app/res/mipmap-*
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 密度名 → 边长（像素）。48dp 的图标在各密度下的像素尺寸。
SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

BG = (0x10, 0x10, 0x14)
SS = 4                                   # 超采样倍数


def hsv_to_rgb(h: float, s: float, v: float) -> tuple[int, int, int]:
    h = h % 360.0
    c = v * s
    x = c * (1 - abs((h / 60.0) % 2 - 1))
    m = v - c
    if h < 60:
        r, g, b = c, x, 0
    elif h < 120:
        r, g, b = x, c, 0
    elif h < 180:
        r, g, b = 0, c, x
    elif h < 240:
        r, g, b = 0, x, c
    elif h < 300:
        r, g, b = x, 0, c
    else:
        r, g, b = c, 0, x
    return (int(round((r + m) * 255)), int(round((g + m) * 255)), int(round((b + m) * 255)))


def in_round_rect(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def render(size: int) -> bytes:
    """返回 size×size 的 RGB 像素（逐行）。"""
    n = size * SS
    margin = 0.10 * n
    gap = 0.030 * n
    cell = (n - 2 * margin - 3 * gap) / 4.0
    radius = cell * 0.26

    # 每个格子的颜色：沿对角线方向的青 → 黄绿渐变
    colors = []
    for row in range(4):
        for col in range(4):
            t = (row + col) / 6.0
            colors.append(hsv_to_rgb(178 - 60 * t, 0.72, 0.98 - 0.10 * t))

    hi = bytearray(n * n * 3)
    for y in range(n):
        fy = y + 0.5
        base = y * n * 3
        for x in range(n):
            fx = x + 0.5
            r, g, b = BG
            for idx in range(16):
                row, col = divmod(idx, 4)
                x0 = margin + col * (cell + gap)
                y0 = margin + row * (cell + gap)
                if in_round_rect(fx, fy, x0, y0, x0 + cell, y0 + cell, radius):
                    r, g, b = colors[idx]
                    break
            o = base + x * 3
            hi[o] = r
            hi[o + 1] = g
            hi[o + 2] = b

    # 盒式降采样 SS×SS
    out = bytearray(size * size * 3)
    area = SS * SS
    for y in range(size):
        for x in range(size):
            sr = sg = sb = 0
            for dy in range(SS):
                row = (y * SS + dy) * n
                for dx in range(SS):
                    o = (row + x * SS + dx) * 3
                    sr += hi[o]
                    sg += hi[o + 1]
                    sb += hi[o + 2]
            o = (y * size + x) * 3
            out[o] = sr // area
            out[o + 1] = sg // area
            out[o + 2] = sb // area
    return bytes(out)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path: Path, size: int, rgb: bytes) -> None:
    raw = bytearray()
    stride = size * 3
    for y in range(size):
        raw.append(0)                       # filter: none
        raw += rgb[y * stride:(y + 1) * stride]
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main() -> int:
    for density, size in SIZES.items():
        dest = REPO / "android" / "app" / "res" / f"mipmap-{density}" / "ic_launcher.png"
        dest.parent.mkdir(parents=True, exist_ok=True)
        write_png(dest, size, render(size))
        print(f"  {dest.relative_to(REPO)}  {size}×{size}  {dest.stat().st_size} 字节")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
