#!/usr/bin/env python3
"""mcz 里的 bgm.ogg（Ogg Vorbis）→ Ogg Opus，带磁盘缓存。

为什么要转：曲库音源是 Vorbis，全库 2.38 GiB，占了安装包的绝大部分体积。
Opus 在同等听感下能省掉三成左右，容器仍然是 Ogg、扩展名仍然是 .ogg、
MIME 仍然是 audio/ogg —— 前端、nginx 配置、URL 布局都不用动一行。

设计要点：

* **缓存按内容走**：键 = 源文件字节 + 编码参数 + ffmpeg 版本，落盘在
  cache/audio-opus/。曲库没动、参数没变时重建只是一次拷贝，不会重新编码；
  换了码率或升级了 ffmpeg，键就变了，不会串味。
* **失败一律回退**：没有 ffmpeg、ffmpeg 报错、输出不像 Opus，都原样返回源数据。
  宁可站点大一点，也不能因为本机缺个工具就把音源整没了。
* 源素材本来就是 Opus 的话直接放行，不做二次编码（二次编码只会更差）。
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path

# 目标码率。实测（40 首随机样本、77 分钟音频）：
#   128k = 现在的 Vorbis 体积的 94%　96k = 76%　80k = 63%　64k = 50%
# 80k 是「体积砍掉三分之一、盲听基本无感」的拐点，全量安装包约 1.92 GB。
DEFAULT_BITRATE = "80k"
_BITRATE_RE = re.compile(r"^[0-9]{2,3}k$")


def _bitrate() -> str:
    raw = (os.environ.get("JUBEAT_OPUS_BITRATE") or "").strip()
    return raw if _BITRATE_RE.match(raw) else DEFAULT_BITRATE


_ffmpeg_path: str | None | bool = False      # False = 还没查过
_ffmpeg_ver: str | None | bool = False


def ffmpeg() -> str | None:
    """本机 ffmpeg 路径；没有就返回 None（只查一次）。"""
    global _ffmpeg_path
    if _ffmpeg_path is False:
        _ffmpeg_path = shutil.which("ffmpeg")
    return _ffmpeg_path or None


def _version() -> str:
    """ffmpeg 版本行（进缓存键：不同版本的 libopus 输出不一样）。"""
    global _ffmpeg_ver
    if _ffmpeg_ver is False:
        _ffmpeg_ver = ""
        exe = ffmpeg()
        if exe:
            try:
                out = subprocess.run([exe, "-hide_banner", "-version"], capture_output=True,
                                     timeout=20, check=False)
                first = out.stdout.decode("utf-8", "replace").splitlines()
                _ffmpeg_ver = first[0].strip() if first else ""
            except (OSError, subprocess.SubprocessError):
                _ffmpeg_ver = ""
    return _ffmpeg_ver or ""


def profile() -> str:
    """这一份编码参数的指纹，写进 data/build.json，也是缓存键的一部分。"""
    return f"opus/{_bitrate()}/vbr/audio/20ms/cl10/{_version() or 'no-ffmpeg'}"


def describe() -> str:
    """给人看的一行说明（构建日志 / build.json）。"""
    if not ffmpeg():
        return f"Opus {_bitrate()}（不可用：本机没有 ffmpeg，音源原样保留）"
    return f"Opus {_bitrate()}（VBR · application audio · 20ms 帧）"


def looks_like_opus(data: bytes) -> bool:
    """Ogg Opus 的第一页紧跟着 OpusHead，前 128 字节里必然能看到。"""
    return b"OpusHead" in data[:128]


def file_is_opus(path: Path) -> bool:
    """落盘文件是不是 Ogg Opus（只读前 128 字节）。"""
    try:
        with open(path, "rb") as fh:
            return looks_like_opus(fh.read(128))
    except OSError:
        return False


def _cache_file(cache_dir: Path, data: bytes) -> Path:
    h = hashlib.sha1()
    h.update(profile().encode("utf-8"))
    h.update(b"\x00")
    h.update(str(len(data)).encode("ascii"))
    h.update(b"\x00")
    h.update(data)
    return cache_dir / f"{h.hexdigest()[:32]}.ogg"


def _valid(path: Path) -> bool:
    """缓存文件是不是一份能用的 Opus Ogg（防止半截写入 / 空文件被当成命中）。"""
    try:
        if not path.is_file() or path.stat().st_size < 1024:
            return False
        with open(path, "rb") as fh:
            head = fh.read(128)
    except OSError:
        return False
    return head[:4] == b"OggS" and b"OpusHead" in head


def encode(data: bytes, cache_dir: Path) -> tuple[bytes, str]:
    """把一份 Ogg Vorbis 转成 Ogg Opus。

    返回 (数据, 状态)，状态取值：cached / encoded / already-opus / no-ffmpeg / failed。
    后三种都表示「原样返回了源数据」，调用方照写不误，只影响包体积。
    """
    exe = ffmpeg()
    if not exe:
        return data, "no-ffmpeg"
    if looks_like_opus(data):
        return data, "already-opus"

    dest = _cache_file(cache_dir, data)
    if _valid(dest):
        try:
            return dest.read_bytes(), "cached"
        except OSError:
            pass          # 读不动就当没缓存，重新编码

    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return data, "failed"
    tmp = dest.with_name(dest.name + f".tmp{os.getpid()}")
    cmd = [
        exe, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", "pipe:0", "-map", "0:a:0",
        "-c:a", "libopus", "-b:a", _bitrate(), "-vbr", "on",
        "-compression_level", "10", "-application", "audio", "-frame_duration", "20",
        "-map_metadata", "-1",
        "-f", "ogg", str(tmp),
    ]
    try:
        proc = subprocess.run(cmd, input=data, capture_output=True, timeout=900, check=False)
        if proc.returncode != 0:
            return data, "failed"
        if not _valid(tmp):
            return data, "failed"
        os.replace(tmp, dest)
    except (OSError, subprocess.SubprocessError):
        return data, "failed"
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    try:
        return dest.read_bytes(), "encoded"
    except OSError:
        return data, "failed"
