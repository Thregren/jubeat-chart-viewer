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

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "铺面查看器/player"))
import library
import markers
import media
import server
import thumbs
from source_revision import source_revision


def song():
    return {"id": "v/song.mcz", "title": "song", "artist": "artist", "version": "v",
            "charts": [{"code": "EXT", "file": "song_EXT Lv9.mc", "level": "9",
                        "notes": 1, "holds": 0, "levelNum": 9.0, "notesKnown": True}]}


class MediaIntegrity(unittest.TestCase):
    def test_thumbnail_route_refreshes_with_source_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "song.mcz"
            def archive(data):
                with zipfile.ZipFile(source, "w") as zipped:
                    zipped.writestr("jkt.png", data)
            archive(b"old cover")
            stamp = source.stat().st_mtime_ns
            handler = object.__new__(server.Handler)
            entry = {"id": "song.mcz", "cover": "jkt.png"}
            def encode(src, dest, size, quality):
                dest.write_bytes(src.read_bytes())
                return True
            with patch.object(server.config, "COVER_CACHE_DIR", root / "covers"), \
                    patch.object(server.config, "THUMB_CACHE_DIR", root / "thumbs"), \
                    patch.object(server.LIB, "mcz_path", return_value=source), \
                    patch.object(thumbs, "backend", return_value="pillow"), \
                    patch.object(thumbs, "_with_pillow", side_effect=encode) as encoder, \
                    patch.object(media, "stream_file", side_effect=lambda h, p, *a: p.read_bytes()):
                self.assertEqual(handler._serve_media("thumb", entry), b"old cover")
                archive(b"new cover")
                os.utime(source, ns=(stamp, stamp))
                self.assertEqual(handler._serve_media("thumb", entry), b"new cover")
                self.assertEqual(handler._serve_media("thumb", entry), b"new cover")
                self.assertEqual(encoder.call_count, 2)

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

    def test_member_cache_refreshes_after_old_timestamp_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest = Path(tmp) / "song.mcz", Path(tmp) / "audio.ogg"
            def archive(data):
                with zipfile.ZipFile(source, "w") as archive:
                    archive.writestr("bgm.ogg", data)
            archive(b"old audio")
            stamp = source.stat().st_mtime_ns
            media.cached_member_file(source, "bgm.ogg", dest)
            self.assertTrue(media.member_is_fresh(dest, source))
            archive(b"new audio")
            os.utime(source, ns=(stamp - 1_000_000, stamp - 1_000_000))
            self.assertFalse(media.member_is_fresh(dest, source))
            self.assertEqual(media.cached_member_file(source, "bgm.ogg", dest).read_bytes(), b"new audio")
            with patch.object(media.zipfile, "ZipFile", side_effect=AssertionError("fresh cache opened ZIP")):
                media.cached_member_file(source, "bgm.ogg", dest)
            dest.write_bytes(b"broken")
            self.assertFalse(media.member_is_fresh(dest, source))

    def test_unversioned_or_broken_metadata_is_not_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest = Path(tmp) / "song", Path(tmp) / "cache"
            source.write_bytes(b"source"); dest.write_bytes(b"cache")
            self.assertFalse(media.member_is_fresh(dest, source))
            for payload in ("[]", "null", "{", '{"source":[]}'):
                dest.with_name(dest.name + ".revision.json").write_text(payload)
                self.assertFalse(media.member_is_fresh(dest, source))

    def test_source_changed_during_extraction_does_not_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest = Path(tmp) / "song.mcz", Path(tmp) / "audio.ogg"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("bgm.ogg", b"new audio")
            dest.write_bytes(b"previous complete audio")
            with patch.object(media, "source_revision", side_effect=["before", "after"]):
                with self.assertRaises(OSError):
                    media.cached_member_file(source, "bgm.ogg", dest)
            self.assertEqual(dest.read_bytes(), b"previous complete audio")
            self.assertEqual(list(Path(tmp).glob("*.tmp-*")), [])

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
    def test_invalid_chart_fields_are_not_accepted(self):
        self.assertTrue(library.valid_cached_song(song()))
        invalid_charts = [{}, {"code": "EXT", "level": "9", "file": "x", "notes": []},
                          {"code": "EXT", "level": 9, "file": "x"},
                          {"code": "EXT", "level": "9", "file": "x", "levelNum": float("nan")}]
        for chart in invalid_charts:
            entry = song(); entry["charts"] = [chart]
            self.assertFalse(library.valid_cached_song(entry), repr(chart))

    def test_bad_cached_chart_is_rescanned_including_member_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "music" / "v" / "song.mcz"
            source.parent.mkdir(parents=True)
            chart = {"meta": {"song": {"title": "song"}}, "note": [{"index": 0}]}
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("song_EXT Lv9.mc", json.dumps(chart))
            cache = root / "index.json"
            with patch.object(library.config, "INDEX_CACHE", cache):
                initial = library.Library(root / "music"); initial.load()
                raw = json.loads(cache.read_text())
                raw["songs"][0]["charts"] = [{}]
                raw["members"]["v/song.mcz"]["song"]["charts"] = [{}]
                cache.write_text(json.dumps(raw))
                rebuilt = library.Library(root / "music")
                with patch.object(library, "scan_song", wraps=library.scan_song) as scan:
                    rebuilt.load()
                    self.assertEqual(scan.call_count, 1)
                self.assertEqual(rebuilt.songs[0]["charts"][0]["code"], "EXT")

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
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(markers, "MARKERS_ROOT", Path(tmp)), \
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


if __name__ == "__main__":
    unittest.main()
