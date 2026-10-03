"""zip 成员读取、磁盘缓存、HTTP Range 与响应发送。"""
from __future__ import annotations

import hashlib
import mimetypes
import os
import posixpath
import re
import threading
import zipfile
from pathlib import Path
from urllib.parse import unquote

# 同一个文件被并发请求时只解一次
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_LOCKS_MAX = 4096


def zip_name(info: zipfile.ZipInfo) -> str:
    """zip 里的中文名：有 UTF-8 标志位就直接用，否则按 cp437→utf8/shift_jis 猜。"""
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    try:
        raw = name.encode("cp437")
    except UnicodeEncodeError:
        return name
    for enc in ("utf-8", "shift_jis", "cp932"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return name


def lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        if len(_locks) > _LOCKS_MAX:      # 长跑之后别让字典无限涨
            for k in [k for k, v in _locks.items() if not v.locked()][: _LOCKS_MAX // 2]:
                _locks.pop(k, None)
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = threading.Lock()
        return lock


def guess_ctype(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def unquote_path(rel: str) -> str:
    """URL 路径解百分号编码（曲名里有空格、日文等）。"""
    try:
        return unquote(rel)
    except Exception:
        return rel


def cache_key(*parts: str) -> str:
    h = hashlib.sha1()
    for p in parts:
        h.update(p.encode("utf-8", "surrogatepass"))
        h.update(b"\x00")
    return h.hexdigest()[:20]


def safe_join(root: Path, rel: str) -> Path:
    """把 URL 里的相对路径安全地拼到 root 下，挡住 ../ 穿越。"""
    rel = (rel or "").replace("\\", "/").lstrip("/")
    rel = posixpath.normpath(rel)
    if rel in (".", ""):
        rel = "."
    if rel.startswith(".."):
        raise ValueError("path escapes root")
    dest = (root / rel).resolve()
    root_res = root.resolve()
    if dest != root_res and root_res not in dest.parents:
        raise ValueError("path escapes root")
    return dest


def read_member(zip_path: Path, member: str) -> bytes:
    """读取 zip 成员；先精确匹配，再按 basename 兜底（兼容不同打包工具）。"""
    with zipfile.ZipFile(zip_path) as zf:
        target = None
        base = os.path.basename(member)
        for info in zf.infolist():
            if info.is_dir():
                continue
            if info.filename == member or zip_name(info) == member:
                target = info
                break
        if target is None:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                if os.path.basename(zip_name(info)) == base:
                    target = info
                    break
        if target is None:
            raise FileNotFoundError(member)
        return zf.read(target)


def member_is_fresh(cached: Path, zip_path: Path) -> bool:
    """缓存文件是否还跟得上源 zip（zip 更新过就重新解）。"""
    try:
        if not cached.is_file() or cached.stat().st_size == 0:
            return False
        return cached.stat().st_mtime >= zip_path.stat().st_mtime
    except OSError:
        return False


def cached_member_file(zip_path: Path, member: str, dest: Path) -> Path:
    """把 zip 成员解到 dest（原子写入 + 单飞锁），返回 dest。已存在且新鲜就直接用。"""
    if member_is_fresh(dest, zip_path):
        return dest
    with lock_for(str(dest)):
        if member_is_fresh(dest, zip_path):  # 等锁期间别人已经解好了
            return dest
        data = read_member(zip_path, member)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + f".tmp{os.getpid()}")
        try:
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, dest)
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
        return dest


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


# Range 值的形状：恰好一个短横线，两侧要么是纯数字要么是空。
# 三份实现（这里 / electron/site-server.js / deploy/php）共用同一套语义，
# 一致性由 tools/test_range.py 用同一张用例表守着。
_RANGE_SPEC = re.compile(r"(\d*)-(\d*)")


def parse_range(header: str, size: int) -> tuple[int, int] | None:
    """解析单段 Range，返回闭区间 (start, end)；不支持/非法返回 None。

    以前这里是 int() 硬转：`bytes=0 - 99` 这种带空格的脏值会被 int() 自己 strip
    掉而放行，Node / PHP 两份实现都判非法 —— 同一个音频在三种部署下会不会走 206
    就不一致了。现在统一成严格正则（仍然容忍整个值首尾的空白，那是 RFC 允许的 OWS）。
    """
    h = (header or "").strip()
    m = _RANGE_SPEC.fullmatch(h[6:].strip()) if h.startswith("bytes=") else None
    if m is None or size <= 0:
        return None
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "" and end_s == "":
        return None
    if start_s == "":
        n = int(end_s)
        if n <= 0:
            return None
        start, end = max(0, size - n), size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
    if start < 0 or start >= size:
        return None
    end = min(end, size - 1)
    if end < start:
        return None
    return start, end


COPY_CHUNK = 256 * 1024


def stream_file(handler, path: Path, ctype: str, extra: dict | None = None) -> None:
    """支持 Range 的文件响应。

    这里刻意只用 read+write：os.sendfile 在 macOS 上必须传 offset，而且和
    http.server 的缓冲/keep-alive 混用容易出坑，实测收益也只有零点几毫秒。
    """
    size = path.stat().st_size
    rng = parse_range(handler.headers.get("Range", ""), size)
    base = {"Content-Type": ctype, "Accept-Ranges": "bytes"}
    base.update(extra or {})

    if rng is None:
        handler.send_response(200)
        for k, v in base.items():
            handler.send_header(k, v)
        handler.send_header("Content-Length", str(size))
        handler.end_headers()
        start, length = 0, size
    else:
        start, end = rng
        length = end - start + 1
        handler.send_response(206)
        for k, v in base.items():
            handler.send_header(k, v)
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        handler.send_header("Content-Length", str(length))
        handler.end_headers()

    if handler.command == "HEAD":
        return
    # stat 与 open 之间文件可能被删掉 / 换掉（缓存清理、曲库重读）：这时响应头
    # 已经发出去了，补不了 404，只能断开连接让客户端重来。异常要是冒到
    # server.py 的兜底里，就会变成「一条连接上两个响应」。
    try:
        fh = open(path, "rb")
    except OSError:
        handler.close_connection = True
        return
    try:
        with fh:
            fh.seek(start)
            out = handler.wfile
            remaining = length
            while remaining > 0:
                data = fh.read(min(COPY_CHUNK, remaining))
                if not data:
                    break
                out.write(data)
                remaining -= len(data)
    except (BrokenPipeError, ConnectionResetError):
        pass  # 客户端提前断开（拖进度条时很常见）
    except OSError:
        # 读到一半磁盘出错（外接盘掉了之类）：同理，只能断流
        handler.close_connection = True
