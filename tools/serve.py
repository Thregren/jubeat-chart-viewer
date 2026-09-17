#!/usr/bin/env python3
"""本地预览构建好的静态站点（带 Range，音源可以拖动进度条）。

    python3 tools/serve.py                 # 预览 ./site
    python3 tools/serve.py site --port 8080

生产环境用 nginx 就够了，这个脚本只是本机预览 / 临时给别人看时用。
"""
from __future__ import annotations

import argparse
import functools
import mimetypes
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

TEXT_SUFFIXES = {".html", ".js", ".css", ".json", ".svg"}


class RangeHandler(SimpleHTTPRequestHandler):
    """在标准静态文件服务上加 HTTP/1.1 + Range + 合理的缓存头。"""

    protocol_version = "HTTP/1.1"

    def end_headers(self) -> None:
        path = self.path.split("?", 1)[0].lower()
        if path.endswith((".ogg", ".mp3", ".wav", ".jpg", ".jpeg", ".png", ".webp", ".gif")):
            self.send_header("Cache-Control", "public, max-age=3600")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def guess_type(self, path):
        ctype = super().guess_type(path)
        if Path(path).suffix.lower() in TEXT_SUFFIXES and "charset" not in str(ctype):
            ctype = f"{ctype}; charset=utf-8" if ctype else "text/plain; charset=utf-8"
        return ctype

    def send_head(self):
        """支持 Range 的 send_head：标准库只认 200，这里补 206。"""
        self._range_left = None  # keep-alive 复用时别把上一次的 Range 状态带过来
        path = Path(self.translate_path(self.path))
        if path.is_dir():
            return super().send_head()
        if not path.is_file():
            self.send_error(404, "File not found")
            return None

        size = path.stat().st_size
        rng = self._parse_range(self.headers.get("Range", ""), size)
        ctype = self.guess_type(str(path))
        try:
            fh = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        if rng is None:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.end_headers()
            return fh

        start, end = rng
        fh.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_left = end - start + 1
        return fh

    @staticmethod
    def _parse_range(header: str, size: int):
        if not header.startswith("bytes=") or "," in header or size <= 0:
            return None
        spec = header.split("=", 1)[1].strip()
        if "-" not in spec:
            return None
        a, b = spec.split("-", 1)
        try:
            if a == "":
                n = int(b)
                if n <= 0:
                    return None
                return max(0, size - n), size - 1
            start = int(a)
            end = int(b) if b else size - 1
        except ValueError:
            return None
        if start < 0 or start >= size:
            return None
        end = min(end, size - 1)
        if end < start:
            return None
        return start, end

    def copyfile(self, source, outputfile) -> None:
        left = getattr(self, "_range_left", None)
        if left is None:
            return super().copyfile(source, outputfile)
        try:
            while left > 0:
                chunk = source.read(min(256 * 1024, left))
                if not chunk:
                    break
                outputfile.write(chunk)
                left -= len(chunk)
        finally:
            self._range_left = None

    def log_message(self, fmt: str, *args) -> None:
        if len(args) > 1 and str(args[1]).startswith(("2", "3")) and args[0].startswith("GET"):
            return  # 静态资源太吵，只记异常
        super().log_message(fmt, *args)


def main() -> int:
    ap = argparse.ArgumentParser(description="预览静态站点")
    ap.add_argument("root", nargs="?", default=str(REPO / "site"))
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not (root / "index.html").is_file():
        print(f"{root} 里没有 index.html：先跑 python3 tools/build_site.py", file=sys.stderr)
        return 1
    handler = functools.partial(RangeHandler, directory=str(root))
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    httpd.daemon_threads = True
    print(f"静态站点 → http://{args.host}:{args.port}/   （{root}）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
