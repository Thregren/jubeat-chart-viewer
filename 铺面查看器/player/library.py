"""曲库索引：扫描 .mcz、缓存索引、按 id 取歌、读取谱面。"""
from __future__ import annotations

import concurrent.futures
import json
import os
import re
import sys
import threading
import time
import unicodedata
import zipfile
from pathlib import Path

import config
from media import read_member, safe_join, write_atomic, zip_name

DIFF_RE = re.compile(r"_([A-Z]{3})\s*Lv([0-9]+(?:\.[0-9]+)?)", re.I)
DIFF_ORDER = {"BSC": 0, "BAS": 0, "ADV": 1, "EXT": 2}

# 少数老谱面（jubeat / ripples / ripples-append / knit / copious 的版权曲）成员名里
# 根本没写 `Lv`：`全力少年_BSC.mc` 而不是 `全力少年_BSC Lv2.mc`，meta.level 也是空的。
# 这类文件以前整首会被丢掉（解析不出难度 → 没有 charts → scan_song 返回 None），
# 曲库里 1479 首只索引出 1431 首。现在用结尾的难度码认出来，等级查 official_levels.json。
CODE_TAIL_RE = re.compile(r"(?:^|_)(BSC|BAS|ADV|EXT)\s*\.mc$", re.I)
OFFICIAL_LEVELS_FILE = Path(__file__).resolve().parent / "official_levels.json"

_fallback_lock = threading.Lock()
_fallback_levels: dict[str, dict[str, str]] | None = None


def official_levels() -> dict[str, dict[str, str]]:
    """成员名没写等级的谱面查这张兜底表：NFC 归一化后的「版本目录/曲名」→ {难度: 等级}。

    数据来源写在文件里（_source）：atwiki 的全曲表，含官方已下架、游戏数据里已经没有的曲子。
    表读不到（打包漏带、文件写坏）就当空表：这类谱面照常收录，只是等级显示为空，
    宁可少一个数字，也不要因为一个数据文件整首歌消失。
    """
    global _fallback_levels
    if _fallback_levels is not None:
        return _fallback_levels
    with _fallback_lock:
        if _fallback_levels is not None:
            return _fallback_levels
        table: dict[str, dict[str, str]] = {}
        try:
            raw = json.loads(OFFICIAL_LEVELS_FILE.read_text(encoding="utf-8"))
            for key, levels in raw.items():
                if not isinstance(levels, dict) or key.startswith("_"):
                    continue
                table[stem_key(key)] = {str(k).upper(): str(v) for k, v in levels.items()}
        except FileNotFoundError:
            pass
        except Exception as exc:
            print(f"[index] 等级兜底表不可用（忽略）：{exc}", file=sys.stderr)
        _fallback_levels = table
        return table


def parse_chart_code(filename: str) -> str | None:
    """从成员名末尾认出难度码（`..._BSC.mc` / `NEU__EXT.mc`），用于没写 Lv 的老谱面。"""
    m = CODE_TAIL_RE.search(filename)
    return m.group(1).upper() if m else None


def stem_key(text: str) -> str:
    """曲目 stem 的比对键。

    macOS 的文件名是 NFD（「バ」=「ハ」+ 浊点），而手写的重录列表、从别处复制的
    名字多半是 NFC。不归一化的话 /data/charts/jubeat-plus/バレンタイン_キッス/EXT.json
    会 404，页面拿不到谱面就永远不 ready（2026-09-28 就是这样连挂 4 首）。两边都
    折成 NFC 再比。
    """
    return unicodedata.normalize("NFC", text)


def _song_id(rel_id: str) -> str:
    """曲目 id（相对路径，含 .mcz 后缀）→ 去后缀的键，跟 build_site.stem_of 一致。"""
    return rel_id[:-4] if rel_id.lower().endswith(".mcz") else rel_id


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
        "version": config.INDEX_VERSION,
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
                    _published_chart(c)
                    for c in s["charts"]
                ],
            }
            for s in songs
        ],
    }


def _published_chart(chart: dict) -> dict:
    """单个难度的公开字段。

    notesKnown=False（谱面读坏、json 解析失败）才下发这个字段：前端据此把物量
    显示成「未知」而不是骗人的 0。正常情况下不加，省得 1.6 万个难度对象白胖一圈。
    """
    out = {
        "code": chart["code"],
        "level": chart["level"],
        "notes": chart.get("notes") or 0,
        "holds": chart.get("holds") or 0,
    }
    if not chart.get("notesKnown", True):
        out["notesKnown"] = False
    return out


def _song_meta_of(data: dict) -> tuple[str, str]:
    """从 .mc 的 meta.song 里取曲名 / 作曲。

    以前是拿谱面开头 8 KB 做正则抠 title / artist：一旦某个字段排在第 8 KB 之后
    （长谱面的 extra / 靠后的 note 数组会把 meta 顶出去），曲名就悄悄退回文件名。
    现在 note 数本来就要整份 json.loads，meta.song 顺手就有，正则那套可以退休了。
    """
    meta = data.get("meta") or {}
    song = meta.get("song") if isinstance(meta, dict) else None
    if not isinstance(song, dict):
        return "", ""
    title = song.get("title")
    artist = song.get("artist")
    return (str(title).strip() if title else "", str(artist).strip() if artist else "")


def scan_song(mcz_path: Path, root: Path) -> dict | None:
    """读一个 .mcz 的元信息（不加载完整谱面）。"""
    try:
        rel = mcz_path.relative_to(root).as_posix()
        # 等级兜底表只在这首歌真的缺等级时才查（绝大多数曲子成员名里就有 Lv）
        fallback: dict[str, str] | None = None
        with zipfile.ZipFile(mcz_path) as zf:
            names = [zip_name(i) for i in zf.infolist() if not i.is_dir()]
            charts = []
            title = ""
            artist = ""
            for name in names:
                base = os.path.basename(name)
                if not name.lower().endswith(".mc"):
                    continue
                parsed = parse_chart_name(base)
                if parsed:
                    code, level_str, level = parsed
                else:
                    code = parse_chart_code(base)
                    if not code:
                        continue
                    if fallback is None:
                        fallback = official_levels().get(stem_key(_song_id(rel)), {})
                    level_str = fallback.get(code, "")
                    try:
                        level = float(level_str)
                    except ValueError:
                        level = 0.0
                entry = {"file": name, "code": code, "level": level_str,
                         "levelNum": level,
                         "label": f"{code} Lv{level_str}" if level_str else code}
                # note / hold 数量：排序和物量显示都要用，顺手读一次完整谱面
                try:
                    data = json.loads(zf.read(name).decode("utf-8"))
                    notes = [n for n in (data.get("note") or []) if n.get("index") is not None]
                    entry["notes"] = len(notes)
                    entry["holds"] = sum(1 for n in notes if n.get("endbeat") is not None)
                    entry["notesKnown"] = True
                    if not title:
                        title, artist = _song_meta_of(data)
                except Exception:
                    entry["notes"] = 0
                    entry["holds"] = 0
                    entry["notesKnown"] = False
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

            return {
                "id": rel,
                "path": rel,
                "filename": mcz_path.name,
                "title": title or mcz_path.stem,
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


def mcz_paths(root: Path) -> list[Path]:
    """曲库里的 .mcz 列表。

    跳过 `._xxx.mcz` —— 外置盘（exFAT）上 macOS 会给每个文件写一个 `._同名` 的
    元数据边车文件，它也以 .mcz 结尾，混进索引里就是一堆打不开的条目。
    """
    if not root.is_dir():
        return []
    return sorted(p for p in root.rglob("*.mcz") if not p.name.startswith("._"))


def fingerprint(paths: list[Path]) -> dict:
    """索引缓存指纹：条数 + 最新修改时间 + 总字节数。

    老缓存只比「索引结构版本 + 曲库路径」：往 music/ 里丢一首新歌再重启，缓存照样命中，
    新歌在界面上就是不出现（得手动点「重新读取」）。加上指纹后，增删改任意一首都会失效。
    这里只 stat，不解压，代价是毫秒级。
    """
    count = 0
    newest = 0
    total = 0
    for path in paths:
        try:
            st = path.stat()
        except OSError:
            continue                     # 扫描期间刚被删掉的：跳过，不算进指纹
        count += 1
        total += st.st_size
        mtime_ms = int(st.st_mtime * 1000)
        if mtime_ms > newest:
            newest = mtime_ms
    return {"count": count, "newest_ms": newest, "bytes": total}


class Library:
    """曲库索引 + 查询。索引结果缓存到 cache/library_index.json。"""

    def __init__(self, root: Path | None = None):
        self._root = Path(root) if root is not None else None
        self.songs: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.by_stem: dict[str, dict] = {}
        self.versions: list[str] = []
        self._lock = threading.RLock()
        # 扫描串行化：第一个请求慢慢扫，后来的请求在锁外等，不会各自再扫一遍
        self._scan_lock = threading.Lock()

    @property
    def root(self) -> Path:
        """曲库目录。惰性解析（config.LIBRARY 要用时才扫盘）。"""
        if self._root is None:
            self._root = config.LIBRARY
        return self._root

    # —— 索引 ——
    def load(self, force: bool = False) -> None:
        """确保索引就绪。已就绪就是一次属性读，没有任何锁竞争。

        注意扫描**不在** self._lock 里：以前整段 rglob + 解压都在锁内，首次索引
        几十秒里所有走 load() 的请求（含 /api/health）都排队等同一把锁。
        """
        if self.songs and not force:
            return
        paths = mcz_paths(self.root)
        if not force:
            cached = self._read_cache(paths)
            if cached is not None:
                self._install(cached)
                return
        with self._scan_lock:
            if self.songs and not force:      # 排队期间别人已经扫好了
                return
            self._install(self._scan(paths))

    def _read_cache(self, paths: list[Path]) -> list[dict] | None:
        try:
            raw = json.loads(config.INDEX_CACHE.read_text(encoding="utf-8"))
        except Exception:
            return None
        # 缓存文件合法 JSON 但内容不是对象（被别的程序覆盖成 []、"x"、null…）：
        # 当没缓存处理、老老实实重扫，别让 .get 抛出把请求打成 500。
        if not isinstance(raw, dict):
            return None
        if raw.get("version") != config.INDEX_VERSION:
            return None
        if raw.get("library") != str(self.root):
            return None
        if raw.get("fingerprint") != fingerprint(paths):
            return None
        songs = raw.get("songs")
        if not isinstance(songs, list) or not songs:
            return None
        return songs

    def _scan(self, paths: list[Path]) -> list[dict]:
        print(f"[index] scanning {self.root} …", file=sys.stderr)
        songs: list[dict] = []
        if paths:
            # 每个 zip 都要开关一次，多线程扫能明显加快首次启动
            workers = min(16, max(4, (os.cpu_count() or 4) * 2))
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                for meta in pool.map(lambda p: scan_song(p, self.root), paths, chunksize=8):
                    if meta:
                        songs.append(meta)
        songs.sort(key=lambda s: (s["title"].lower(), s["version"]))
        try:
            write_atomic(config.INDEX_CACHE, json.dumps(
                {"version": config.INDEX_VERSION, "library": str(self.root),
                 "fingerprint": fingerprint(paths), "songs": songs},
                ensure_ascii=False).encode("utf-8"))
        except OSError as exc:
            print(f"[index] 缓存写入失败: {exc}", file=sys.stderr)
        print(f"[index] {len(songs)} songs cached", file=sys.stderr)
        return songs

    def _install(self, songs: list[dict]) -> None:
        # 一次性算好再整体换上：读侧（by_id / by_stem）永远看到同一份完整索引
        by_id = {s["id"]: s for s in songs}
        # 静态站点按 <曲目（去掉 .mcz）> 组织文件，开发服务器也按这个 key 反查
        by_stem = {stem_key(s["id"][:-4] if s["id"].lower().endswith(".mcz") else s["id"]): s
                   for s in songs}
        versions = sorted({s["version"] for s in songs})
        with self._lock:
            self.songs = songs
            self.by_id = by_id
            self.by_stem = by_stem
            self.versions = versions

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
        return self.by_stem.get(stem_key(stem))

    # —— 文件 ——
    def mcz_path(self, song_id: str) -> Path:
        return safe_join(self.root, song_id)

    def chart(self, song_id: str, chart_file: str) -> dict:
        data = read_member(self.mcz_path(song_id), chart_file)
        return json.loads(data.decode("utf-8"))
