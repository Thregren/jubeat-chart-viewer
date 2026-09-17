#!/usr/bin/env python3
"""jubeat 铺面查看器 —— 本地 HTTP 服务。

职责：曲库索引、谱面 JSON、音源（Range / nginx X-Accel-Redirect）、封面与缩略图、marker 素材。
所有重活（zip 解包、缩略图）都会落到 <repo>/cache/ 里，重复请求直接走文件。

启动：
    python3 player/server.py                 # http://127.0.0.1:8765
    JUBEAT_PORT=8888 python3 player/server.py
"""
from __future__ import annotations

import gzip
import hashlib
import json
import mimetypes
import os
import sys
import traceback
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import config
import markers
import media
import thumbs
from library import Library

JSON_CT = "application/json; charset=utf-8"

LIB = Library()


class Handler(BaseHTTPRequestHandler):
    server_version = "JubeatViewer/0.2"
    protocol_version = "HTTP/1.1"  # 开 keep-alive：境外高延迟下差别很大

    # —— 基础输出 ——
    def log_message(self, fmt: str, *args) -> None:
        first = args[0] if args else ""
        if "/api/library" in str(first) or "/api/health" in str(first):
            return
        super().log_message(fmt, *args)

    def _accepts_gzip(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _send_bytes(self, code: int, body: bytes, ctype: str,
                    extra: dict | None = None, compress: bool = False) -> None:
        headers = dict(extra or {})
        if compress and len(body) >= config.GZIP_MIN_BYTES and self._accepts_gzip():
            body = gzip.compress(body, compresslevel=6)
            headers["Content-Encoding"] = "gzip"
            headers["Vary"] = "Accept-Encoding"
        headers.setdefault("X-Content-Type-Options", "nosniff")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _json(self, obj, code: int = 200, cache: str = "no-cache", etag: bool = True) -> None:
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        extra: dict = {"Cache-Control": cache}
        if etag:
            tag = '"%s"' % hashlib.sha1(body).hexdigest()[:20]
            if self.headers.get("If-None-Match") == tag:
                self.send_response(304)
                self.send_header("ETag", tag)
                self.send_header("Cache-Control", cache)
                self.end_headers()
                return
            extra["ETag"] = tag
        self._send_bytes(code, body, JSON_CT, extra, compress=True)

    def _error(self, message: str, code: int = 400) -> None:
        self._json({"error": message}, code)

    def _redirect(self, location: str, code: int = 302) -> None:
        self.send_response(code)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # —— 路由 ——
    def do_GET(self) -> None:
        try:
            self._route(urlparse(self.path))
        except FileNotFoundError as exc:
            self._error(str(exc) or "not found", 404)
        except (ValueError, KeyError) as exc:
            self._error(str(exc), 400)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端提前断开（拖进度条时很常见）
        except Exception as exc:  # 兜底：别因为单个请求把线程打挂
            traceback.print_exc()
            try:
                self._error(f"internal error: {exc}", 500)
            except Exception:
                pass

    do_HEAD = do_GET

    def _route(self, parsed) -> None:
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            return self._serve_static("index.html")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        if path.startswith("/markers/"):
            return self._serve_marker(path[len("/markers/"):])

        # —— 与静态站点完全相同的路径布局 ——
        if path == "/data/library.json":
            if qs.get("reindex", [""])[0]:
                LIB.load(force=True)
            return self._data_library()
        if path == "/data/markers.json":
            return self._json(markers.manifest(), cache="no-cache")
        if path.startswith("/data/charts/"):
            return self._media_chart(path[len("/data/charts/"):])
        if path.startswith("/media/audio/"):
            return self._media_file("audio", path[len("/media/audio/"):])
        if path.startswith("/media/cover/"):
            return self._media_file("cover", path[len("/media/cover/"):])
        if path.startswith("/media/thumb/"):
            return self._media_file("thumb", path[len("/media/thumb/"):])

        if path == "/api/health":  # 运维用，静态站点没有这个（nginx 里可以直接排除）
            return self._api_health()
        return self._error("not found", 404)

    # —— API ——
    def _api_health(self) -> None:
        LIB.load()
        return self._json({
            "ok": True,
            "library": str(LIB.root),
            "songs": len(LIB.songs),
            "cache": str(config.CACHE_DIR),
            "thumb_backend": thumbs.backend(),
            "thumb_size": config.THUMB_SIZE,
            "x_accel": config.X_ACCEL_PREFIX or None,
            "markers": len(markers.manifest().get("markers") or []),
        })

    def _data_library(self) -> None:
        LIB.load()
        return self._json({
            "version": config.INDEX_VERSION,
            "library": str(LIB.root),
            "versions": LIB.versions,
            "songs": LIB.songs,   # 搜索/筛选在前端做，这里只发一次全量
        })

    def _media_chart(self, rel: str) -> None:
        """data/charts/<曲目>/<难度>.json"""
        parts = [media.unquote_path(p) for p in rel.split("/") if p]
        if len(parts) < 2:
            raise FileNotFoundError(rel)
        stem = "/".join(parts[:-1])          # 曲目 id 里本身可能带 “/”（机台版本目录）
        code = os.path.splitext(parts[-1])[0].upper()
        LIB.load()
        song = LIB.by_media_stem(stem)
        if not song:
            raise FileNotFoundError(stem)
        chart = next((c for c in song["charts"] if c["code"] == code), None)
        if not chart:
            raise FileNotFoundError(f"{stem} {code}")
        data = media.read_member(LIB.mcz_path(song["id"]), chart["file"])
        return self._send_bytes(200, data, JSON_CT,
                                {"Cache-Control": "public, max-age=86400"}, compress=True)

    def _media_file(self, kind: str, rel: str) -> None:
        """media/{audio|cover|thumb}/<曲目>[.ext]"""
        stem = media.unquote_path(os.path.splitext(rel)[0])
        LIB.load()
        song = LIB.by_media_stem(stem)
        if not song:
            raise FileNotFoundError(stem)
        return self._serve_media(kind, song)

    def _serve_media(self, kind: str, song: dict) -> None:
        zip_path = LIB.mcz_path(song["id"])
        if kind == "audio":
            member = song.get("audio")
            if not member:
                raise FileNotFoundError("no audio")
            dest = self._cached(config.AUDIO_CACHE_DIR, song["id"], member, zip_path)
            ctype = mimetypes.guess_type(member)[0] or "audio/ogg"
            cache = "public, max-age=86400"
            return self._send_audio(dest, ctype, cache)

        member = song.get("cover")
        if not member:
            raise FileNotFoundError("no cover")
        cover = self._cached(config.COVER_CACHE_DIR, song["id"], member, zip_path)
        if kind == "cover":
            return media.stream_file(self, cover, media.guess_ctype(member),
                                     {"Cache-Control": "public, max-age=604800"})

        # thumb：没有可用的图像库就直接把原图发出去
        if thumbs.backend() == "none":
            return media.stream_file(self, cover, media.guess_ctype(member),
                                     {"Cache-Control": "public, max-age=604800"})
        size = config.THUMB_SIZE
        thumb = config.THUMB_CACHE_DIR / f"{media.cache_key(song['id'], member, str(size))}.jpg"
        if not media.member_is_fresh(thumb, zip_path):
            with media.lock_for(str(thumb)):
                if not media.member_is_fresh(thumb, zip_path):
                    if not thumbs.make(cover, thumb, size, config.THUMB_QUALITY):
                        return media.stream_file(self, cover, media.guess_ctype(member),
                                                 {"Cache-Control": "public, max-age=604800"})
        return media.stream_file(self, thumb, "image/jpeg",
                                 {"Cache-Control": "public, max-age=604800"})

    def _send_audio(self, dest: Path, ctype: str, cache: str) -> None:
        if config.X_ACCEL_PREFIX:
            # 交给 nginx 直接发文件：Range/断点/大文件都不再经过 Python
            self.send_response(200)
            self.send_header("X-Accel-Redirect", f"{config.X_ACCEL_PREFIX}{dest.name}")
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        return media.stream_file(self, dest, ctype, {"Cache-Control": cache})

    # —— 辅助 ——
    def _cached(self, cache_dir: Path, song_id: str, member: str, zip_path: Path) -> Path:
        """把 zip 成员解到磁盘缓存（按 曲目+成员 做 key，保留原扩展名方便判类型）。"""
        ext = os.path.splitext(member)[1].lower()
        if ext not in (".ogg", ".mp3", ".wav", ".png", ".jpg", ".jpeg", ".webp"):
            ext = ".bin"
        dest = cache_dir / f"{media.cache_key(song_id, member)}{ext}"
        return media.cached_member_file(zip_path, member, dest)

    def _serve_static(self, rel: str) -> None:
        dest = media.safe_join(config.STATIC_DIR, rel or "index.html")
        if not dest.is_file():
            raise FileNotFoundError(rel)
        ctype = mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
        if dest.suffix in {".html", ".js", ".css"}:
            ctype += "; charset=utf-8"
        # 静态文件开发时改动频繁：用 ETag 重新校验，别让浏览器拿旧的 JS
        stat = dest.stat()
        tag = '"%s-%s"' % (int(stat.st_mtime), stat.st_size)
        if self.headers.get("If-None-Match") == tag:
            self.send_response(304)
            self.send_header("ETag", tag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        return media.stream_file(self, dest, ctype,
                                 {"ETag": tag, "Cache-Control": "no-cache"})

    def _serve_marker(self, rel: str) -> None:
        dest = markers.asset_path(rel)
        return media.stream_file(self, dest, media.guess_ctype(dest.name),
                                 {"Cache-Control": "public, max-age=300"})


def main() -> None:
    if not config.LIBRARY.is_dir():
        print(f"曲库目录不存在：{config.LIBRARY}", file=sys.stderr)
        print("把 .mcz 曲库放到仓库根目录的 music/，或用 JUBEAT_LIBRARY 指定路径。", file=sys.stderr)
        sys.exit(1)
    config.ensure_cache_dirs()
    LIB.load()
    print(f"jubeat 铺面查看器 → http://{config.HOST}:{config.PORT}/")
    print(f"曲库: {LIB.root}（{len(LIB.songs)} 首）")
    print(f"缓存: {config.CACHE_DIR} · 缩略图后端: {thumbs.backend()}"
          + (f" · X-Accel: {config.X_ACCEL_PREFIX}" if config.X_ACCEL_PREFIX else ""))
    httpd = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
