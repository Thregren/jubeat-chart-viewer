"""Media revisions, atomic publication and persistent HTTP response regressions."""
from __future__ import annotations

import concurrent.futures
import contextlib
import gzip
import http.client
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "jubeat_viewer/player"))
import library
import markers
import media
import server
import thumbs
from source_revision import source_revision


def song():
    return {"id": "v/song", "title": "song", "artist": "artist", "version": "v",
            "assets": {"audio": "songs/v/song/bgm.wav", "cover": "songs/v/song/cover.png",
                       "chart:EXT": "songs/v/song/charts/EXT.json"},
            "charts": [{"code": "EXT", "level": "9",
                        "notes": 1, "holds": 0, "levelNum": 9.0, "notesKnown": True}]}


class MediaIntegrity(unittest.TestCase):
    def test_thumbnail_route_refreshes_with_source_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cover = root / "cover.png"
            cover.write_bytes(b"old cover")
            stamp = cover.stat().st_mtime_ns
            handler = object.__new__(server.Handler)
            entry = {"id": "v/song", "assets": {"cover": "cover.png"}}
            def resolve(song_entry, key):
                return cover if key == "cover" else None
            def encode(src, dest, size, quality):
                dest.write_bytes(src.read_bytes())
                return True
            with patch.object(server.config, "THUMB_CACHE_DIR", root / "thumbs"), \
                    patch.object(server.LIB, "asset_file", side_effect=resolve), \
                    patch.object(thumbs, "backend", return_value="pillow"), \
                    patch.object(thumbs, "_with_pillow", side_effect=encode) as encoder, \
                    patch.object(media, "stream_file", side_effect=lambda h, p, *a: p.read_bytes()):
                self.assertEqual(handler._serve_media("thumb", entry), b"old cover")
                cover.write_bytes(b"new cover")
                os.utime(cover, ns=(stamp, stamp))
                self.assertEqual(handler._serve_media("thumb", entry), b"new cover")
                self.assertEqual(handler._serve_media("thumb", entry), b"new cover")
                self.assertEqual(encoder.call_count, 2)

    def test_thumbnail_uses_provided_asset_without_encoding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cover = root / "cover.png"; cover.write_bytes(b"cover")
            thumb = root / "thumb.jpg"; thumb.write_bytes(b"\xff\xd8thumb")
            handler = object.__new__(server.Handler)
            entry = {"id": "v/song", "assets": {"cover": "cover.png", "thumb": "thumb.jpg"}}
            files = {"cover": cover, "thumb": thumb}
            with patch.object(server.LIB, "asset_file", side_effect=lambda s, k: files.get(k)), \
                    patch.object(thumbs, "_with_pillow", side_effect=AssertionError("re-encoded")), \
                    patch.object(media, "stream_file", side_effect=lambda h, p, *a: p.read_bytes()):
                self.assertEqual(handler._serve_media("thumb", entry), b"\xff\xd8thumb")

    def test_source_revision_changes_for_preserved_mtime_and_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source"
            path.write_bytes(b"old")
            stamp = path.stat().st_mtime_ns
            initial = source_revision(path)
            path.write_bytes(b"new")
            os.utime(path, ns=(stamp, stamp))
            edited = source_revision(path)
            self.assertNotEqual(initial, edited)
            replacement = path.with_name("replacement")
            replacement.write_bytes(b"new")
            os.utime(replacement, ns=(stamp, stamp))
            os.replace(replacement, path)
            self.assertNotEqual(edited, source_revision(path))

    def test_unversioned_or_broken_metadata_is_not_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest = Path(tmp) / "song", Path(tmp) / "cache"
            source.write_bytes(b"source"); dest.write_bytes(b"cache")
            self.assertFalse(media.member_is_fresh(dest, source))
            for payload in ("[]", "null", "{", '{"source":[]}'):
                dest.with_name(dest.name + ".revision.json").write_text(payload)
                self.assertFalse(media.member_is_fresh(dest, source))

    def test_thumbnail_is_published_only_after_encoder_finishes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest = Path(tmp) / "cover", Path(tmp) / "thumb.jpg"
            source.write_bytes(b"cover"); dest.write_bytes(b"old complete image")
            started, release = threading.Event(), threading.Event()
            def encode(src, target, size, quality):
                target.write_bytes(b"partial image")
                started.set()
                if not release.wait(3):
                    raise RuntimeError("test encoder timeout")
                target.write_bytes(b"new complete image")
                return True
            with patch.object(thumbs, "backend", return_value="pillow"), \
                    patch.object(thumbs, "_with_pillow", side_effect=encode), \
                    concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                job = pool.submit(thumbs.make, source, dest, 96, 82)
                try:
                    self.assertTrue(started.wait(3))
                    self.assertEqual(dest.read_bytes(), b"old complete image")
                finally:
                    release.set()
                self.assertTrue(job.result(timeout=3))
            self.assertEqual(dest.read_bytes(), b"new complete image")
            self.assertEqual(list(Path(tmp).glob("*.tmp-*")), [])

    def test_thumbnail_failed_encode_preserves_previous_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest = Path(tmp) / "cover", Path(tmp) / "thumb.jpg"
            source.write_bytes(b"cover"); dest.write_bytes(b"complete")
            def fail(src, target, size, quality):
                target.write_bytes(b"partial")
                raise OSError("full disk")
            with patch.object(thumbs, "backend", return_value="pillow"), \
                    patch.object(thumbs, "_with_pillow", side_effect=fail):
                self.assertFalse(thumbs.make(source, dest, 96, 82))
            self.assertEqual(dest.read_bytes(), b"complete")
            self.assertEqual(list(Path(tmp).glob("*.tmp-*")), [])

    def test_stream_uses_open_inode_when_path_is_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "audio"
            source.write_bytes(b"old body")
            handler = FileHandler()
            def replace():
                replacement = source.with_name("new")
                replacement.write_bytes(b"new longer body")
                os.replace(replacement, source)
            handler.end_headers = replace
            media.stream_file(handler, source, "audio/ogg")
            self.assertEqual(handler.wfile.getvalue(), b"old body")
            self.assertEqual(handler.sent_headers["Content-Length"], "8")

    def test_stream_short_read_closes_persistent_connection(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "audio"
            source.write_bytes(b"0123456789")
            handler = FileHandler()
            handler.end_headers = lambda: source.write_bytes(b"12")
            media.stream_file(handler, source, "audio/ogg")
            self.assertEqual(handler.sent_headers["Content-Length"], "10")
            self.assertEqual(handler.wfile.getvalue(), b"12")
            self.assertTrue(handler.close_connection)


class FileHandler:
    command = "GET"
    def __init__(self):
        self.headers = {}
        self.sent_headers = {}
        self.wfile = io.BytesIO()
        self.close_connection = False
    def send_response(self, code):
        self.status = code
    def send_header(self, key, value):
        self.sent_headers[key] = value
    def end_headers(self):
        pass


class IndexIntegrity(unittest.TestCase):
    def test_public_response_is_reused_until_index_changes(self):
        lib = library.Library(Path("unused"))
        lib._install([song()])
        first = lib.published_response()
        with patch.object(library, "published_index", side_effect=AssertionError("projection repeated")), \
                patch.object(library.gzip, "compress", side_effect=AssertionError("gzip repeated")):
            for _ in range(10):
                self.assertIs(lib.published_response(), first)
        self.assertEqual(gzip.decompress(first[1]), first[0])
        changed = song(); changed["title"] = "updated"
        lib._install([changed])
        self.assertNotEqual(lib.published_response()[2], first[2])

    def test_marker_errors_hide_paths(self):
        # config.MARKERS_ROOT is lazy (PEP 562); patch its resolver instead of
        # a module-level constant that no longer exists.
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(markers.config, "markers_root", lambda: Path(tmp)), \
                patch.object(markers, "_cache", {}), contextlib.redirect_stderr(io.StringIO()):
            self.assertNotIn(tmp, json.dumps(markers.manifest()))
            (Path(tmp) / "manifest.json").write_text("{")
            self.assertNotIn(tmp, json.dumps(markers.manifest()))
            self.assertEqual(markers.manifest()["error"], "marker 清单不可用")


class HttpIntegrity(unittest.TestCase):
    def setUp(self):
        self.lib = library.Library(Path("unused"))
        self.lib._install([song() for _ in range(12)])
        class QuietHandler(server.Handler):
            def log_message(self, *args):
                pass
            def _route(self, parsed):
                if parsed.path == "/ok":
                    return self._send_bytes(200, b"ok", "text/plain")
                if parsed.path == "/missing":
                    raise FileNotFoundError("/private/local/secret/file")
                if parsed.path == "/invalid":
                    raise ValueError("/private/local/secret/chart")
                return super()._route(parsed)
        self.httpd = server.BoundedHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.client = http.client.HTTPConnection(*self.httpd.server_address, timeout=3)
        self.patch_lib = patch.object(server, "LIB", self.lib)
        self.patch_lib.start()

    def tearDown(self):
        self.client.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(3)
        self.patch_lib.stop()

    def request(self, method, path, headers=None):
        self.client.request(method, path, headers=headers or {})
        response = self.client.getresponse()
        return response.status, dict(response.getheaders()), response.read()

    def test_keepalive_errors_return_status_and_hide_paths(self):
        self.assertEqual(self.request("GET", "/ok")[0], 200)
        with contextlib.redirect_stderr(io.StringIO()):
            for path, expected in (("/missing", 404), ("/invalid", 400)):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, expected)
                self.assertNotIn(b"/private", body)
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertIn("ref", json.loads(body))
        self.assertEqual(self.request("GET", "/ok")[0], 200)

    def test_library_get_head_and_304_use_precomputed_response(self):
        raw, compressed, tag = self.lib.published_response()
        with patch.object(server.json, "dumps", side_effect=AssertionError("request serialized JSON")), \
                patch.object(server.gzip, "compress", side_effect=AssertionError("request compressed JSON")):
            status, headers, body = self.request("GET", "/data/library.json", {"Accept-Encoding": "gzip"})
            self.assertEqual((status, body), (200, compressed))
            self.assertEqual(headers["ETag"], tag)
            self.assertEqual(headers["Vary"], "Accept-Encoding")
            status, headers, body = self.request("HEAD", "/data/library.json")
            self.assertEqual((status, body, headers["Content-Length"]), (200, b"", str(len(raw))))
            status, headers, body = self.request("GET", "/data/library.json", {"If-None-Match": tag})
            self.assertEqual((status, body), (304, b""))
            self.assertEqual(headers["Vary"], "Accept-Encoding")
            status, _, body = self.request("GET", "/data/library.json")
            self.assertEqual((status, body), (200, raw))


class AssetRoutes(unittest.TestCase):
    """目录曲库：谱面 / 音源 / 封面都按索引里的 assets 直接读文件。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.root = root
        folder = root / "songs" / "v" / "song"
        (folder / "charts").mkdir(parents=True)
        (folder / "charts" / "EXT.json").write_text(json.dumps({"note": [{"index": 0}]}), encoding="utf-8")
        (folder / "bgm.wav").write_bytes(b"RIFF" + b"\0" * 4096)
        (folder / "cover.png").write_bytes(b"\x89PNG" + b"\0" * 256)
        entry = {"id": "v/song", "title": "song", "artist": "artist", "version": "v",
                 "charts": [{"code": "EXT", "level": "9", "notes": 1, "holds": 0}],
                 "assets": {"audio": "songs/v/song/bgm.wav", "cover": "songs/v/song/cover.png",
                            "chart:EXT": "songs/v/song/charts/EXT.json"}}
        (root / "data").mkdir()
        (root / "data" / "library.json").write_text(json.dumps({
            "format": "jubeat-directory-v1", "songs": [entry], "versions": ["v"],
            "versionIndexes": []}), encoding="utf-8")
        self.lib = library.Library(root)
        self.lib.load()
        class QuietHandler(server.Handler):
            def log_message(self, *args):
                pass
        self.httpd = server.BoundedHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.patch_lib = patch.object(server, "LIB", self.lib)
        self.patch_lib.start()
        self.client = http.client.HTTPConnection(*self.httpd.server_address, timeout=3)

    def tearDown(self):
        self.client.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(3)
        self.patch_lib.stop()
        self.tmp.cleanup()

    def request(self, path, headers=None, method="GET"):
        self.client.request(method, path, headers=headers or {})
        response = self.client.getresponse()
        return response.status, dict(response.getheaders()), response.read()

    def test_chart_audio_and_cover_come_from_declared_assets(self):
        status, headers, body = self.request("/data/charts/v/song/EXT.json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["note"], [{"index": 0}])
        self.assertEqual(headers["Cache-Control"], "public, max-age=86400")

        status, headers, body = self.request("/media/audio/v/song.wav")
        self.assertEqual((status, len(body)), (200, 4100))
        self.assertEqual(headers["Accept-Ranges"], "bytes")

        status, headers, body = self.request("/media/audio/v/song.wav", {"Range": "bytes=0-3"})
        self.assertEqual((status, body), (206, b"RIFF"))
        self.assertEqual(headers["Content-Range"], "bytes 0-3/4100")

        status, _, body = self.request("/media/cover/v/song.png")
        self.assertEqual((status, body[:4]), (200, b"\x89PNG"))

        status, _, body = self.request("/songs/v/song/bgm.wav")
        self.assertEqual((status, len(body)), (200, 4100))

    def test_undeclared_asset_is_not_served(self):
        (self.root / "songs" / "v" / "song" / "secret.txt").write_text("nope", encoding="utf-8")
        status, _, _ = self.request("/songs/v/song/secret.txt")
        self.assertEqual(status, 404)
        status, _, _ = self.request("/data/charts/v/song/BSC.json")
        self.assertEqual(status, 404)

    def test_security_headers_include_csp(self):
        status, headers, _ = self.request("/data/library.json")
        self.assertEqual(status, 200)
        csp = headers.get("Content-Security-Policy", "")
        self.assertIn("default-src 'self'", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertNotIn("unsafe-inline", csp)


if __name__ == "__main__":
    unittest.main()
