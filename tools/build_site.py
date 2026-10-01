#!/usr/bin/env python3
"""把曲库（music/*.mcz）展开成一个纯静态站点，nginx 直接发文件、不需要任何后端。

产出目录结构（前端按这套路径取数据）：

    site/
      index.html style.css app.js        前端
      data/library.json                  曲库索引
      data/markers.json                  marker 清单（路径已改成站内相对路径）
      data/charts/<曲目>/<难度>.json       谱面
      media/audio/<曲目>.ogg              音源（mcz 里的 Vorbis 转成 Opus，见 audio_opus.py）
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
import unicodedata
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parent
PLAYER_DIR = REPO / "铺面查看器" / "player"
sys.path.insert(0, str(PLAYER_DIR))

import config  # noqa: E402
import audio_opus  # noqa: E402
import library  # noqa: E402
import markers  # noqa: E402
import thumbs  # noqa: E402
import version as version_mod  # noqa: E402
from media import read_member, write_atomic  # noqa: E402

# 音源转码缓存（内容哈希命名，跨构建复用；cache/ 整个目录不入库）
AUDIO_CACHE_DIR = config.CACHE_DIR / "audio-opus"
# 本机能不能转 Opus（没装 ffmpeg 就只能保持源格式，站点照用，包大一圈）
WANT_OPUS = bool(audio_opus.ffmpeg())


def stem_of(rel_id: str) -> str:
    return rel_id[:-4] if rel_id.lower().endswith(".mcz") else rel_id


def nfc(text: str) -> str:
    """统一成 NFC（组合字符预先合成）。

    macOS 上传回来的 .mcz 文件名常是 NFD（か + ゙），而索引里的曲名是 NFC。
    站点内部的路径和 data/library.json 的 id 必须用同一种形式：macOS 的 APFS
    对规范化不敏感，两种写法都能命中；但 Windows 的 NTFS 是按码点比的，
    名字不对就整首歌的封面 / 音源 / 谱面全 404。这里统一按 NFC 落盘。
    """
    return unicodedata.normalize("NFC", text)


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
        # 「降级」不是失败：源素材自己就是坏的（已知有 5 张封面是坏 PNG），
        # 前端会退化成一个 ♪ 占位。记下来是为了 verify_site.py 别把它们当错误，
        # 同时也让 build.json 里留有痕迹 —— 别把「真出问题」和「本来就坏」混为一谈。
        self.degraded: list[str] = []
        # 音源转码：encoded / cached 都是「拿到了 Opus」，kept 是没转成（缺 ffmpeg 之类）
        self.audio_encoded = 0
        self.audio_cached = 0
        self.audio_kept = 0

    def added(self, n: int) -> None:
        self.files += 1
        self.bytes += n


def static_files() -> list[Path]:
    """铺面查看器/player/static/ 下要发布的前端文件。

    走目录而不是写死文件名：以前漏掉过后来新增的 record.css / record.js，
    index.html 引用了但站点里没有，浏览器直接 404。
    """
    return [p for p in sorted((PLAYER_DIR / "static").iterdir())
            if p.is_file() and not p.name.startswith(".")]


def expected_paths(songs: list[dict], marker_files: list[str], se_files: list[str]) -> set[str]:
    """这次构建应该存在的所有文件（相对 out 的 posix 路径）。"""
    want = {"robots.txt", "data/library.json", "data/markers.json", "data/build.json"}
    want |= {p.name if p.name == "index.html" else f"static/{p.name}" for p in static_files()}
    want |= {"markers/" + rel for rel in marker_files}
    want |= {"media/se/" + name for name in se_files}
    for s in songs:
        stem = nfc(stem_of(s["id"]))
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


def build_song(song: dict, out: Path, force: bool, force_audio: bool, stats: Stats) -> None:
    """展开一首歌的音频 / 封面 / 缩略图 / 谱面。"""
    mcz = config.LIBRARY / song["id"]
    mtime = mcz.stat().st_mtime
    stem = nfc(stem_of(song["id"]))

    # 音源：mcz 里是 Ogg Vorbis，转成 Ogg Opus 再落盘（体积砍掉三分之一左右）。
    # 转码结果带内容哈希缓存（见 audio_opus.py），所以增量构建不会反复编码。
    # force_audio：编码参数变了（比如换了码率）时忽视时间戳，把全库音源重写一遍。
    if song.get("audio"):
        dest = out / "media" / "audio" / f"{stem}.ogg"
        # 除了时间戳，还看一眼编码：目标是 Opus 而盘上还是 Vorbis（上一版遗留、
        # 或者中途换过编码参数）时照样重写 —— 光比 mtime 会把错的状态永久固化。
        if fresh(dest, mtime, force or force_audio) and not (
                WANT_OPUS and not audio_opus.file_is_opus(dest)):
            stats.skipped += 1
        else:
            data, how = audio_opus.encode(read_member(mcz, song["audio"]), AUDIO_CACHE_DIR)
            if how == "encoded":
                stats.audio_encoded += 1
            elif how == "cached":
                stats.audio_cached += 1
            elif how in ("no-ffmpeg", "failed"):
                stats.audio_kept += 1
            # 这里已经判过「该写」了，再让 write_bytes_fresh 自己判一次时间戳，
            # 就会因为 dest 比源新而直接返回（音源永远写不进去）。
            write_bytes_fresh(dest, data, mtime, force=True)
            stats.added(len(data))

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
            elif thumbs.backend() == "none":
                # 没有任何缩略图后端（没有 Pillow 也没有 sips）才是真失败：
                # 这会让整个曲库的列表都退化成大图，必须报出来。
                stats.failed.append(f"thumb: {song['id']}（本机没有 Pillow / sips，缩略图做不了）")
            else:
                # 后端可用但这一张失败了 —— 源封面本身就是坏图（README「已知限制」里那 5 张）
                stats.degraded.append(f"media/thumb/{stem}.jpg")
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
    ap.add_argument("--rescan", action="store_true",
                    help="无视索引缓存，重新解压扫描每个 .mcz（默认走 cache/library_index.json）")
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
    print(f"音源编码: {audio_opus.describe()}")
    if not audio_opus.ffmpeg():
        # 不致命的降级：站点照样能建，只是音源保持源格式（安装包会大一截）
        print("⚠️  没找到 ffmpeg：音源原样保留（想转 Opus 先 brew install ffmpeg）")

    # 编码参数变了就把音源整体重写一遍。只看 mtime 的话，改了码率重建会「全都跳过」，
    # 站点里留的还是上一版编码的音源 —— 这种坑不该靠人记得清目录来躲。
    prev_codec = None
    try:
        prev_codec = json.loads((out / "data" / "build.json").read_text(encoding="utf-8")).get("audio_codec")
    except (OSError, ValueError):
        prev_codec = None
    force_audio = args.force or prev_codec != audio_opus.describe()
    if force_audio and not args.force:
        print(f"  音源编码从「{prev_codec}」变成「{audio_opus.describe()}」：音源全部重写")

    # 1) 前端文件
    stats = Stats()
    for src in static_files():
        name = src.name
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

    # 2) 曲库索引（复用 player/library.py 的解析逻辑与索引缓存）
    #
    # 以前这里绕开缓存、每次都全量重扫：整个曲库的 zip 都要开一遍、再把每份谱面
    # json.loads 一次，光「什么都没改」的重复构建就要几十秒。现在走 Library，
    # 缓存带曲库指纹（条数 + 最新 mtime + 总字节，见 library.fingerprint），
    # 曲库没动就直接命中；真要重建用 --rescan。
    print("读取曲库索引…" + ("（--rescan：全量重扫）" if args.rescan else ""))
    lib = library.Library()
    lib.load(force=args.rescan)
    songs = list(lib.songs)
    if args.limit:
        songs = songs[: args.limit]
    songs.sort(key=lambda s: (s["title"].lower(), s["version"]))
    # 公开的 library.json 只留前端要读的字段（见 library.published_index）：
    # 完整索引里的 path / filename / charts.file 等约占 40%，都是浪费
    index = library.published_index(songs)
    # 前端是拿 id 拼资源路径的（media/audio/<id>.ogg 等），所以 id 也要跟着
    # 一起规范化，否则站点里的文件名和索引里的 id 会差一个规范化形式。
    # 站点内部一律 NFC：同一个 stem 规范化后如果撞车（两份只在规范化形式上不同的
    # 曲目），媒体文件会互相覆盖，必须报出来而不是静默丢一份。
    stem_owner: dict[str, str] = {}
    for s in index["songs"]:
        s["id"] = nfc(s["id"])
        stem = nfc(stem_of(s["id"]))
        other = stem_owner.get(stem)
        if other and other != s["id"]:
            stats.failed.append(f"NFC 规范化后路径撞车：{other} ↔ {s['id']}")
        else:
            stem_owner[stem] = s["id"]
    write_atomic(out / "data" / "library.json",
                 json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    stats.songs = len(songs)
    print(f"曲目 {len(songs)} 首，开始展开音频/封面/谱面（{args.jobs} 线程）…")

    # 3) 逐首展开
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(build_song, s, out, args.force, force_audio, stats): s for s in songs}
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

    # 6) 构建报告：上线后想确认「这一版站点是谁、什么时候、用哪份曲库建的」，
    #    看 data/build.json 就行（不发本机绝对路径：这份文件是公开的）。
    report = {
        "version": version_mod.read_version(),
        "index_version": config.INDEX_VERSION,
        "built": int(time.time()),
        "library_name": config.LIBRARY.name,
        "songs": stats.songs,
        "charts": sum(len(s["charts"]) for s in songs),
        "audio": sum(1 for s in songs if s.get("audio")),
        "covers": sum(1 for s in songs if s.get("cover")),
        "markers": len(marker_files),
        "se_files": len(se_files),
        "audio_codec": audio_opus.describe(),
        "audio_encoded": stats.audio_encoded,
        "audio_cached": stats.audio_cached,
        "audio_kept": stats.audio_kept,
        "thumb_backend": thumbs.backend(),
        "thumb_size": config.THUMB_SIZE,
        "files_written": stats.files,
        "bytes_written": stats.bytes,
        "skipped": stats.skipped,
        "elapsed_s": round(elapsed, 1),
        "failed_count": len(stats.failed),
        "failures": stats.failed[:20],
        "degraded": stats.degraded,
    }
    write_atomic(out / "data" / "build.json",
                 json.dumps(report, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    # 前端 ?v= 和 VERSION 对不上 = 用户浏览器可能还捧着旧 app.js，早点提醒
    ver = report["version"]
    index_html = (PLAYER_DIR / "static" / "index.html").read_text(encoding="utf-8")
    v_in_html = version_mod.html_versions(index_html)
    if v_in_html != {ver}:
        print(f"⚠️  前端 index.html 的 ?v= 是 {sorted(v_in_html) or '（无）'}，"
              f"和 VERSION（{ver}）不一致：跑 python3 tools/set_version.py {ver}")

    print("\n完成：")
    print(f"  曲目 {stats.songs} 首｜新写文件 {stats.files} 个（{stats.bytes/2**20:.1f} MB）｜跳过 {stats.skipped} 个")
    if stats.audio_encoded or stats.audio_cached or stats.audio_kept:
        print(f"  音源：新编码 {stats.audio_encoded} 首｜命中缓存 {stats.audio_cached} 首"
              f"｜保持源格式 {stats.audio_kept} 首")
    print(f"  耗时 {elapsed:.1f}s｜输出 {out}")
    if stats.failed:
        print(f"  失败 {len(stats.failed)} 项（前 5 条）：")
        for line in stats.failed[:5]:
            print(f"    {line}")
    if stats.degraded:
        print(f"  降级 {len(stats.degraded)} 项（源素材本身有问题，前端有占位，不算失败）：")
        for line in stats.degraded[:5]:
            print(f"    {line}")
    print("\n本地预览：python3 tools/serve.py " + str(out))
    return 0 if not stats.failed else 2


if __name__ == "__main__":
    sys.exit(main())
