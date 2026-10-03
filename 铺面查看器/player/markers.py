"""marker 素材清单：官方提取的 jubeat marker（marker/jubeat_official/manifest.json）。

manifest 由 `tools/import_official_markers.py` 生成；这里只做「读取 → 裁剪 → 缓存」，
并把「贴图相对路径怎么拼」收敛成 `frame_rel()` 一处，构建脚本 / 校验脚本 / 前端
三方共用同一套约定，避免改名时漏改。

每个设计一套贴图，命名固定：

    <dir>/<prefix>_MA<NN>.png     浮动 / 提示，24 帧，第 15 帧 = 命中瞬间
    <dir>/<prefix>_H<t><NN>.png   命中爆发第 t 档（1=POOR … 4=PERFECT），16 帧，第 0 帧 = 命中瞬间
    <dir>/<prefix>_FR<NN>.png     面板边框（静态装饰，只有部分设计有）
"""
from __future__ import annotations

import json
import threading
from typing import Any

from config import MARKERS_ROOT
from media import safe_join

# 一个引擎时间单位 = 多少毫秒（实机逐帧比对得出，见 marker/jubeat_official/README.md）。
# manifest 里缺字段时用它兜底，避免坏 json 把动画速度拖回错的默认值。
DEFAULT_UNIT_MS = 3.3333

_cache: dict = {}
_lock = threading.Lock()


def frame_rel(design: dict, channel: str, frame: int) -> str:
    """一条贴图在 marker 目录里的相对路径。

    channel 传 "MA" / "H1"…"H4" / "FR"；frame 一律两位补零（贴图命名就是这个规则）。
    """
    return f"{design['dir']}/{design['prefix']}_{channel}{frame:02d}.png"


def design_assets(design: dict) -> list[str]:
    """某个设计实际存在、且前端会画的贴图（相对路径，按通道顺序）。"""
    out: list[str] = []
    for i in range(int(design.get("ma") or 0)):
        out.append(frame_rel(design, "MA", i))
    h = design.get("h") or {}
    for tier in sorted(h, key=lambda k: int(k)):
        for i in range(int(h[tier] or 0)):
            out.append(frame_rel(design, f"H{tier}", i))
    for i in range(int(design.get("fr") or 0)):
        out.append(frame_rel(design, "FR", i))
    return out


def _clean_design(raw: Any) -> dict | None:
    """挑出前端要用的字段；形状不对的设计直接丢掉，别把脏数据发到公网。"""
    if not isinstance(raw, dict):
        return None
    d = str(raw.get("dir") or "")
    prefix = str(raw.get("prefix") or "")
    # 只认素材包自己的命名（tex_l44_tmNNNN / TMNNNN），顺带挡掉任何带斜杠的怪值
    if not d.startswith("tex_l44_tm") or "/" in d or "\\" in d:
        return None
    if not prefix.startswith("TM") or "/" in prefix or "\\" in prefix:
        return None
    h: dict[str, int] = {}
    for tier, count in (raw.get("h") or {}).items():
        try:
            n = int(count)
        except (TypeError, ValueError):
            continue
        if str(tier) in ("1", "2", "3", "4") and n > 0:
            h[str(tier)] = n
    ma = int(raw.get("ma") or 0)
    fr = int(raw.get("fr") or 0)
    if ma <= 0 or not h:
        return None
    try:
        num = int(raw.get("num") or 0)
    except (TypeError, ValueError):
        num = 0
    return {
        "id": str(raw.get("id") or d),
        "num": num,
        "dir": d,
        "prefix": prefix,
        "name": str(raw.get("name") or d),
        "name_ja": str(raw.get("name_ja") or ""),
        "name_zh": str(raw.get("name_zh") or ""),
        "release": str(raw.get("release") or ""),
        "note": str(raw.get("note") or ""),
        "ma": ma,
        "h": h,
        "fr": max(0, fr),
    }


def _normalize(raw: dict) -> dict:
    """把 manifest 裁成「前端要读的那几个字段」。"""
    designs = [d for d in (_clean_design(x) for x in (raw.get("designs") or [])) if d]
    window = raw.get("hit_window_units") or {}
    return {
        "format": str(raw.get("format") or ""),
        "unit_ms": float(raw.get("unit_ms") or DEFAULT_UNIT_MS),
        "units_per_frame": float(raw.get("units_per_frame") or 10),
        "hit_window_units": {
            "early": float(window.get("early", -155)),
            "late": float(window.get("late", 160)),
        },
        "judge_tiers": raw.get("judge_tiers")
        or {"POOR": 1, "GOOD": 2, "GREAT": 3, "PERFECT": 4},
        # FR 通道里真正画出来的那一帧（官方 FR00 是全透明，FR01 才是边框）
        "fr": {"static_frame": int((raw.get("fr") or {}).get("static_frame", 1) or 1)},
        "designs": designs,
        "error": None,
    }


def manifest() -> dict:
    manifest_path = MARKERS_ROOT / "manifest.json"
    try:
        stamp = manifest_path.stat().st_mtime_ns
    except OSError:
        stamp = 0
    with _lock:
        if _cache.get("root") == str(MARKERS_ROOT) and _cache.get("stamp") == stamp:
            return _cache["data"]

    data: dict = {"format": "", "designs": [], "error": None}
    if not manifest_path.is_file():
        data["error"] = f"marker 清单不存在：{MARKERS_ROOT}"
    else:
        try:
            data = _normalize(json.loads(manifest_path.read_text(encoding="utf-8")))
        except Exception as exc:  # 坏 json / 坏字段：宁可空清单，别让接口 500
            data = {"format": "", "designs": [], "error": f"manifest.json: {exc}"}
    if not data["designs"] and not data["error"]:
        data["error"] = "manifest.json 里没有一个可用设计"

    with _lock:
        _cache.update(root=str(MARKERS_ROOT), stamp=stamp, data=data)
    return data


def asset_path(rel: str):
    """marker 素材文件路径（带穿越检查 + macOS 重名副本过滤）。"""
    dest = safe_join(MARKERS_ROOT, rel)
    if " 2." in dest.name:  # macOS 复制产生的重名副本
        raise FileNotFoundError(rel)
    if not dest.is_file():
        raise FileNotFoundError(rel)
    return dest
