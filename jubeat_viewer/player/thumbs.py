"""封面缩略图生成。

列表里的封面只要几十像素，原始 jkt.png 是 320×320、平均 151 KB，直接传太浪费。
这里按需生成缩略图并落盘缓存。

后端按可用性自动选：Pillow（推荐，Linux 上 `pip install pillow`）→ macOS 自带 sips → 都没有就返回原始封面。
"""
from __future__ import annotations

import logging
import shutil
import os
import subprocess
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)

_backend: str | None = None


def backend() -> str:
    """返回可用的缩略图后端名：'pillow' / 'sips' / 'none'。"""
    global _backend
    if _backend is not None:
        return _backend
    try:
        from PIL import Image  # noqa: F401

        _backend = "pillow"
    except ImportError:
        # 没装 Pillow 才是「后端不可用」，属正常降级，不当异常记。
        _backend = "sips" if shutil.which("sips") else "none"
    except Exception as exc:
        # 装了却在 import 阶段崩了：不把它当成「后端不可用」，记下真实异常类型，
        # 降级行为保持不变（server.py 仍会回退原图，但日志里不再是一片静默）。
        log.warning("thumbs: 探测 Pillow 后端异常（%s: %s），降级到 sips/none",
                    type(exc).__name__, exc, exc_info=True)
        _backend = "sips" if shutil.which("sips") else "none"
    return _backend


def _with_pillow(src: Path, dest: Path, size: int, quality: int) -> bool:
    from PIL import Image

    with Image.open(src) as im:
        im = im.convert("RGB")
        im.thumbnail((size, size), Image.LANCZOS)
        canvas = Image.new("RGB", (size, size), (10, 12, 18))
        canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
        canvas.save(dest, "JPEG", quality=quality, optimize=True)
    return True


def _with_sips(src: Path, dest: Path, size: int, quality: int) -> bool:
    """macOS 自带 sips：先缩到目标尺寸，再转 JPEG。"""
    tmp = Path(tempfile.mkdtemp(prefix="jvthumb-")) / "out.jpg"
    try:
        r = subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(quality),
             "-Z", str(size), str(src), "--out", str(tmp)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
        )
        if r.returncode != 0 or not tmp.is_file():
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp), str(dest))
        return True
    except Exception as exc:
        # sips 超时 / 崩溃 / 目录不可写：保留回退原图，但把异常类型与文件路径记下来，
        # 别让 server.py:355-358 悄悄降级且零日志。
        log.warning("thumbs: sips 生成缩略图失败（%s: %s）src=%s dest=%s",
                    type(exc).__name__, exc, src, dest, exc_info=True)
        return False
    finally:
        shutil.rmtree(tmp.parent, ignore_errors=True)


def make(src: Path, dest: Path, size: int, quality: int) -> bool:
    """Generate privately and publish only a completed thumbnail atomically."""
    kind = backend()
    tmp = None
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=dest.name + ".tmp-", suffix=".jpg", dir=dest.parent)
        os.close(fd)
        tmp = Path(name)
        if kind == "pillow":
            success = _with_pillow(src, tmp, size, quality)
        elif kind == "sips":
            success = _with_sips(src, tmp, size, quality)
        else:
            return False
        if success and tmp.is_file() and tmp.stat().st_size:
            os.replace(tmp, dest)
            return True
    except Exception as exc:
        # Pillow 解码崩溃 / 缓存目录不可写 / 原子发布失败：保留降级（回原图），
        # 但记录真实异常类型与涉及的文件路径。
        log.warning("thumbs: 生成缩略图失败（%s: %s）src=%s dest=%s",
                    type(exc).__name__, exc, src, dest, exc_info=True)
        return False
    finally:
        if tmp is not None:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
    return False


_profiles: dict[str, str] = {}


def profile() -> str:
    """Include backend implementation version in thumbnail cache signatures.

    This runs on every thumbnail request, so it must never raise: a broken or
    mocked backend would otherwise turn a graceful "fall back to the original
    cover" into a 500. Only the signature changes, the fallback stays intact.

    Memoized per backend name for the process lifetime: 后端实现版本在进程里不会变，
    而 sips 分支每次都会 fork 一个 `sips --version`（列表滚动时一屏几十个请求
    就是几十次 fork）。按后端名分桶缓存，测试里替换 backend 时不会读到旧值。
    """
    kind = backend()
    cached = _profiles.get(kind)
    if cached is not None:
        return cached
    if kind == "pillow":
        try:
            import PIL
            value = kind + ":" + PIL.__version__
        except Exception:
            value = kind + ":unknown"
    elif kind == "sips":
        try:
            value = kind + ":" + subprocess.check_output(["sips", "--version"], text=True).strip()
        except Exception:
            value = kind
    else:
        value = kind
    _profiles[kind] = value
    return value
