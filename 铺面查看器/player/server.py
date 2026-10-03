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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import config
import markers
import media
import thumbs
from library import Library, published_index

JSON_CT = "application/json; charset=utf-8"

LIB = Library()


class Handler(BaseHTTPRequestHandler):
    # 版本号来自仓库根的 VERSION（见版本单一来源）；顺手把 Python 版本藏掉：
    # Server 头里报出解释器版本等于给扫描器送指纹。
    server_version = f"JubeatViewer/{config.APP_VERSION}"
    sys_version = ""
    protocol_version = "HTTP/1.1"  # 开 keep-alive：境外高延迟下差别很大

    # 每个响应都带的头（_send_bytes 里 setdefault，调用方可以覆盖）
    BASE_HEADERS = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "SAMEORIGIN",
        "Cross-Origin-Opener-Policy": "same-origin",
    }

    # —— 基础输出 ——
    def log_message(self, fmt: str, *args) -> None:
        # args[0] 是格式化模板（'"%s" %s %s'），请求行在 self.path 上 ——
        # 以前拿 args[0] 去匹配路径，永远匹配不上，等于这段过滤根本没生效。
        path = self.path or ""
        if "/api/library" in path or "/api/health" in path:
            return
        super().log_message(fmt, *args)

    def send_response(self, code: int, message: str | None = None) -> None:
        # 只要开始写响应头，这条连接上就不能再发第二个响应了（HTTP/1.1 会把两个
        # 响应拼在一起，客户端解析成乱码）。do_GET 的异常兜底靠这个标志决定
        # 「回一个 JSON 错误」还是「只能断开连接」。
        self._responded = True
        super().send_response(code, message)

    def _accepts_gzip(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _send_bytes(self, code: int, body: bytes, ctype: str,
                    extra: dict | None = None, compress: bool = False) -> None:
        headers = dict(self.BASE_HEADERS)
        headers.update(extra or {})
        if compress and len(body) >= config.GZIP_MIN_BYTES and self._accepts_gzip():
            body = gzip.compress(body, compresslevel=6)
            headers["Content-Encoding"] = "gzip"
            headers["Vary"] = "Accept-Encoding"
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
                for k, v in self.BASE_HEADERS.items():
                    self.send_header(k, v)
                self.end_headers()
                return
            extra["ETag"] = tag
        self._send_bytes(code, body, JSON_CT, extra, compress=True)

    def _error(self, message: str, code: int = 400) -> None:
        self._json({"error": message}, code)

    def _fail(self, message: object, code: int) -> None:
        """出错时回一个 JSON 错误 —— 但仅限于「还没开始写响应」的时候。

        响应已经发出去（文件传到一半断了 / 缓存文件在 stat 之后被删掉），再补一个
        404/500 就是把两个响应叠在同一条 keep-alive 连接上。这种情况只能把连接
        关掉，让客户端自己重试。
        """
        if getattr(self, "_responded", False):
            self.close_connection = True
            return
        self._error(str(message) or "error", code)

    def _hdr(self, extra: dict | None = None) -> dict:
        """给要用 media.stream_file 直接发文件的响应凑一份带头（含安全头）。"""
        headers = dict(self.BASE_HEADERS)
        headers.update(extra or {})
        return headers

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
            self._fail(exc, 404)
        except (ValueError, KeyError) as exc:
            self._fail(exc, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端提前断开（拖进度条时很常见）
        except Exception:  # 兜底：别因为单个请求把线程打挂
            # 500 只回一个引用号：异常原文里可能带本机绝对路径（曲库 / 缓存目录），
            # 这个服务是会被 nginx 反代到公网的。完整堆栈进 stderr 给运维看。
            ref = os.urandom(4).hex()
            traceback.print_exc()
            try:
                print(f"[500 {ref}] {self.command} {self.path}", file=sys.stderr)
                if getattr(self, "_responded", False):
                    self.close_connection = True
                else:
                    self._json({"error": "internal error", "ref": ref}, 500, cache="no-store")
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
        if path.startswith("/media/se/"):
            return self._se_file(path[len("/media/se/"):])

        if path == "/api/health":  # 运维用，静态站点没有这个（nginx 里可以直接排除）
            return self._api_health()
        return self._error("not found", 404)

    # —— API ——
    def _api_health(self) -> None:
        LIB.load()
        # 物量读不出来的难度（坏 zip / 谱面 json 解析失败）：健康检查要能一眼看出
        unknown = sum(1 for s in LIB.songs for c in s["charts"] if not c.get("notesKnown", True))
        return self._json({
            "ok": True,
            "version": config.APP_VERSION,
            # 不回本机绝对路径 / 缓存目录：这个接口会被 nginx 反代出去
            "songs": len(LIB.songs),
            "unreadable_charts": unknown,
            "index_version": config.INDEX_VERSION,
            "cache": config.CACHE_DIR.name,
            "thumb_backend": thumbs.backend(),
            "thumb_size": config.THUMB_SIZE,
            "x_accel": config.X_ACCEL_PREFIX or None,
            # 清单是「一套设计一个入口」（designs）；旧字段 "markers" 在改版后就一直
            # 是 0，健康检查会把「45 套素材都在」误报成「一套都没有」。
            "markers": len(markers.manifest().get("designs") or []),
        })

    def _data_library(self) -> None:
        LIB.load()
        # 和 static 站同一个形状：只发前端要读的字段（见 library.published_index）
        return self._json(published_index(LIB.songs))

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

    def _se_file(self, rel: str) -> None:
        """media/se/<名字>.<ext>：可选的打点音素材，直接从仓库根目录 se/ 读（不入库）。"""
        name = media.unquote_path(rel)
        if not name or "/" in name or name.startswith("."):
            raise FileNotFoundError(name)
        path = (config.SE_DIR / name).resolve()
        if config.SE_DIR.resolve() not in path.parents or not path.is_file():
            raise FileNotFoundError(name)
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return media.stream_file(self, path, ctype,
                                 self._hdr({"Cache-Control": "public, max-age=86400"}))

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
                                     self._hdr({"Cache-Control": "public, max-age=604800"}))

        # thumb：没有可用的图像库就直接把原图发出去
        if thumbs.backend() == "none":
            return media.stream_file(self, cover, media.guess_ctype(member),
                                     self._hdr({"Cache-Control": "public, max-age=604800"}))
        size = config.THUMB_SIZE
        thumb = config.THUMB_CACHE_DIR / f"{media.cache_key(song['id'], member, str(size))}.jpg"
        if not media.member_is_fresh(thumb, zip_path):
            with media.lock_for(str(thumb)):
                if not media.member_is_fresh(thumb, zip_path):
                    if not thumbs.make(cover, thumb, size, config.THUMB_QUALITY):
                        return media.stream_file(
                            self, cover, media.guess_ctype(member),
                            self._hdr({"Cache-Control": "public, max-age=604800"}))
        return media.stream_file(self, thumb, "image/jpeg",
                                 self._hdr({"Cache-Control": "public, max-age=604800"}))

    def _send_audio(self, dest: Path, ctype: str, cache: str) -> None:
        if config.X_ACCEL_PREFIX:
            # 交给 nginx 直接发文件：Range/断点/大文件都不再经过 Python
            self.send_response(200)
            self.send_header("X-Accel-Redirect", f"{config.X_ACCEL_PREFIX}{dest.name}")
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Length", "0")
            for k, v in self.BASE_HEADERS.items():
                self.send_header(k, v)
            self.end_headers()
            return
        return media.stream_file(self, dest, ctype, self._hdr({"Cache-Control": cache}))

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
            for k, v in self.BASE_HEADERS.items():
                self.send_header(k, v)
            self.end_headers()
            return
        return media.stream_file(self, dest, ctype,
                                 self._hdr({"ETag": tag, "Cache-Control": "no-cache"}))

    def _serve_marker(self, rel: str) -> None:
        dest = markers.asset_path(rel)
        return media.stream_file(self, dest, media.guess_ctype(dest.name),
                                 self._hdr({"Cache-Control": "public, max-age=300"}))


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
