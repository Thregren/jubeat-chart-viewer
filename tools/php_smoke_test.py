#!/usr/bin/env python3
"""PHP 版入口（deploy/php/index.php）的端到端自测。

用 php -S 起一个临时站点，验证静态直发 / Range / gzip / 304 / 目录穿越防护。

    python3 tools/php_smoke_test.py            # 需要 php 在 PATH 里
    python3 tools/php_smoke_test.py --php /tmp/phpcli/php
"""
from __future__ import annotations

import argparse
import gzip
import http.client
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"

passed = failed = 0


def check(name: str, ok: bool, extra: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  {GREEN}✓{RESET} {name}")
    else:
        failed += 1
        print(f"  {RED}✗{RESET} {name} {RED}{extra}{RESET}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def request(port: int, path: str, headers: dict[str, str] | None = None, method: str = "GET"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(method, path, headers=headers or {})
    res = conn.getresponse()
    body = res.read()
    out = (res.status, dict((k.lower(), v) for k, v in res.getheaders()), body)
    conn.close()
    return out


def build_root(tmp: Path) -> tuple[Path, dict[str, bytes]]:
    """造一个迷你站点：html / json / js / 一个 2 MB 的『音源』。"""
    root = tmp / "site"
    (root / "data").mkdir(parents=True)
    (root / "static").mkdir()
    (root / "media" / "audio").mkdir(parents=True)

    html = b"<!doctype html><title>jubeat</title>\n"
    (root / "index.html").write_bytes(html)
    blob = bytes(range(256)) * 8192          # 2 MB，正好用来验 Range
    (root / "media" / "audio" / "song.ogg").write_bytes(blob)
    js = b"console.log('hi');\n" * 50
    (root / "static" / "app.js").write_bytes(js)
    # 索引故意做大一点，gzip 才看得出效果（真实 library.json 约 400 KB）
    index_json = b'{"songs":[' + b'{"id":"jubeat/song.mcz","title":"x"},' * 4000 + b'{}]}'
    (root / "data" / "library.json").write_bytes(index_json)
    shutil.copy2(ROOT / "deploy" / "php" / "index.php", root / "index.php")
    (root / ".htaccess").write_text("secret\n")
    return root, {"html": html, "blob": blob, "json": index_json}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--php", default=shutil.which("php") or "/tmp/phpcli/php")
    args = ap.parse_args()
    if not Path(args.php).exists():
        print(f"{RED}找不到 php：{args.php}{RESET}")
        return 2
    ver = subprocess.run([args.php, "-v"], capture_output=True, text=True).stdout.splitlines()[0]
    print(f"{DIM}{ver}{RESET}")

    with tempfile.TemporaryDirectory() as td:
        root, fixture = build_root(Path(td))
        html, blob, index_json = fixture["html"], fixture["blob"], fixture["json"]
        port = free_port()
        proc = subprocess.Popen(
            [args.php, "-S", f"127.0.0.1:{port}", "-t", str(root), str(root / "index.php")],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(50):
                try:
                    request(port, "/")
                    break
                except OSError:
                    time.sleep(0.1)

            print("[PHP 入口]")
            st, hd, body = request(port, "/")
            check("根路径 200 + text/html", st == 200 and "text/html" in hd.get("content-type", ""), f"{st}")
            check("根路径内容正确", body == html)
            check("Accept-Ranges 存在", hd.get("accept-ranges") == "bytes")

            st, hd, body = request(port, "/static/app.js")
            check("js 200 + text/javascript", st == 200 and "javascript" in hd.get("content-type", ""), str(st))

            st, hd, body = request(port, "/data/library.json")
            check("json 200 + application/json", st == 200 and "json" in hd.get("content-type", ""), str(st))

            st, hd, body = request(port, "/data/library.json", {"Accept-Encoding": "gzip"})
            ok = (st == 200 and hd.get("content-encoding") == "gzip" and len(body) < len(index_json)
                  and gzip.decompress(body) == index_json)
            check(f"json 支持 gzip（{len(index_json)} → {len(body)} B）", ok,
                  f"{st} {hd.get('content-encoding')}")

            size = len(blob)
            st, hd, body = request(port, "/media/audio/song.ogg")
            check("音源整条 200 + audio/ogg", st == 200 and hd.get("content-type") == "audio/ogg", str(st))
            check("音源 Content-Length 正确", hd.get("content-length") == str(size), hd.get("content-length", ""))

            st, hd, body = request(port, "/media/audio/song.ogg", {"Range": "bytes=0-99"})
            check("Range 0-99 → 206", st == 206, str(st))
            check("Content-Range 正确", hd.get("content-range") == f"bytes 0-99/{size}", hd.get("content-range", ""))
            check("Range 返回 100 字节且内容对", body == blob[:100], str(len(body)))

            st, hd, body = request(port, "/media/audio/song.ogg", {"Range": f"bytes={size - 10}-"})
            check("开区间 Range 到文件尾", st == 206 and body == blob[-10:], str(st))

            st, hd, body = request(port, "/media/audio/song.ogg", {"Range": "bytes=-10"})
            check("后缀 Range bytes=-10", st == 206 and body == blob[-10:], str(st))

            st, hd, body = request(port, "/media/audio/song.ogg", {"Range": f"bytes={size + 5}-"})
            check("越界 Range → 416", st == 416 and hd.get("content-range") == f"bytes */{size}", str(st))

            st, hd, body = request(port, "/media/audio/song.ogg")
            etag = hd.get("etag", "")
            st2, hd2, body2 = request(port, "/media/audio/song.ogg", {"If-None-Match": etag})
            check("ETag 命中 → 304", st2 == 304 and body2 == b"", f"{st2} {etag}")
            st3, hd3, _ = request(port, "/media/audio/song.ogg", {"If-Modified-Since": hd.get("last-modified", "")})
            check("Last-Modified 命中 → 304", st3 == 304, str(st3))

            st, hd, body = request(port, "/", method="HEAD")
            check("HEAD 无 body 且有 Content-Length", st == 200 and body == b"" and hd.get("content-length") == str(len(html)), str(st))

            st, hd, _ = request(port, "/nope.js")
            check("不存在的文件 → 404", st == 404, str(st))
            st, hd, _ = request(port, "/.htaccess")
            check("隐藏文件被挡 → 404", st == 404, str(st))
            st, hd, _ = request(port, "/../etc/passwd")
            check("目录穿越 → 404", st in (400, 404), str(st))
            st, hd, _ = request(port, "/media/audio/", method="GET")
            check("目录请求 → 404（无 index.html）", st == 404, str(st))
        finally:
            proc.terminate()
            proc.wait(timeout=10)

    print()
    if failed:
        print(f"{RED}✗ {failed} 项失败{RESET}（{passed} 项通过）")
        return 1
    print(f"{GREEN}✓ 全部 {passed} 项通过{RESET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
