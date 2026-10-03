#!/usr/bin/env python3
"""把「jubeat marker 提取」素材包导入仓库 marker/jubeat_official/。

素材包来源：从街机 jubeat（beyond the ave.，l44 资源）的
`contents/data/d3/model/*.bin`（PXET → PMAN → orglz → TDXT）里逐帧解出来的
官方 marker 贴图。动画/判定规格见包内 `ANIMATION.md` 与
`out/markers/markers_anim_spec.json`。

用法：

    python3 tools/import_official_markers.py --src "/path/到/jubeat marker提取"

可选：
    --dest DIR     输出目录（默认 <repo>/marker/jubeat_official）
    --tiers 1,2,3,4  要收录的命中爆发档（默认只有 4 = PERFECT）

只复制前端真正会画的通道：

    MA00…MA23   浮动 / 提示（24 帧，第 15 帧 = 命中瞬间）
    H{t}00…H{t}15  命中爆发第 t 档（第 0 帧 = 命中瞬间）
    FR00…FR01   面板边框（静态装饰，只有部分设计有）

不复制：mini 版（`*_m`，40×40）、`_sheets/`、`_src/`、商店图标、总览图 —— 前端用不上。

为什么默认只收第 4 档（PERFECT）：本查看器是「按谱面自动全 PERFECT 播放」，
只会用到 PERFECT 的爆发动画；把另外三档（GREAT/GOOD/POOR）也塞进来会让
仓库和安装包多出 ≈42 MB 的**永远画不到**的贴图。想全收就加 `--tiers 1,2,3,4`。
（前端遇到缺档会自动回落到第 4 档，所以少收也不会画崩。）
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 一个引擎时间单位 = 多少毫秒。
# 游戏里每个动画帧 = 10 单位。实机逐帧比对（30.000 fps 实机录像：MA 每帧恰好对上
# 录像一帧 → 1 动画帧 = 1/30 s ≈ 33.333 ms）给出 1 单位 = 3.3333 ms。
# 参考与推导过程见 marker/jubeat_official/README.md「单位 → 毫秒」。
UNIT_MS = 3.3333

# 一个设计里要收的通道：前缀 → 帧数（帧文件名里的序号一律两位补零）
MA_FRAMES = 24
H_FRAMES = 16
FR_FRAMES = 2


def _copy_frames(src_dir: Path, dest_dir: Path, prefix: str, channel: str,
                 count: int) -> int:
    """复制 <prefix>_<channel><NN>.png，返回复制成功的张数。缺帧不算错（有些设计不满帧）。"""
    dest_dir.mkdir(parents=True, exist_ok=True)
    copied = 0
    for i in range(count):
        name = f"{prefix}_{channel}{i:02d}.png"
        src = src_dir / name
        if not src.is_file():
            continue
        shutil.copyfile(src, dest_dir / name)
        copied += 1
    return copied


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="素材包根目录（含 out/markers/ 的那个）")
    ap.add_argument("--dest", default=str(REPO / "marker" / "jubeat_official"))
    ap.add_argument("--tiers", default="4",
                    help="要收录的命中爆发档，逗号分隔（默认 4，即只收 PERFECT）")
    args = ap.parse_args()

    src = Path(args.src).expanduser().resolve()
    banks = src / "out" / "markers"
    if not banks.is_dir():
        print(f"找不到素材目录：{banks}", file=sys.stderr)
        return 1

    tiers = []
    for tok in str(args.tiers).split(","):
        tok = tok.strip()
        if not tok:
            continue
        t = int(tok)
        if t not in (1, 2, 3, 4):
            print(f"命中档只能是 1–4（收到 {t}）", file=sys.stderr)
            return 1
        if t not in tiers:
            tiers.append(t)
    if not tiers:
        print("至少要收一档命中爆发", file=sys.stderr)
        return 1
    tiers.sort()

    # 名字表：编号 → 日文 / 英文 / 中文 / 世代。没有它就退化只用编号。
    names: dict[int, dict] = {}
    names_path = banks / "marker_names.json"
    if names_path.is_file():
        table = json.loads(names_path.read_text(encoding="utf-8"))
        for row in table.get("markers") or []:
            try:
                names[int(row["tm"])] = row
            except (KeyError, TypeError, ValueError):
                continue

    dest = Path(args.dest).expanduser().resolve()
    # 只清掉上一次导入的贴图目录，不碰 README / manifest（那两个由仓库维护）
    for old in sorted(dest.glob("tex_l44_tm*")):
        if old.is_dir():
            shutil.rmtree(old)
    dest.mkdir(parents=True, exist_ok=True)

    designs = []
    total_files = 0
    total_bytes = 0
    for d in sorted(banks.glob("tex_l44_tm*")):
        if not d.is_dir() or d.name.endswith("_m"):
            continue
        suffix = d.name[len("tex_l44_tm"):]
        if not suffix.isdigit():
            continue
        num = int(suffix)
        prefix = f"TM{num:04d}"

        # 联动 marker 的美术没随版本进包（提取文档里标成「⚠️ 替代贴图」：tm0041 与
        # tm0043 的 88 帧逐像素完全相同，其实是 Qubell 的占位图）。这种素材放进
        # 「官方 marker」列表只会误导人 —— 直接不收录。
        row = names.get(num) or {}
        if row.get("art_status") not in (None, "ok"):
            print(f"跳过 {d.name}：素材是替代贴图（art_status={row.get('art_status')}）",
                  file=sys.stderr)
            continue

        out_dir = dest / d.name
        out_dir.mkdir(parents=True, exist_ok=True)
        ma = _copy_frames(d, out_dir, prefix, "MA", MA_FRAMES)
        if ma < MA_FRAMES:
            print(f"⚠️  {d.name}: MA 只有 {ma}/{MA_FRAMES} 帧", file=sys.stderr)
        h_counts = {}
        for t in tiers:
            n = _copy_frames(d, out_dir, prefix, f"H{t}", H_FRAMES)
            if n:
                h_counts[str(t)] = n
        fr = _copy_frames(d, out_dir, prefix, "FR", FR_FRAMES)

        files = sorted(p for p in out_dir.iterdir() if p.is_file())
        size = sum(p.stat().st_size for p in files)
        total_files += len(files)
        total_bytes += size

        designs.append({
            "id": f"tm{num:04d}",
            "num": num,
            "dir": d.name,
            "prefix": prefix,
            "name": row.get("name_en") or row.get("name_ja") or f"Marker {num:04d}",
            "name_ja": row.get("name_ja") or "",
            "name_zh": row.get("name_zh") or "",
            "release": row.get("release") or "",
            "ma": ma,
            "h": h_counts,
            "fr": fr,
        })

    manifest = {
        "format": "jubeat-official",
        "game": "jubeat (beyond the ave., tex_l44)",
        "unit_ms": UNIT_MS,
        "units_per_frame": 10,
        "hit_window_units": {"early": -155, "late": 160},
        "ma": {"frames": MA_FRAMES, "hit_frame": 15, "start_units": -155, "end_units": 84},
        "h": {"tiers": tiers, "frames_per_tier": H_FRAMES, "hit_frame": 0,
              "end_units": 160},
        "fr": {"frames": FR_FRAMES, "static_frame": 1},
        "judge_tiers": {"POOR": 1, "GOOD": 2, "GREAT": 3, "PERFECT": 4},
        "designs": designs,
    }
    (dest / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    print(f"导入 {len(designs)} 套设计 · {total_files} 张 PNG · {total_bytes / 1048576:.1f} MB")
    print(f"输出：{dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
