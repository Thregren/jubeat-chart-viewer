"""曲库索引：扫描 .mcz、缓存索引、按 id 取歌、读取谱面。"""
from __future__ import annotations

import concurrent.futures
import json
import os
import re
import sys
import threading
import time
import zipfile
from pathlib import Path

from config import INDEX_CACHE, INDEX_VERSION, LIBRARY
from media import read_member, safe_join, write_atomic, zip_name

DIFF_RE = re.compile(r"_([A-Z]{3})\s*Lv([0-9]+(?:\.[0-9]+)?)", re.I)
DIFF_ORDER = {"BSC": 0, "BAS": 0, "ADV": 1, "EXT": 2}
META_READ_BYTES = 8192  # 只读谱面开头一段来取标题/作曲


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


def published_index(songs: list[dict]) -> dict:
    """公网 `data/library.json` 的形状：只留前端真正读的字段。

    scan_song() 的完整索引还带 path / filename / audio / size /
    charts.file / charts.levelNum / charts.label —— 加起来约占 library.json 的 40%：
    前端要么根本不读（path / audio / size），要么能现算（label = code Lv level、
    levelNum = Number(level)）。charts.file 只在开发服务器内部按 .mcz 成员名读谱面用，
    不下发。static 站和开发服务器都走这同一个形状。
    """
    return {
        "version": INDEX_VERSION,
        "generated": int(time.time()),
        "versions": sorted({s["version"] for s in songs}),
        "songs": [
            {
                "id": s["id"],
                "title": s["title"],
                "artist": s.get("artist") or "",
                "version": s["version"],
                "cover": s.get("cover") or "",
                "charts": [
                    {
                        "code": c["code"],
                        "level": c["level"],
                        "notes": c.get("notes") or 0,
                        "holds": c.get("holds") or 0,
                    }
                    for c in s["charts"]
                ],
            }
            for s in songs
        ],
    }


def scan_song(mcz_path: Path) -> dict | None:
    """读一个 .mcz 的元信息（不加载完整谱面）。"""
    try:
        with zipfile.ZipFile(mcz_path) as zf:
            names = [zip_name(i) for i in zf.infolist() if not i.is_dir()]
            charts = []
            for name in names:
                base = os.path.basename(name)
                if not name.lower().endswith(".mc"):
                    continue
                parsed = parse_chart_name(base)
                if not parsed:
                    continue
                code, level_str, level = parsed
                entry = {"file": name, "code": code, "level": level_str,
                         "levelNum": level, "label": f"{code} Lv{level_str}"}
                # note / hold 数量：排序和物量显示都要用，顺手读一次完整谱面
                try:
                    data = json.loads(zf.read(name).decode("utf-8"))
                    notes = [n for n in (data.get("note") or []) if n.get("index") is not None]
                    entry["notes"] = len(notes)
                    entry["holds"] = sum(1 for n in notes if n.get("endbeat") is not None)
                except Exception:
                    entry["notes"] = 0
                    entry["holds"] = 0
                charts.append(entry)
            if not charts:
                return None
            charts.sort(key=lambda c: (DIFF_ORDER.get(c["code"], 9), c["levelNum"], c["code"]))

            audio = next((n for n in names if os.path.basename(n).lower() == "bgm.ogg"), None)
            if audio is None:
                audio = next((n for n in names if n.lower().endswith((".ogg", ".mp3", ".wav"))), None)
            covers = [n for n in names
                      if n.lower().endswith((".png", ".jpg", ".jpeg"))
                      and os.path.basename(n).lower().startswith("jkt")]
            if not covers:
                covers = [n for n in names if n.lower().endswith((".png", ".jpg", ".jpeg"))]

            title = mcz_path.stem
            artist = ""
            try:
                with zf.open(charts[-1]["file"]) as fh:
                    head = fh.read(META_READ_BYTES).decode("utf-8", errors="replace")
                tm = re.search(r'"title"\s*:\s*"((?:\\.|[^"\\])*)"', head)
                am = re.search(r'"artist"\s*:\s*"((?:\\.|[^"\\])*)"', head)
                if tm:
                    title = json.loads(f'"{tm.group(1)}"')
                if am:
                    artist = json.loads(f'"{am.group(1)}"')
            except Exception:
                pass

            rel = mcz_path.relative_to(LIBRARY).as_posix()
            return {
                "id": rel,
                "path": rel,
                "filename": mcz_path.name,
                "title": title,
                "artist": artist,
                "version": mcz_path.parent.name,
                "audio": audio,
                "cover": covers[0] if covers else None,
                "charts": charts,
                "size": mcz_path.stat().st_size,
            }
    except Exception as exc:
        print(f"[index] skip {mcz_path.name}: {exc}", file=sys.stderr)
        return None


class Library:
    """曲库索引 + 查询。索引结果缓存到 cache/library_index.json。"""

    def __init__(self, root: Path = LIBRARY):
        self.root = root
        self.songs: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.versions: list[str] = []
        self._lock = threading.RLock()

    # —— 索引 ——
    def load(self, force: bool = False) -> None:
        with self._lock:
            if self.songs and not force:
                return
            if not force:
                cached = self._read_cache()
                if cached is not None:
                    self._install(cached)
                    return
            self._install(self._scan())

    def _read_cache(self) -> list[dict] | None:
        try:
            raw = json.loads(INDEX_CACHE.read_text(encoding="utf-8"))
        except Exception:
            return None
        if raw.get("version") != INDEX_VERSION:
            return None
        if raw.get("library") != str(self.root):
            return None
        songs = raw.get("songs")
        if not isinstance(songs, list) or not songs:
            return None
        return songs

    def _scan(self) -> list[dict]:
        print(f"[index] scanning {self.root} …", file=sys.stderr)
        # 跳过 ._xxx.mcz —— 外置盘（exFAT）上 macOS 会给每个文件写一个
        # `._同名` 的元数据边车文件，它也以 .mcz 结尾，混进索引里就是一堆打不开的条目。
        paths = (
            sorted(p for p in self.root.rglob("*.mcz") if not p.name.startswith("._"))
            if self.root.is_dir()
            else []
        )
        songs: list[dict] = []
        if paths:
            # 每个 zip 都要开关一次，多线程扫能明显加快首次启动
            workers = min(16, max(4, (os.cpu_count() or 4) * 2))
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                for meta in pool.map(scan_song, paths, chunksize=8):
                    if meta:
                        songs.append(meta)
        songs.sort(key=lambda s: (s["title"].lower(), s["version"]))
        try:
            write_atomic(INDEX_CACHE, json.dumps(
                {"version": INDEX_VERSION, "library": str(self.root), "songs": songs},
                ensure_ascii=False).encode("utf-8"))
        except OSError as exc:
            print(f"[index] 缓存写入失败: {exc}", file=sys.stderr)
        print(f"[index] {len(songs)} songs cached", file=sys.stderr)
        return songs

    def _install(self, songs: list[dict]) -> None:
        self.songs = songs
        self.by_id = {s["id"]: s for s in songs}
        # 静态站点按 <曲目（去掉 .mcz）> 组织文件，开发服务器也按这个 key 反查
        self.by_stem = {s["id"][:-4] if s["id"].lower().endswith(".mcz") else s["id"]: s
                        for s in songs}
        self.versions = sorted({s["version"] for s in songs})

    # —— 查询 ——
    def query(self, q: str = "", version: str = "") -> list[dict]:
        songs = self.songs
        if version:
            songs = [s for s in songs if s["version"] == version]
        if q:
            ql = q.lower()
            songs = [s for s in songs
                     if ql in s["title"].lower()
                     or ql in s["artist"].lower()
                     or ql in s["filename"].lower()
                     or ql in s["version"].lower()]
        return songs

    def get(self, song_id: str) -> dict | None:
        return self.by_id.get(song_id)

    def by_media_stem(self, stem: str) -> dict | None:
        return self.by_stem.get(stem)

    # —— 文件 ——
    def mcz_path(self, song_id: str) -> Path:
        return safe_join(self.root, song_id)

    def chart(self, song_id: str, chart_file: str) -> dict:
        data = read_member(self.mcz_path(song_id), chart_file)
        return json.loads(data.decode("utf-8"))
