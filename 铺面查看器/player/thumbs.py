"""封面缩略图生成。

列表里的封面只要几十像素，原始 jkt.png 是 320×320、平均 151 KB，直接传太浪费。
这里按需生成缩略图并落盘缓存。

后端按可用性自动选：Pillow（推荐，Linux 上 `pip install pillow`）→ macOS 自带 sips → 都没有就返回原始封面。
"""
from __future__ import annotations

import shutil
import os
import subprocess
import tempfile
from pathlib import Path

_backend: str | None = None


def backend() -> str:
    """返回可用的缩略图后端名：'pillow' / 'sips' / 'none'。"""
    global _backend
    if _backend is not None:
        return _backend
    try:
        from PIL import Image  # noqa: F401

        _backend = "pillow"
    except Exception:
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
    except Exception:
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
    except Exception:
        return False
    finally:
        if tmp is not None:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
    return False


def profile() -> str:
    """Include backend implementation version in thumbnail cache signatures."""
    kind = backend()
    if kind == "pillow":
        import PIL
        return kind + ":" + PIL.__version__
    if kind == "sips":
        return kind + ":" + subprocess.check_output(["sips", "--version"], text=True).strip()
    return kind
