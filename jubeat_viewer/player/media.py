"""磁盘缓存、原子写入、HTTP Range 与响应发送。"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import posixpath
import re
import threading
import tempfile
from pathlib import Path
from urllib.parse import unquote

from source_revision import source_revision

# Fixed lock stripes stay bounded and cannot be evicted while a caller holds
# a reference but has not acquired it yet. Hash collisions only serialize work.
_MEMBER_LOCKS = tuple(threading.Lock() for _ in range(256))

# 构建产物一律 0644：站点由 nginx（www 用户）读取，而 rsync -a 会保留权限。
# mkstemp 建的是 0600，不显式改的话「文件在但 403」。
DEFAULT_FILE_MODE = 0o644


def lock_for(key: str) -> threading.Lock:
    digest = hashlib.blake2b(key.encode("utf-8", "surrogatepass"), digest_size=2).digest()
    return _MEMBER_LOCKS[int.from_bytes(digest, "big") % len(_MEMBER_LOCKS)]


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


def member_is_fresh(cached: Path, source: Path) -> bool:
    """A cache is valid only for the exact source and fully published file."""
    try:
        if not cached.is_file() or cached.stat().st_size == 0:
            return False
        stamp = json.loads(_revision_file(cached).read_text(encoding="utf-8"))
        return (isinstance(stamp, dict)
                and stamp.get("source") == source_revision(source)
                and stamp.get("cached") == source_revision(cached))
    except (OSError, ValueError, TypeError):
        return False


def _revision_file(cached: Path) -> Path:
    return cached.with_name(cached.name + ".revision.json")


def mark_member_fresh(cached: Path, source: Path, revision: str) -> None:
    """Publish validation last; interrupted writes are never reusable caches."""
    if source_revision(source) != revision:
        raise OSError("Source changed while generating media")
    write_atomic(_revision_file(cached), json.dumps({
        "source": revision, "cached": source_revision(cached),
    }, separators=(",", ":")).encode("utf-8"))


def write_atomic(path: Path, data: bytes, mode: int | None = DEFAULT_FILE_MODE,
                 skip_identical: bool = False) -> None:
    """原子写文件，并把权限固定成站点可读的 0644（构建产物唯一一份实现）。

    * `mode=None` 表示保留目标文件原有的权限（入口页那种「部署后可能被改过
      权限」的文件用这个）；目标不存在时退回 0644。
    * `skip_identical=True` 时先比内容，一样就不动文件 —— 分享页有两千多个，
      重建时没必要每个都改一次 mtime。

    以前这里不给 mkstemp 的 0600 补 chmod，os.replace 会把权限一起带过去：
    构建产物经 `rsync -a` 同步到服务器后仍是 0600，nginx 以 www 运行就 403
    （deploy/README.md 专门为音频目录交代 chown/chmod，说明这个坑踩过）。
    仓库里另外三份原子写（分享页 / 入口页 / 精简库）已统一到这一份。
    """
    if skip_identical:
        try:
            # 先比大小：绝大多数「改过了」的文件长度就不同，不必读整份
            if path.stat().st_size == len(data) and path.read_bytes() == data:
                return
        except OSError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    if mode is None:
        try:
            mode = path.stat().st_mode & 0o777
        except OSError:
            mode = DEFAULT_FILE_MODE
    # mkstemp reserves a unique name across threads and processes.
    fd, name = tempfile.mkstemp(prefix=path.name + ".tmp-", dir=path.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


# Range 值的形状：恰好一个短横线，两侧要么是纯数字要么是空。
# 三份实现（这里 / electron/site-server.js / deploy/php）共用同一套语义，
# 一致性由 tools/test_range.py 用同一张用例表守着。
# 必须用 [0-9] 而非 \d：Python 的 \d 默认匹配 Unicode 十进制数字（阿拉伯-印度、
# 全角等），而 Node 的 /^\d+$/ 与 PHP 非 u 模式的 PCRE 只认 ASCII；用 \d 会让
# 同一请求在开发服务器走 206、在线上走 200。
_RANGE_SPEC = re.compile(r"([0-9]*)-([0-9]*)")


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
    # Open first: headers and body must describe the same inode when a cache is
    # atomically replaced. A missing file can still receive a normal error here.
    with open(path, "rb") as fh:
        size = os.fstat(fh.fileno()).st_size
        rng = parse_range(handler.headers.get("Range", ""), size)
        base = {"Content-Type": ctype, "Accept-Ranges": "bytes"}
        base.update(extra or {})
        start, length = 0, size
        if rng is not None:
            start, end = rng
            length = end - start + 1
            base["Content-Range"] = f"bytes {start}-{end}/{size}"
        handler.send_response(206 if rng is not None else 200)
        for key, value in base.items():
            handler.send_header(key, value)
        handler.send_header("Content-Length", str(length))
        handler.end_headers()
        if handler.command == "HEAD":
            return
        try:
            fh.seek(start)
            out = handler.wfile
            remaining = length
            while remaining > 0:
                data = fh.read(min(COPY_CHUNK, remaining))
                if not data:
                    handler.close_connection = True
                    break
                out.write(data)
                remaining -= len(data)
        except OSError:
            # Broken pipes, device removal and short reads cannot share this
            # connection with a later response: Content-Length was already sent.
            handler.close_connection = True
