#!/usr/bin/env python3
"""端到端自测：静态站点 + 开发服务器两种模式都跑一遍关键接口。

    python3 tools/smoke_test.py            # 用现有 ./site（没有就先建一个小的）
    python3 tools/smoke_test.py --build    # 先构建一个只有 5 首的临时站点再测

检查项：首页/前端资源、曲库索引、marker 清单、谱面、音源（整条 + Range）、封面、缩略图、
缓存头、gzip 与 ETag/304、以及不存在的路径要 404。
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLAYER_DIR = REPO / "铺面查看器" / "player"

PASS, FAIL = "\033[32m✓\033[0m", "\033[31m✗\033[0m"


class Checker:
    def __init__(self) -> None:
        self.failed: list[str] = []
        self.count = 0

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.count += 1
        print(f"  {PASS if ok else FAIL} {name}" + (f"  [{detail}]" if detail and not ok else ""))
        if not ok:
            self.failed.append(name)
        return ok


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def fetch(url: str, headers: dict | None = None, method: str = "GET"):
    req = urllib.request.Request(url, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()


def wait_ready(port: int, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status, _, _ = fetch(f"http://127.0.0.1:{port}/")
            if status == 200:
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def run_suite(base: str, c: Checker, *, label: str, expect_gzip: bool) -> dict:
    print(f"\n[{label}] {base}")
    status, _, body = fetch(base + "/")
    c.check("首页 200 且是 HTML", status == 200 and b"<!DOCTYPE html>" in body, f"{status}")

    status, _, body = fetch(base + "/static/app.js")
    c.check("前端 app.js", status == 200 and b"drawMarkers" in body, f"{status} {len(body)}B")

    status, hdrs, body = fetch(base + "/data/library.json")
    ok = status == 200
    songs = []
    if ok:
        try:
            songs = json.loads(body)["songs"]
        except Exception as exc:
            ok = False
            print("    JSON 解析失败:", exc)
    c.check("曲库索引可用", ok and len(songs) > 0, f"{status} {len(songs)} 首")
    c.check("索引带 ETag", "ETag" in hdrs or expect_gzip is False, str(hdrs.get("ETag")))
    if expect_gzip:
        s2, h2, b2 = fetch(base + "/data/library.json", {"Accept-Encoding": "gzip"})
        c.check("索引支持 gzip", h2.get("Content-Encoding") == "gzip" and len(b2) < len(body),
                f"{len(b2)}B vs {len(body)}B")
        tag = h2.get("ETag")
        if tag:
            s3, _, _ = fetch(base + "/data/library.json", {"If-None-Match": tag})
            c.check("ETag 命中返回 304", s3 == 304, str(s3))

    status, _, body = fetch(base + "/data/markers.json")
    n_markers = 0
    try:
        n_markers = len(json.loads(body).get("markers") or [])
    except Exception:
        pass
    c.check("marker 清单", status == 200 and n_markers > 0, f"{status} {n_markers} 个")

    if not songs:
        return {}
    song = songs[0]
    stem = song["id"][:-4] if song["id"].lower().endswith(".mcz") else song["id"]
    stem_q = "/".join(urllib.parse.quote(p) for p in stem.split("/"))
    chart = song["charts"][-1]

    status, _, body = fetch(f"{base}/data/charts/{stem_q}/{chart['code']}.json")
    ok = status == 200
    if ok:
        try:
            json.loads(body)
        except Exception:
            ok = False
    c.check("谱面 JSON", ok, f"{status} {len(body)}B")

    status, hdrs, body = fetch(f"{base}/media/audio/{stem_q}.ogg")
    c.check("音源整条", status == 200 and len(body) > 100_000, f"{status} {len(body)}B")
    c.check("音源 Accept-Ranges", hdrs.get("Accept-Ranges") == "bytes", str(hdrs.get("Accept-Ranges")))

    status, hdrs, body = fetch(f"{base}/media/audio/{stem_q}.ogg", {"Range": "bytes=1000-2999"})
    c.check("音源 Range 206", status == 206 and len(body) == 2000, f"{status} {len(body)}B")
    c.check("Content-Range 正确",
            str(hdrs.get("Content-Range", "")).startswith("bytes 1000-2999/"), str(hdrs.get("Content-Range")))

    if song.get("cover"):
        ext = os.path.splitext(song["cover"])[1].lower() or ".png"
        status, _, body = fetch(f"{base}/media/cover/{stem_q}{ext}")
        c.check("封面原图", status == 200 and len(body) > 1000, f"{status} {len(body)}B")
        status, _, body = fetch(f"{base}/media/thumb/{stem_q}.jpg")
        c.check("封面缩略图", status == 200 and body[:2] == b"\xff\xd8", f"{status} {len(body)}B")
        c.check("缩略图比原图小", len(body) < 100_000, f"{len(body)}B")

    status, _, _ = fetch(base + "/media/audio/../music/../nope.ogg")
    c.check("非法路径 404/400", status in (400, 404), str(status))
    status, _, _ = fetch(base + "/data/charts/does-not-exist/EXT.json")
    c.check("不存在曲目 404", status in (400, 404), str(status))
    return song


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true", help="先构建一个 5 首的临时站点")
    ap.add_argument("--site", default=str(REPO / "site"))
    args = ap.parse_args()

    c = Checker()
    procs: list[subprocess.Popen] = []
    tmp_ctx = None
    site = Path(args.site)

    if args.build or not (site / "index.html").is_file():
        tmp_ctx = tempfile.TemporaryDirectory(prefix="jv-smoke-")
        site = Path(tmp_ctx.name) / "site"
        print(f"构建测试站点（5 首）→ {site}")
        r = subprocess.run([sys.executable, str(REPO / "tools" / "build_site.py"),
                            "--out", str(site), "--limit", "5", "--force"],
                           capture_output=True, text=True)
        if r.returncode not in (0, 2):
            print(r.stdout[-2000:], r.stderr[-2000:])
            return 1

    try:
        # —— 静态站点模式 ——
        port_static = free_port()
        procs.append(subprocess.Popen(
            [sys.executable, str(REPO / "tools" / "serve.py"), str(site), "--port", str(port_static)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        if wait_ready(port_static):
            run_suite(f"http://127.0.0.1:{port_static}", c, label="静态站点", expect_gzip=False)
        else:
            c.check("静态服务器启动", False, "超时")

        # —— 开发服务器模式（直接从 .mcz 读）——
        if (PLAYER_DIR / "config.py").is_file():
            port_dev = free_port()
            env = dict(os.environ, JUBEAT_PORT=str(port_dev))
            procs.append(subprocess.Popen([sys.executable, str(PLAYER_DIR / "server.py")],
                                          cwd=str(REPO), env=env,
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            if wait_ready(port_dev, timeout=60):
                run_suite(f"http://127.0.0.1:{port_dev}", c, label="开发服务器", expect_gzip=True)
            else:
                c.check("开发服务器启动", False, "超时")
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except Exception:
                p.kill()
        if tmp_ctx:
            tmp_ctx.cleanup()

    print()
    if c.failed:
        print(f"{FAIL} {len(c.failed)}/{c.count} 项失败：" + "、".join(c.failed))
        return 1
    print(f"{PASS} 全部 {c.count} 项通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
