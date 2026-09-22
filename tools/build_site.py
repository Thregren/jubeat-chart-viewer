#!/usr/bin/env python3
"""把曲库（music/*.mcz）展开成一个纯静态站点，nginx 直接发文件、不需要任何后端。

产出目录结构（前端按这套路径取数据）：

    site/
      index.html style.css app.js        前端
      data/library.json                  曲库索引
      data/markers.json                  marker 清单（路径已改成站内相对路径）
      data/charts/<曲目>/<难度>.json       谱面
      media/audio/<曲目>.ogg              音源
      media/cover/<曲目>.<ext>            封面原图
      media/thumb/<曲目>.jpg              列表缩略图（96px）
      markers/...                        marker 素材

用法：
    python3 tools/build_site.py                    # 增量构建到 ./site
    python3 tools/build_site.py --out /srv/jubeat  # 指定输出目录
    python3 tools/build_site.py --force            # 全部重建
    python3 tools/build_site.py --limit 20         # 只做前 20 首（调试用）
    python3 tools/build_site.py --jobs 8           # 并行度（默认 CPU 数）

增量规则：以 .mcz 的修改时间为准，已存在且不比源文件旧就跳过。
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import sys
import time
import zipfile
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parent
PLAYER_DIR = REPO / "铺面查看器" / "player"
sys.path.insert(0, str(PLAYER_DIR))

import config  # noqa: E402
import library  # noqa: E402
import markers  # noqa: E402
import thumbs  # noqa: E402
from media import read_member, zip_name, write_atomic  # noqa: E402


def stem_of(rel_id: str) -> str:
    return rel_id[:-4] if rel_id.lower().endswith(".mcz") else rel_id


def fresh(dest: Path, src_mtime: float, force: bool) -> bool:
    if force or not dest.is_file():
        return False
    try:
        return dest.stat().st_mtime >= src_mtime and dest.stat().st_size > 0
    except OSError:
        return False


def copy_fresh(src: Path, dest: Path, force: bool) -> bool:
    """复制文件（时间戳保持），已是最新则跳过。返回是否写入。"""
    if fresh(dest, src.stat().st_mtime, force):
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + f".tmp{os.getpid()}")
    shutil.copyfile(src, tmp)
    os.replace(tmp, dest)
    return True


def write_bytes_fresh(dest: Path, data: bytes, src_mtime: float, force: bool) -> bool:
    if fresh(dest, src_mtime, force):
        return False
    write_atomic(dest, data)
    os.utime(dest, (src_mtime, src_mtime))
    return True


class Stats:
    def __init__(self) -> None:
        self.files = 0
        self.skipped = 0
        self.bytes = 0
        self.songs = 0
        self.failed: list[str] = []

    def added(self, n: int) -> None:
        self.files += 1
        self.bytes += n


def expected_paths(songs: list[dict], marker_files: list[str], se_files: list[str]) -> set[str]:
    """这次构建应该存在的所有文件（相对 out 的 posix 路径）。"""
    want = {"index.html", "robots.txt", "static/core.js", "static/app.js", "static/sfx.js", "static/style.css",
            "data/library.json", "data/markers.json"}
    want |= {"markers/" + rel for rel in marker_files}
    want |= {"media/se/" + name for name in se_files}
    for s in songs:
        stem = stem_of(s["id"])
        if s.get("audio"):
            want.add(f"media/audio/{stem}.ogg")
        if s.get("cover"):
            ext = os.path.splitext(s["cover"])[1].lower() or ".png"
            want.add(f"media/cover/{stem}{ext}")
            want.add(f"media/thumb/{stem}.jpg")
        for chart in s["charts"]:
            want.add(f"data/charts/{stem}/{chart['code']}.json")
    return want


def prune(out: Path, want: set[str]) -> int:
    """删掉构建目录里已不再需要的文件（曲库删歌之后用），只清理自己管的目录。"""
    managed = ("data", "media", "markers", "static")
    removed = 0
    for top in managed:
        base = out / top
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*"), reverse=True):
            rel = path.relative_to(out).as_posix()
            if path.is_dir():
                try:
                    path.rmdir()  # 空目录才删得掉
                except OSError:
                    pass
            elif rel not in want:
                try:
                    path.unlink()
                    removed += 1
                except OSError:
                    pass
    # 早期版本把前端放在根目录，顺手清掉
    for legacy in ("app.js", "style.css"):
        p = out / legacy
        if p.is_file():
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def build_song(song: dict, out: Path, force: bool, stats: Stats) -> None:
    """展开一首歌的音频 / 封面 / 缩略图 / 谱面。"""
    mcz = config.LIBRARY / song["id"]
    mtime = mcz.stat().st_mtime
    stem = stem_of(song["id"])

    # 音源
    if song.get("audio"):
        dest = out / "media" / "audio" / f"{stem}.ogg"
        if not fresh(dest, mtime, force):
            data = read_member(mcz, song["audio"])
            write_bytes_fresh(dest, data, mtime, force)
            stats.added(len(data))
        else:
            stats.skipped += 1

    # 封面原图 + 缩略图
    if song.get("cover"):
        ext = os.path.splitext(song["cover"])[1].lower() or ".png"
        cover_dest = out / "media" / "cover" / f"{stem}{ext}"
        if not fresh(cover_dest, mtime, force):
            data = read_member(mcz, song["cover"])
            write_bytes_fresh(cover_dest, data, mtime, force)
            stats.added(len(data))
        else:
            stats.skipped += 1

        thumb_dest = out / "media" / "thumb" / f"{stem}.jpg"
        if not fresh(thumb_dest, mtime, force):
            thumb_dest.parent.mkdir(parents=True, exist_ok=True)
            if thumbs.make(cover_dest, thumb_dest, config.THUMB_SIZE, config.THUMB_QUALITY):
                stats.added(thumb_dest.stat().st_size)
            else:
                stats.failed.append(f"thumb: {song['id']}")
        else:
            stats.skipped += 1

    # 谱面
    for chart in song["charts"]:
        dest = out / "data" / "charts" / stem / f"{chart['code']}.json"
        if fresh(dest, mtime, force):
            stats.skipped += 1
            continue
        try:
            data = read_member(mcz, chart["file"])
            write_bytes_fresh(dest, data, mtime, force)
            stats.added(len(data))
        except Exception as exc:
            stats.failed.append(f"chart {song['id']} {chart['file']}: {exc}")


def build_markers(out: Path, force: bool, stats: Stats) -> list[str]:
    """复制 marker 素材 + 生成站内路径的 data/markers.json。"""
    src_root = config.MARKERS_ROOT
    manifest = json.loads((src_root / "manifest.json").read_text(encoding="utf-8"))
    manifest = markers._normalize(manifest)
    copied: list[str] = []
    for entry in manifest.get("markers", []) + manifest.get("effects", []):
        for key in ("sheet", "hit"):
            spec = entry.get(key)
            if not spec:
                continue
            rel = spec["sheet"] if key == "hit" else spec
            copied.append(rel)
            path = src_root / rel
            dest = out / "markers" / rel
            if copy_fresh(path, dest, force):
                stats.added(dest.stat().st_size)
            else:
                stats.skipped += 1
    write_atomic(out / "data" / "markers.json",
                 json.dumps(manifest, ensure_ascii=False, indent=1).encode("utf-8"))
    return copied


def build_se(out: Path, force: bool, stats: Stats) -> list[str]:
    """复制可选的打点音素材 se/（clap/nyan/don/ka 等），没有就跳过。

    这些素材（比如从游戏 / 声库截的音效）有版权，不入库，只在本机构建时打包进去；
    前端 media/se/ 找不到文件就回落到 WebAudio 合成音。
    """
    src_dir = config.SE_DIR
    if not src_dir.is_dir():
        return []
    copied: list[str] = []
    for path in sorted(src_dir.iterdir()):
        if not path.is_file() or path.name.startswith("."):
            continue
        if path.suffix.lower() not in (".ogg", ".oga", ".mp3", ".wav", ".m4a", ".flac"):
            continue
        dest = out / "media" / "se" / path.name
        if copy_fresh(path, dest, force):
            stats.added(dest.stat().st_size)
        else:
            stats.skipped += 1
        copied.append(path.name)
    if copied:
        print(f"  打点音素材 {len(copied)} 个：{'、'.join(copied)}")
    return copied


def main() -> int:
    ap = argparse.ArgumentParser(description="把曲库展开成纯静态站点")
    ap.add_argument("--out", default=str(REPO / "site"), help="输出目录（默认 ./site）")
    ap.add_argument("--force", action="store_true", help="忽略增量，全部重建")
    ap.add_argument("--limit", type=int, default=0, help="只构建前 N 首（调试）")
    ap.add_argument("--jobs", type=int, default=min(8, (os.cpu_count() or 4)),
                    help="并行度（默认 CPU 数，最多 8）")
    ap.add_argument("--prune", action="store_true",
                    help="删掉输出目录里已不需要的文件（曲库删歌后同步用）")
    ap.add_argument("--thumb-size", type=int, default=config.THUMB_SIZE)
    args = ap.parse_args()

    out = Path(args.out).expanduser().resolve()
    config.THUMB_SIZE = max(32, min(512, args.thumb_size))
    out.mkdir(parents=True, exist_ok=True)
    (out / "data" / "charts").mkdir(parents=True, exist_ok=True)

    if not config.LIBRARY.is_dir():
        print(f"曲库不存在：{config.LIBRARY}", file=sys.stderr)
        return 1

    started = time.time()
    print(f"曲库: {config.LIBRARY}")
    print(f"输出: {out}")
    print(f"缩略图后端: {thumbs.backend()}" + (f" · {config.THUMB_SIZE}px" if thumbs.backend() != "none" else ""))

    # 1) 前端文件
    stats = Stats()
    static_dir = PLAYER_DIR / "static"
    for name in ("index.html", "style.css", "core.js", "app.js", "sfx.js"):
        src = static_dir / name
        if not src.is_file():
            continue
        dest = out / (name if name == "index.html" else f"static/{name}")
        if copy_fresh(src, dest, args.force):
            stats.added(src.stat().st_size)

    # robots.txt：曲库 / marker 素材没必要被搜索引擎收录（既费流量也是版权暴露面）
    write_atomic(out / "robots.txt", (
        "User-agent: *\n"
        "Disallow: /media/\n"
        "Disallow: /data/\n"
        "Disallow: /markers/\n"
    ).encode("utf-8"))

    # 2) 曲库索引（复用 player/library.py 的解析逻辑）
    print("扫描曲库…")
    songs = [s for s in (library.scan_song(p) for p in sorted(config.LIBRARY.rglob("*.mcz"))) if s]
    if args.limit:
        songs = songs[: args.limit]
    songs.sort(key=lambda s: (s["title"].lower(), s["version"]))
    # 公开的 library.json 只留前端要读的字段（见 library.published_index）：
    # 完整索引里的 path / filename / charts.file 等约占 40%，都是浪费
    index = library.published_index(songs)
    write_atomic(out / "data" / "library.json",
                 json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    stats.songs = len(songs)
    print(f"曲目 {len(songs)} 首，开始展开音频/封面/谱面（{args.jobs} 线程）…")

    # 3) 逐首展开
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(build_song, s, out, args.force, stats): s for s in songs}
        for fut in concurrent.futures.as_completed(futures):
            song = futures[fut]
            done += 1
            try:
                fut.result()
            except Exception as exc:
                stats.failed.append(f"{song['id']}: {exc}")
            if done % 100 == 0 or done == len(songs):
                print(f"  {done}/{len(songs)}")

    # 4) marker 素材
    marker_files = build_markers(out, args.force, stats)

    # 5) 可选打点音素材
    se_files = build_se(out, args.force, stats)

    if args.prune:
        removed = prune(out, expected_paths(songs, marker_files, se_files))
        if removed:
            print(f"  清理旧文件 {removed} 个")

    elapsed = time.time() - started
    print("\n完成：")
    print(f"  曲目 {stats.songs} 首｜新写文件 {stats.files} 个（{stats.bytes/2**20:.1f} MB）｜跳过 {stats.skipped} 个")
    print(f"  耗时 {elapsed:.1f}s｜输出 {out}")
    if stats.failed:
        print(f"  失败 {len(stats.failed)} 项（前 5 条）：")
        for line in stats.failed[:5]:
            print(f"    {line}")
    print("\n本地预览：python3 tools/serve.py " + str(out))
    return 0 if not stats.failed else 2


if __name__ == "__main__":
    sys.exit(main())
