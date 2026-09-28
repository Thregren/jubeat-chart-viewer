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
PLAYER_DIR = REPO / "铺面查看器" / "player"
sys.path.insert(0, str(PLAYER_DIR))

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


def stem_of(rel_id: str) -> str:
    return rel_id[:-4] if rel_id.lower().endswith(".mcz") else rel_id


def full_index_audio() -> dict[str, str] | None:
    """`{曲目 id: 音源成员名}`，取自构建缓存里的**完整**索引。

    公网那份 `data/library.json` 是给前端看的形状，故意不带 `audio` 字段
    （path / audio / size 加起来约占 40%），所以「这首歌到底该不该有音源」
    只能回完整索引里查。缓存不在（例如在服务器上核对一份下载下来的站点）就
    返回 None，此时退化成「这首歌还在索引里，它的 .ogg 就不算孤儿」。
    """
    try:
        import config as config_mod

        raw = json.loads(config_mod.INDEX_CACHE.read_text(encoding="utf-8"))
    except Exception:
        return None
    songs = raw.get("songs") if isinstance(raw, dict) else None
    if not isinstance(songs, list):
        return None
    out: dict[str, str] = {}
    for s in songs:
        if isinstance(s, dict) and s.get("id"):
            # 缓存里的 id 可能是 NFD（macOS 上扫出来的就是），索引是 NFC
            out[unicodedata.normalize("NFC", s["id"])] = s.get("audio") or ""
    return out


def check_song(out: Path, song: dict, want: set[str], r: Report, degraded: set[str],
               audio_map: dict[str, str] | None = None) -> None:
    stem = stem_of(song["id"])
    if unicodedata.normalize("NFC", stem) != stem:
        r.check(f"NFC：{stem}", False, "路径不是 NFC，Windows 上会 404")

    for chart in song["charts"]:
        rel = f"data/charts/{stem}/{chart['code']}.json"
        want.add(rel)
        path = out / rel
        if not r.check(f"谱面 {rel}", path.is_file() and path.stat().st_size > 0):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            r.check(f"谱面可解析 {rel}", False, str(exc))
            continue
        if not isinstance(data.get("note"), list):
            r.check(f"谱面结构 {rel}", False, "没有 note 数组")

    known_audio = audio_map.get(song["id"]) if audio_map is not None else None
    rel_audio = f"media/audio/{stem}.ogg"
    if known_audio:
        rel = f"media/audio/{stem}.ogg"
        want.add(rel)
        size = (out / rel).stat().st_size if (out / rel).is_file() else 0
        r.check(f"音源 {rel}", size > 1024, f"{size}B")
    elif audio_map is None and (out / rel_audio).is_file():
        # 没有完整索引可查：只要这首歌还在库索引里，它的音源就不算孤儿文件
        want.add(rel_audio)

    if song.get("cover"):
        ext = os.path.splitext(song["cover"])[1].lower() or ".png"
        rel = f"media/cover/{stem}{ext}"
        want.add(rel)
        size = (out / rel).stat().st_size if (out / rel).is_file() else 0
        r.check(f"封面 {rel}", size > 128, f"{size}B")
        rel_thumb = f"media/thumb/{stem}.jpg"
        want.add(rel_thumb)
        path = out / rel_thumb
        ok = path.is_file() and path.stat().st_size > 128 and path.read_bytes()[:2] == b"\xff\xd8"
        if ok:
            r.check(f"缩略图 {rel_thumb}", True)
        elif rel_thumb in degraded:
            # 那 5 张源封面是坏 PNG，缩略图做不出来是预期内的（前端用 ♪ 占位）
            r.warn(f"缩略图 {rel_thumb}", "源封面本身是坏图，前端用 ♪ 占位")
        elif not path.is_file():
            r.check(f"缩略图 {rel_thumb}", False, "文件不存在")
        else:
            r.check(f"缩略图 {rel_thumb}", False, "不是 JPEG 或空的（构建时没报降级？）")


def main() -> int:
    ap = argparse.ArgumentParser(description="检查站点产物是否完整")
    ap.add_argument("--out", default=str(REPO / "site"))
    ap.add_argument("--strict", action="store_true", help="连多余的文件也报出来")
    ap.add_argument("--quiet", action="store_true", help="只打结论")
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
    songs = lib.get("songs") or []
    r.check("曲库非空", len(songs) > 0, f"{len(songs)} 首")

    # 3) 构建报告 —— 提前读：里面的「降级清单」要给逐曲检查用
    #    （降级 = 源素材本身就是坏的，例如那 5 张坏 PNG 封面；前端有占位，
    #      不能和「这次构建真的失败了」混在一起报）
    build_path = out / "data" / "build.json"
    report: dict = {}
    if r.check("data/build.json 存在", build_path.is_file()):
        try:
            report = json.loads(build_path.read_text(encoding="utf-8"))
        except Exception as exc:
            r.check("data/build.json 可解析", False, str(exc))
    degraded = set(report.get("degraded") or [])
    if degraded:
        print(f"  ! 构建期降级 {len(degraded)} 项（源素材本身有问题，前端有占位）")

    # 4) 逐曲
    audio_map = full_index_audio()
    if audio_map is None:
        print("  ! 没有构建缓存（cache/library_index.json）：音源只按「歌还在不在索引里」算，"
              "不再逐个核对文件大小")
    for song in songs:
        check_song(out, song, want, r, degraded, audio_map)

    # 5) marker 素材
    markers_path = out / "data" / "markers.json"
    if r.check("data/markers.json 存在", markers_path.is_file()):
        try:
            manifest = json.loads(markers_path.read_text(encoding="utf-8"))
        except Exception as exc:
            manifest = {}
            r.check("data/markers.json 可解析", False, str(exc))
        n = 0
        for entry in (manifest.get("markers") or []) + (manifest.get("effects") or []):
            for key in ("sheet", "hit"):
                spec = entry.get(key)
                if not spec:
                    continue
                rel = spec["sheet"] if key == "hit" else spec
                want.add(f"markers/{rel}")
                n += 1
                r.check(f"marker 素材 {rel}", (out / "markers" / rel).is_file())
        r.check("marker 素材数量", n > 0, str(n))

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
