#!/usr/bin/env python3
"""jubeat 铺面确认 — local library server."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import threading
import zipfile
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
REPO = PROJECT.parent
LIBRARY_NAME = "music"  # 曲库固定放在仓库根目录的 music/（不随仓库上传）
LEGACY_LIBRARY_NAMES = ("Jubeat2Malody-GUI-mcz-releases",)
STATIC = ROOT / "static"
CACHE = ROOT / ".library_index.json"
HOST = "127.0.0.1"
PORT = int(os.environ.get("JUBEAT_PORT", "8765"))
MARKERS_NAME = "jubeat_marker_frames"


def resolve_library() -> Path:
    """Locate the .mcz library.

    The project has been moved around a few times, so try, in order:
    JUBEAT_LIBRARY env var, in-repo, the known sibling checkout, home folders.
    """
    candidates = []
    env = os.environ.get("JUBEAT_LIBRARY")
    if env:
        candidates.append(Path(env).expanduser())
    candidates += [
        PROJECT / LIBRARY_NAME,
        REPO / LIBRARY_NAME,
        *(REPO / name for name in LEGACY_LIBRARY_NAMES),
        *(Path.home() / "XiaomiMiMoProjects" / "jubeat铺面播放" / name
          for name in (LIBRARY_NAME, *LEGACY_LIBRARY_NAMES)),
        Path.home() / "Documents" / LIBRARY_NAME,
        Path.home() / "Downloads" / LIBRARY_NAME,
    ]
    for parent in (REPO, REPO.parent, Path.home() / "Documents"):
        try:
            candidates += sorted(parent.glob(f"*/{LIBRARY_NAME}"))
            candidates += sorted(parent.glob(f"*/{LEGACY_LIBRARY_NAMES[0]}"))
        except OSError:
            pass
    seen = set()
    for cand in candidates:
        try:
            key = str(cand)
            if key in seen:
                continue
            seen.add(key)
            if cand.is_dir() and any(cand.glob("**/*.mcz")):
                return cand.resolve()
        except OSError:
            continue
    return (PROJECT / LIBRARY_NAME).resolve()


def resolve_markers() -> Path:
    env = os.environ.get("JUBEAT_MARKERS")
    if env:
        return Path(env).expanduser().resolve()
    for cand in (REPO / "marker" / MARKERS_NAME, PROJECT / MARKERS_NAME, REPO / MARKERS_NAME):
        if (cand / "manifest.json").is_file() or (cand / "markers").is_dir():
            return cand.resolve()
    return (REPO / "marker" / MARKERS_NAME).resolve()


LIBRARY = resolve_library()
MARKERS_ROOT = resolve_markers()

DIFF_RE = re.compile(r"_([A-Z]{3})\s*Lv([0-9]+(?:\.[0-9]+)?)", re.I)
DIFF_ORDER = {"BSC": 0, "BAS": 0, "ADV": 1, "EXT": 2}


def zip_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    raw = name.encode("cp437")
    for enc in ("utf-8", "shift_jis", "cp932"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return name


def parse_chart_name(filename: str) -> tuple[str, str, float] | None:
    m = DIFF_RE.search(filename)
    if not m:
        return None
    code = m.group(1).upper()
    try:
        level = float(m.group(2))
    except ValueError:
        level = 0.0
    return code, m.group(2), level


def read_zip_json_and_meta(mcz_path: Path) -> dict | None:
    try:
        with zipfile.ZipFile(mcz_path) as zf:
            charts = []
            audio = None
            cover = None
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = zip_name(info)
                base = os.path.basename(name)
                if base.lower() == "bgm.ogg" or (
                    audio is None and base.lower().endswith((".ogg", ".mp3", ".wav"))
                ):
                    if base.lower() == "bgm.ogg" or audio is None:
                        audio = name if base.lower() == "bgm.ogg" else (audio or name)
                if base.lower().endswith((".png", ".jpg", ".jpeg")) and cover is None:
                    if base.lower().startswith("jkt") or "jkt" in base.lower():
                        cover = name
                    elif cover is None and not name.startswith("."):
                        cover = name
                if name.lower().endswith(".mc"):
                    parsed = parse_chart_name(base)
                    if not parsed:
                        continue
                    code, level_str, level = parsed
                    # light meta only — do not load full chart during index
                    title = base
                    # Title_EXT Lv10.4.mc
                    title = DIFF_RE.sub("", base)
                    if title.endswith(".mc"):
                        title = title[:-3]
                    title = title.rstrip("_ ")
                    charts.append(
                        {
                            "file": name,
                            "code": code,
                            "level": level_str,
                            "levelNum": level,
                            "label": f"{code} Lv{level_str}",
                        }
                    )
            if not charts:
                return None
            charts.sort(key=lambda c: (DIFF_ORDER.get(c["code"], 9), c["levelNum"], c["code"]))
            # resolve audio/cover preference
            names = [zip_name(i) for i in zf.infolist() if not i.is_dir()]
            audio = next((n for n in names if os.path.basename(n).lower() == "bgm.ogg"), None)
            if audio is None:
                audio = next(
                    (n for n in names if n.lower().endswith((".ogg", ".mp3", ".wav"))), None
                )
            covers = [
                n
                for n in names
                if n.lower().endswith((".png", ".jpg", ".jpeg"))
                and os.path.basename(n).lower().startswith("jkt")
            ]
            if not covers:
                covers = [n for n in names if n.lower().endswith((".png", ".jpg", ".jpeg"))]
            cover = covers[0] if covers else None

            # read title/artist from first chart header (small read)
            title = mcz_path.stem
            artist = ""
            version_dir = mcz_path.parent.name
            try:
                with zf.open(charts[-1]["file"]) as fh:
                    # read only a prefix for meta
                    head = fh.read(4096).decode("utf-8", errors="replace")
                # find song block roughly
                tm = re.search(r'"title"\s*:\s*"((?:\\.|[^"\\])*)"', head)
                am = re.search(r'"artist"\s*:\s*"((?:\\.|[^"\\])*)"', head)
                if tm:
                    title = json.loads(f'"{tm.group(1)}"')
                if am:
                    artist = json.loads(f'"{am.group(1)}"')
            except Exception:
                pass

            return {
                "id": str(mcz_path.relative_to(LIBRARY).as_posix()),
                "path": str(mcz_path.relative_to(LIBRARY).as_posix()),
                "filename": mcz_path.name,
                "title": title,
                "artist": artist,
                "version": version_dir,
                "audio": audio,
                "cover": cover,
                "charts": charts,
                "size": mcz_path.stat().st_size,
            }
    except Exception as exc:
        print(f"[index] skip {mcz_path.name}: {exc}", file=sys.stderr)
        return None


def build_index(force: bool = False) -> list[dict]:
    if not force and CACHE.exists():
        try:
            data = json.loads(CACHE.read_text(encoding="utf-8"))
            if data.get("library") == str(LIBRARY) and data.get("songs"):
                return data["songs"]
        except Exception:
            pass
    print(f"[index] scanning {LIBRARY} …", file=sys.stderr)
    songs = []
    if LIBRARY.is_dir():
        for path in sorted(LIBRARY.rglob("*.mcz")):
            meta = read_zip_json_and_meta(path)
            if meta:
                songs.append(meta)
    songs.sort(key=lambda s: (s["title"].lower(), s["version"]))
    CACHE.write_text(
        json.dumps({"library": str(LIBRARY), "songs": songs}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"[index] {len(songs)} songs cached", file=sys.stderr)
    return songs


SONGS: list[dict] = []
SONGS_BY_ID: dict[str, dict] = {}
_lock = threading.Lock()


def ensure_index(force: bool = False) -> None:
    global SONGS, SONGS_BY_ID
    with _lock:
        if force or not SONGS:
            SONGS = build_index(force=force)
            SONGS_BY_ID = {s["id"]: s for s in SONGS}


def safe_library_path(rel: str) -> Path:
    rel = unquote(rel).lstrip("/")
    dest = (LIBRARY / rel).resolve()
    if not str(dest).startswith(str(LIBRARY.resolve())):
        raise ValueError("path escapes library")
    if not dest.is_file():
        raise FileNotFoundError(rel)
    return dest


def load_chart(rel_mcz: str, chart_file: str) -> dict:
    path = safe_library_path(rel_mcz)
    with zipfile.ZipFile(path) as zf:
        wanted = None
        for info in zf.infolist():
            if zip_name(info) == chart_file:
                wanted = info
                break
        if wanted is None:
            # try basename match
            for info in zf.infolist():
                if os.path.basename(zip_name(info)) == os.path.basename(chart_file):
                    wanted = info
                    break
        if wanted is None:
            raise FileNotFoundError(chart_file)
        raw = zf.read(wanted)
    return json.loads(raw.decode("utf-8"))


def zip_member_bytes(rel_mcz: str, member: str) -> tuple[bytes, str]:
    path = safe_library_path(rel_mcz)
    with zipfile.ZipFile(path) as zf:
        info = None
        for i in zf.infolist():
            if zip_name(i) == member or i.filename == member:
                info = i
                break
        if info is None:
            for i in zf.infolist():
                if os.path.basename(zip_name(i)) == os.path.basename(member):
                    info = i
                    break
        if info is None:
            raise FileNotFoundError(member)
        data = zf.read(info)
    ctype = mimetypes.guess_type(member)[0] or "application/octet-stream"
    return data, ctype


# 歌曲列表里每首都要一张封面缩略图，缓存一下省得反复开 zip
_COVER_CACHE: "OrderedDict[tuple[str, str], tuple[bytes, str]]" = OrderedDict()
_COVER_CACHE_MAX = 400


def cover_bytes(rel_mcz: str, member: str) -> tuple[bytes, str]:
    key = (rel_mcz, member)
    hit = _COVER_CACHE.get(key)
    if hit is not None:
        _COVER_CACHE.move_to_end(key)
        return hit
    data, ctype = zip_member_bytes(rel_mcz, member)
    _COVER_CACHE[key] = (data, ctype)
    while len(_COVER_CACHE) > _COVER_CACHE_MAX:
        _COVER_CACHE.popitem(last=False)
    return data, ctype


_MARKER_CACHE: dict = {}


def marker_manifest() -> dict:
    """Marker assets for the pad animation (PERFECT-anchored frames)."""
    manifest = MARKERS_ROOT / "manifest.json"
    try:
        stamp = manifest.stat().st_mtime_ns
    except OSError:
        stamp = 0
    if _MARKER_CACHE.get("root") == str(MARKERS_ROOT) and _MARKER_CACHE.get("stamp") == stamp:
        return _MARKER_CACHE["data"]
    data = {"root": str(MARKERS_ROOT), "fps": 30, "markers": [], "effects": [], "error": None}
    if manifest.is_file():
        try:
            raw = json.loads(manifest.read_text(encoding="utf-8"))
            data.update(
                fps=raw.get("fps", 30),
                markers=raw.get("markers") or [],
                effects=raw.get("effects") or [],
                anchor_rule=raw.get("anchor_rule", ""),
            )
        except Exception as exc:
            data["error"] = f"manifest.json: {exc}"
    elif (MARKERS_ROOT / "markers").is_dir():
        # fallback: 逐目录读 meta.json（没有预设锚点，用最后一帧）
        for folder, key in (("markers", "markers"), ("effects", "effects")):
            base = MARKERS_ROOT / folder
            if not base.is_dir():
                continue
            for d in sorted(base.iterdir()):
                meta_path = d / "meta.json"
                if not d.is_dir() or not meta_path.is_file() or " 2." in meta_path.name:
                    continue
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except Exception:
                    continue
                frames = meta.get("frames")
                cell = (meta.get("frame_size") or [0])[0]
                cols, rows = meta.get("sheet_grid") or [5, None]
                if not frames or not cell or not (d / "sprite_sheet.png").is_file():
                    continue
                data[key].append(
                    {
                        "id": meta.get("id") or d.name,
                        "name": meta.get("name") or d.name,
                        "note": meta.get("note", ""),
                        "source": meta.get("source", ""),
                        "kind": "effect" if folder == "effects" else "marker",
                        "frames": frames,
                        "cell": cell,
                        "cols": cols,
                        "rows": rows,
                        "sheet": f"{folder}/{d.name}/sprite_sheet.png",
                        "anchor": frames - 1,
                        "hit": None,
                    }
                )
    else:
        data["error"] = f"marker 目录不存在：{MARKERS_ROOT}"
    _MARKER_CACHE["root"] = str(MARKERS_ROOT)
    _MARKER_CACHE["stamp"] = stamp
    _MARKER_CACHE["data"] = data
    return data


def marker_asset(rel: str) -> Path:
    rel = unquote(rel).lstrip("/")
    dest = (MARKERS_ROOT / rel).resolve()
    if not str(dest).startswith(str(MARKERS_ROOT.resolve())) or not dest.is_file():
        raise FileNotFoundError(rel)
    if " 2." in dest.name:  # macOS 复制产生的重名副本
        raise FileNotFoundError(rel)
    return dest


def parse_range(header: str, size: int) -> tuple[int, int] | None:
    """Return inclusive (start, end) for a single-range Range header."""
    if not header or not header.startswith("bytes="):
        return None
    spec = header.split("=", 1)[1].strip()
    if "," in spec:
        return None  # multi-range unsupported
    if "-" not in spec:
        return None
    start_s, end_s = spec.split("-", 1)
    try:
        if start_s == "":
            # suffix: last N bytes
            n = int(end_s)
            if n <= 0:
                return None
            start = max(0, size - n)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
    except ValueError:
        return None
    if start < 0 or start >= size:
        return None
    end = min(end, size - 1)
    if end < start:
        return None
    return start, end


class Handler(BaseHTTPRequestHandler):
    server_version = "JubeatPlayer/1.0"

    def log_message(self, fmt: str, *args) -> None:
        if "/api/library" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)

    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8", extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_media(self, data: bytes, ctype: str) -> None:
        """Send binary media with HTTP Range support (required for audio seek)."""
        size = len(data)
        rng = parse_range(self.headers.get("Range", ""), size)
        common = {
            "Content-Type": ctype,
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        }
        if rng is None:
            self.send_response(200)
            for k, v in common.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(size))
            self.end_headers()
            self.wfile.write(data)
            return
        start, end = rng
        chunk = data[start : end + 1]
        self.send_response(206)
        for k, v in common.items():
            self.send_header(k, v)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        self.wfile.write(chunk)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _error(self, message: str, code: int = 400) -> None:
        self._json({"error": message}, code)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        try:
            if path in ("/", "/index.html"):
                return self._serve_static("index.html")
            if path.startswith("/static/"):
                return self._serve_static(path[len("/static/") :])
            if path.startswith("/markers/"):
                dest = marker_asset(path[len("/markers/") :])
                data = dest.read_bytes()
                ctype = mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
                return self._send(200, data, ctype, {"Cache-Control": "public, max-age=3600"})
            if path == "/api/markers":
                return self._json(marker_manifest())
            if path == "/api/library":
                ensure_index()
                q = (qs.get("q", [""])[0] or "").lower()
                ver = qs.get("version", [""])[0]
                songs = SONGS
                if ver:
                    songs = [s for s in songs if s["version"] == ver]
                if q:
                    songs = [
                        s
                        for s in songs
                        if q in s["title"].lower()
                        or q in s["artist"].lower()
                        or q in s["filename"].lower()
                        or q in s["version"].lower()
                    ]
                versions = sorted({s["version"] for s in SONGS})
                return self._json(
                    {
                        "total": len(SONGS),
                        "filtered": len(songs),
                        "versions": versions,
                        "library": str(LIBRARY),
                        "songs": songs,
                    }
                )
            if path == "/api/reindex":
                ensure_index(force=True)
                return self._json({"total": len(SONGS)})
            if path == "/api/song":
                ensure_index()
                sid = qs.get("id", [""])[0]
                song = SONGS_BY_ID.get(sid)
                if not song:
                    return self._error("song not found", 404)
                return self._json(song)
            if path == "/api/chart":
                ensure_index()
                sid = qs.get("id", [""])[0]
                chart_file = qs.get("file", [""])[0]
                song = SONGS_BY_ID.get(sid)
                if not song:
                    return self._error("song not found", 404)
                if not chart_file:
                    if not song["charts"]:
                        return self._error("no chart", 404)
                    chart_file = song["charts"][-1]["file"]
                chart = load_chart(song["path"], chart_file)
                meta = next((c for c in song["charts"] if c["file"] == chart_file), None)
                return self._json({"song": song, "chartMeta": meta, "chart": chart})
            if path == "/api/audio":
                ensure_index()
                sid = qs.get("id", [""])[0]
                song = SONGS_BY_ID.get(sid)
                if not song:
                    return self._error("song not found", 404)
                member = qs.get("member", [song.get("audio") or ""])[0]
                if not member:
                    return self._error("no audio", 404)
                data, ctype = zip_member_bytes(song["path"], member)
                return self._send_media(data, ctype)
            if path == "/api/cover":
                ensure_index()
                sid = qs.get("id", [""])[0]
                song = SONGS_BY_ID.get(sid)
                if not song:
                    return self._error("song not found", 404)
                member = qs.get("member", [song.get("cover") or ""])[0]
                if not member:
                    return self._error("no cover", 404)
                data, ctype = cover_bytes(song["path"], member)
                return self._send(200, data, ctype, {"Cache-Control": "public, max-age=3600"})
            return self._error("not found", 404)
        except FileNotFoundError as exc:
            return self._error(str(exc), 404)
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            print(f"[error] {path}: {exc}", file=sys.stderr)
            return self._error(str(exc), 500)

    def _serve_static(self, rel: str) -> None:
        rel = rel.lstrip("/")
        if not rel:
            rel = "index.html"
        dest = (STATIC / rel).resolve()
        if not str(dest).startswith(str(STATIC.resolve())) or not dest.is_file():
            return self._error("not found", 404)
        data = dest.read_bytes()
        ctype = mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
        if dest.suffix in {".html", ".js", ".css"}:
            ctype += "; charset=utf-8"
        self._send(200, data, ctype)


def main() -> None:
    if not LIBRARY.is_dir():
        print(f"Library not found: {LIBRARY}", file=sys.stderr)
        sys.exit(1)
    ensure_index()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"jubeat 铺面确认 → http://{HOST}:{PORT}/")
    print(f"library: {LIBRARY} ({len(SONGS)} songs)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
