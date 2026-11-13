"""曲库索引：读取开放目录曲库（`data/library.json`）、按 id 取歌、下发公开索引。

旧版 `.mcz` 扫描链路已下线：索引的唯一来源是构建产物的目录曲库索引，
运行时不打开任何压缩包，也没有索引缓存文件（索引本身就是缓存）。
"""
from __future__ import annotations

import gzip
import hashlib
import json
import threading
import time
import unicodedata
from pathlib import Path

import config
from directory_library import asset_path, load_directory

INDEX_FILE = "data/library.json"


def stem_key(text: str) -> str:
    """曲目 stem 的比对键。

    macOS 的文件名是 NFD（「バ」=「ハ」+ 浊点），而手写的重录列表、从别处复制的
    名字多半是 NFC。不归一化的话 /data/charts/jubeat-plus/バレンタイン_キッス/EXT.json
    会 404，页面拿不到谱面就永远不 ready（2026-09-28 就是这样连挂 4 首）。两边都
    折成 NFC 再比。
    """
    return unicodedata.normalize("NFC", text)


def published_index(songs: list[dict], generated: int | None = None, versions: list[str] | None = None,
                    extras: dict | None = None) -> dict:
    """公网 `data/library.json` 的形状：只留前端真正读的字段。

    目录曲库的原始条目还带 metadataEvidence / missing 之类的构建期信息，加起来
    占索引相当一部分体积，而前端要么不读、要么能现算（label = code Lv level、
    levelNum = Number(level)）。static 站和开发服务器都走这同一个形状。

    extras 用来原样带上 `format` / `versionIndexes`：按版本拆分的曲库，曲目都在
    各版本索引里，顶层 songs 是空的 —— 前端要靠 versionIndexes 才知道去哪儿取。
    """
    result = {
        "version": config.INDEX_VERSION,
        "generated": int(time.time()) if generated is None else generated,
        "versions": sorted({s["version"] for s in songs}) if versions is None else versions,
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
    if extras:
        result.update({k: v for k, v in extras.items() if k not in result})

    for original, public in zip(songs, result['songs']):
        for key in ('assets', 'missing', 'resourceOnly', 'identity', 'titleKnown', 'category', 'source'):
            if key in original: public[key] = original[key]
    return result


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


class Library:
    """曲库索引 + 查询。索引直接来自目录曲库，不做二次扫描或缓存文件。"""

    def __init__(self, root: Path | None = None):
        self._explicit_root = root is not None
        self._root = Path(root) if root is not None else None
        self.generated = int(time.time())
        self.songs: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.by_stem: dict[str, dict] = {}
        self.versions: list[str] = []
        self.assets: set[str] = set()
        # 按版本拆分的曲库：{相对路径} 里放的是各版本索引，需要开发服务器原样下发
        self.version_indexes: list[str] = []
        self._lock = threading.RLock()
        # 读取串行化：第一个请求慢慢读，后来的请求在锁外等，不会各自再读一遍
        self._scan_lock = threading.Lock()
        self._loaded = False
        self._revision = 0
        self._public_response: tuple[bytes, bytes, str] | None = None

    @property
    def root(self) -> Path:
        """曲库目录。惰性解析（config.LIBRARY 要用时才读盘）。"""
        if self._root is None:
            self._root = config.LIBRARY
        return self._root

    # —— 索引 ——
    def load(self, force: bool = False) -> None:
        """确保索引就绪。已就绪就是一次属性读，没有任何锁竞争。

        注意读取**不在** self._lock 里：以前整段扫描都在锁内，首次索引期间
        所有走 load() 的请求（含 /api/health）都排队等同一把锁。
        """
        if self._loaded and not force:
            return
        with self._scan_lock:
            if self._loaded and not force:
                return
            index = self.root / INDEX_FILE
            if not index.is_file():
                raise ValueError('曲库缺少 data/library.json（需要开放目录曲库）')
            data, assets = load_directory(self.root)
            self._install(data['songs'], data['versions'], assets,
                          version_indexes=data.get('versionIndexes') or [])

    def _install(self, songs: list[dict], versions: list[str] | None = None,
                 assets: set[str] | None = None, version_indexes: list[str] | None = None) -> None:
        # 一次性算好再整体换上：读侧（by_id / by_stem）永远看到同一份完整索引
        by_id = {s["id"]: s for s in songs}
        # 静态站点按 <曲目 id> 组织资源，开发服务器也按这个 key 反查
        by_stem = {stem_key(s["id"]): s for s in songs}
        versions = sorted({s["version"] for s in songs}) if versions is None else versions
        version_indexes = list(version_indexes or [])
        generated = int(time.time())
        extras = {"format": "jubeat-directory-v1"} if version_indexes else None
        if extras:
            extras["versionIndexes"] = version_indexes
        body = json.dumps(published_index(songs, generated=generated, versions=versions,
                                          extras=extras), ensure_ascii=False,
                          separators=(",", ":")).encode("utf-8")
        # A weak validator describes the JSON representation independently of
        # transfer compression. The immutable tuple is swapped with the index.
        public_response = (body, gzip.compress(body, compresslevel=6, mtime=0),
                           'W/"%s"' % hashlib.sha256(body).hexdigest()[:20])
        with self._lock:
            self.generated = generated
            self.songs = songs
            self.by_id = by_id
            self.by_stem = by_stem
            self.versions = versions
            self.assets = assets if assets is not None else set()
            self.version_indexes = version_indexes
            self._public_response = public_response
            self._loaded = True
            self._revision += 1

    def published_response(self) -> tuple[bytes, bytes, str]:
        """Return precomputed JSON, gzip bytes and ETag for the installed index."""
        self.load()
        assert self._public_response is not None
        return self._public_response

    # —— 查询 ——
    def get(self, song_id: str) -> dict | None:
        return self.by_id.get(song_id)

    def by_media_stem(self, stem: str) -> dict | None:
        return self.by_stem.get(stem_key(stem))

    # —— 文件 ——
    def asset_path(self, name: str) -> Path:
        """曲库内相对路径 → 绝对路径（校验形状，并解符号链接确认没跑出曲库根）。"""
        return asset_path(self.root, name)

    def asset_file(self, song: dict, key: str) -> Path | None:
        """曲目资源（`audio` / `cover` / `thumb` / `chart:EXT`）→ 绝对路径。

        路径形状在 load_directory 里已校验过，这里仍走 asset_path()：
        打开文件前要解一次符号链接，确认没有跑出曲库根。
        """
        name = (song.get("assets") or {}).get(key)
        if not name:
            return None
        return asset_path(self.root, name)
