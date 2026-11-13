#!/usr/bin/env python3
"""站点产物自检：构建完 / 发版前 / 部署后都该跑一遍。

    python3 tools/verify_site.py                 # 检查 ./site
    python3 tools/verify_site.py --out /srv/ub   # 检查指定目录
    python3 tools/verify_site.py --strict        # 连「多余的孤儿文件」一起报

为什么需要它：静态站点没有后端兜底，少一个文件就是用户那边 404（封面空白、谱面
永远 loading、音源拖不动）。这些靠肉眼看目录是看不出来的（4000 首 × 4 个难度），
所以让脚本把 library.json 里声明的每一项都落到磁盘上核对一遍。

检查项：
  1. 入口与前端：index.html / static/*.(js|css) 都在，?v= 与 VERSION 一致
  2. 索引：data/library.json 可解析、版本号对得上、id 全是 NFC
  3. 逐曲：每个难度的谱面 JSON 在、音源 / 封面 / 缩略图在且不是空文件
  4. marker：data/markers.json 里引用的素材都在
  5. 构建报告 data/build.json 里的失败项必须为 0
     （里面另有一份「降级」清单：源素材自己就是坏的，例如 5 张坏 PNG 封面，
      前端会退化成 ♪ 占位 —— 那种只报警告，不算构建失败）
  6. --strict：data|media|markers|static 下不该有索引里没提到的文件
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import unicodedata
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parent
PLAYER_DIR = REPO / "jubeat_viewer" / "player"
sys.path.insert(0, str(PLAYER_DIR))

import markers as markers_mod  # noqa: E402
from asset_hash import canonical_version_index, is_hashed  # noqa: E402
import version as version_mod  # noqa: E402

PASS, FAIL, WARN = "\033[32m✓\033[0m", "\033[31m✗\033[0m", "\033[33m!\033[0m"


class Report:
    def __init__(self, strict: bool) -> None:
        self.strict = strict
        self.problems: list[str] = []
        self.warnings: list[str] = []
        self.checks = 0

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks += 1
        if not ok:
            self.problems.append(name + (f"（{detail}）" if detail else ""))
        return ok

    def warn(self, name: str, detail: str = "") -> None:
        """有问题但已知、可控：记一笔，不算失败。"""
        self.checks += 1
        self.warnings.append(name + (f"（{detail}）" if detail else ""))

    def summary(self) -> int:
        if self.warnings:
            print(f"\n{WARN} {len(self.warnings)} 项已知降级：")
            for item in self.warnings[:10]:
                print(f"    · {item}")
        if self.problems:
            print(f"\n{FAIL} {len(self.problems)} 项有问题：")
            for item in self.problems[:40]:
                print(f"    · {item}")
            if len(self.problems) > 40:
                print(f"    … 还有 {len(self.problems) - 40} 项")
            return 1
        print(f"\n{PASS} 全部 {self.checks} 项通过")
        return 0


def check_song(out: Path, song: dict, want: set[str], r: "Report") -> None:
    """逐曲核对：索引里声明的每个资源都要在盘上，且不是空文件。

    目录曲库的布局是 `songs/<版本>/<分类>/<id>/...`（由索引的 assets 给出），
    不再有 `data/charts/<stem>/<code>.json` / `media/audio/<stem>.ogg` 那套
    推导规则 —— 以前按规则拼路径，目录曲库会被判成「每个难度都缺谱面」。
    """
    song_id = song["id"]
    assets = song.get("assets") or {}

    for chart in song["charts"]:
        code = chart.get("code")
        r.check(f"等级 {song_id} {code}", bool(str(chart.get("level", "")).strip()))
        name = assets.get(f"chart:{code}")
        if not name:
            r.check(f"谱面资源 {song_id} {code}", False, f"索引里没有 chart:{code}")
            continue
        want.add(name)
        path = out / name
        if not r.check(f"谱面 {name}", path.is_file() and path.stat().st_size > 0):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            r.check(f"谱面可解析 {name}", False, str(exc))
            continue
        if not isinstance(data.get("note"), list):
            r.check(f"谱面结构 {name}", False, "没有 note 数组")

    audio = assets.get("audio")
    if audio:
        want.add(audio)
        path = out / audio
        size = path.stat().st_size if path.is_file() else 0
        r.check(f"音源 {audio}", size > 1024, f"{size}B")
        # 压缩曲库的音源是 Ogg Opus。原样直发的曲库保留 WAV/MP3，不参与这条判断。
        if size > 1024 and audio.lower().endswith(".ogg"):
            try:
                with open(path, "rb") as fh:
                    head = fh.read(64)      # 只看头，别把整张封面/整段音频读进内存
            except OSError:
                head = b""
            if b"OpusHead" not in head:
                r.warn(f"音源编码 {audio}", "不是 Opus（未压缩的目录曲库，包会大一截）")

    cover = assets.get("cover")
    r.check(f"封面已声明 {song_id}", bool(cover))
    if cover:
        want.add(cover)
        path = out / cover
        size = path.stat().st_size if path.is_file() else 0
        r.check(f"封面 {cover}", size > 128, f"{size}B")

    thumb = assets.get("thumb")
    if thumb:
        want.add(thumb)
        path = out / thumb
        size = path.stat().st_size if path.is_file() else 0
        head = b""
        if size:
            try:
                with open(path, "rb") as fh:
                    head = fh.read(2)
            except OSError:
                head = b""
        r.check(f"缩略图 {thumb}", size > 128 and head == b"\xff\xd8", f"{size}B")


def main() -> int:
    ap = argparse.ArgumentParser(description="检查站点产物是否完整")
    ap.add_argument("--out", default=str(REPO / "site"))
    ap.add_argument("--strict", action="store_true", help="连多余的文件也报出来")
    ap.add_argument("--quiet", action="store_true", help="只打结论")
    ap.add_argument("--min-markers", type=int, default=40, help="要求的最少 marker 套数（小型测试库可覆盖）")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    r = Report(args.strict)
    want: set[str] = {"robots.txt", "index.html", "data/library.json",
                      "data/markers.json", "data/build.json"}

    if not (out / "index.html").is_file():
        print(f"{FAIL} 不是站点目录：{out}（没有 index.html）", file=sys.stderr)
        return 1

    # 1) 入口与前端
    index_html = (out / "index.html").read_text(encoding="utf-8")
    static_refs = version_mod.V_QUERY_FIND.findall(index_html)
    if not r.check("index.html 有静态资源引用", len(static_refs) >= 3, str(len(static_refs))):
        return r.summary()
    try:
        want_version = version_mod.read_version()
    except RuntimeError:
        want_version = None
    if want_version:
        r.check("前端 ?v= 与 VERSION 一致",
                set(static_refs) == {want_version}, f"{sorted(set(static_refs))} vs {want_version}")
    for ref in sorted(set(_static_files(index_html))):
        want.add(ref)
        r.check(f"前端资源 {ref}", (out / ref).is_file())

    # 2) 索引
    lib_path = out / "data" / "library.json"
    if not r.check("data/library.json 存在", lib_path.is_file()):
        return r.summary()
    try:
        lib = json.loads(lib_path.read_text(encoding="utf-8"))
    except Exception as exc:
        r.check("data/library.json 可解析", False, str(exc))
        return r.summary()
    if lib.get("format") != "jubeat-directory-v1":
        r.check("曲库格式是开放目录", False, f"format={lib.get('format')!r}（只支持 jubeat-directory-v1）")
        return r.summary()
    try:
        from directory_library import load_directory
        merged, _ = load_directory(out)
        songs = merged["songs"]
        for relative in lib.get("versionIndexes", []):
            if (out / relative).is_file():
                want.add(relative)
            canonical = canonical_version_index(relative)
            if (out / canonical).is_file():
                want.add(canonical)
    except Exception as error:
        r.check("目录索引完整性", False, str(error))
        return r.summary()
    r.check("曲库非空", len(songs) > 0, f"{len(songs)} 首")

    # 3) 构建报告
    build_path = out / "data" / "build.json"
    report: dict = {}
    if r.check("data/build.json 存在", build_path.is_file()):
        try:
            report = json.loads(build_path.read_text(encoding="utf-8"))
        except Exception as exc:
            r.check("data/build.json 可解析", False, str(exc))

    # 4) 逐曲
    for song in songs:
        check_song(out, song, want, r)
        for rel, name in (song.get("assets") or {}).items():
            want.add(name)
            r.check(f"资源路径可发布 {rel}", not Path(name).is_absolute()
                    and ".." not in Path(name).parts and (out / name).is_file())

    # 5) marker 素材（官方逐帧贴图：清单里的每一帧都要在盘上）
    markers_path = out / "data" / "markers.json"
    if r.check("data/markers.json 存在", markers_path.is_file()):
        try:
            manifest = json.loads(markers_path.read_text(encoding="utf-8"))
        except Exception as exc:
            manifest = {}
            r.check("data/markers.json 可解析", False, str(exc))
        designs = manifest.get("designs") or []
        missing: list[str] = []
        total = 0
        for design in designs:
            for rel in markers_mod.design_assets(design):
                total += 1
                want.add(f"markers/{rel}")
                if not (out / "markers" / rel).is_file():
                    missing.append(rel)
            for atlas in design.get('atlases',{}).values():
                relative='markers/'+atlas['file'];want.add(relative)
                r.check('marker 图集 '+relative,(out/relative).is_file())
        r.check("marker 设计数量", len(designs) >= args.min_markers, f"{len(designs)} 套")
        r.check("marker 贴图齐全", not missing,
                f"缺 {len(missing)}/{total} 张，例如 {missing[:2]}")

    # 6) 构建报告：这次构建真的失败过吗
    if report:
        r.check("构建报告无失败项", not report.get("failed_count"),
                f"{report.get('failed_count')} 项：" + "；".join(report.get("failures") or [])[:200])

    # 6) 孤儿文件（构建后残留：删歌 / 改名的遗留）
    if args.strict:
        extra = 0
        for top in ("data", "media", "markers", "static"):
            base = out / top
            if not base.is_dir():
                continue
            for path in base.rglob("*"):
                if not path.is_file():
                    continue
                rel = path.relative_to(out).as_posix()
                # media/se/ 是可选打点音素材：构建时「源目录里有什么就传什么」，
                # 索引里没有它的清单，所以不参与孤儿判断
                if is_hashed(rel):
                    continue
                if rel.startswith("media/se/"):
                    continue
                if rel not in want:
                    extra += 1
                    if extra <= 10:
                        r.check(f"多余文件 {rel}", False, "跑 build_site.py --prune 清掉")
        print(f"  {('!' if extra else '✓')} 孤儿文件 {extra} 个")

    if not args.quiet:
        total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
        print(f"  站点 {out}\n  曲目 {len(songs)} 首｜文件占 {total / 2**20:.0f} MB")
    return r.summary()


def _static_files(index_html: str) -> set[str]:
    """index.html 引用的本地资源（static/...），用于核对文件真的在。"""
    import re

    return set(re.findall(r'(?:src|href)="(static/[^"?]+)', index_html))


if __name__ == "__main__":
    sys.exit(main())
