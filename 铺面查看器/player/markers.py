"""marker 素材清单（manifest + 逐目录 fallback）。"""
from __future__ import annotations

import json
import threading

from config import MARKERS_ROOT
from media import safe_join

_cache: dict = {}
_lock = threading.Lock()


def _clean_sheet(rel: str) -> str:
    """manifest 里的 sheet 路径规范化：去掉 './' 前缀，统一用正斜杠。"""
    rel = str(rel or "").replace("\\", "/")
    while rel.startswith("./"):
        rel = rel[2:]
    return rel.lstrip("/")


def _normalize(data: dict) -> dict:
    # generated_by 是素材库的来路记录（指向构建脚本名），没必要跟着产物发到公网
    data.pop("generated_by", None)
    for entry in list(data.get("markers") or []) + list(data.get("effects") or []):
        if isinstance(entry.get("sheet"), str):
            entry["sheet"] = _clean_sheet(entry["sheet"])
        hit = entry.get("hit")
        if isinstance(hit, dict) and isinstance(hit.get("sheet"), str):
            hit["sheet"] = _clean_sheet(hit["sheet"])
    return data


def _fallback_entries() -> dict:
    """没有 manifest.json 时，直接按 meta.json 扫目录（anchor 用最后一帧）。"""
    data: dict = {"fps": 30, "markers": [], "effects": [], "error": None}
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
            data[key].append({
                "id": meta.get("id") or d.name,
                "name": meta.get("name") or d.name,
                "note": meta.get("note", ""),
                "source": meta.get("source", ""),
                "kind": "effect" if folder == "effects" else "marker",
                "frames": frames,
                "fps": meta.get("fps", 30),
                "cell": cell,
                "cols": cols,
                "rows": rows,
                "sheet": f"{folder}/{d.name}/sprite_sheet.png",
                "anchor": frames - 1,
                "hit": None,
            })
    return data


def manifest() -> dict:
    manifest_path = MARKERS_ROOT / "manifest.json"
    try:
        stamp = manifest_path.stat().st_mtime_ns
    except OSError:
        stamp = 0
    with _lock:
        if _cache.get("root") == str(MARKERS_ROOT) and _cache.get("stamp") == stamp:
            return _cache["data"]

    # 注意别把 root（本机绝对路径）放进 data：这个 dict 会直接当 /data/markers.json 发出去，
    # 缓存的失效判断用下面的 _cache["root"]，和载荷无关。
    data: dict = {"fps": 30, "markers": [], "effects": [], "error": None}
    if manifest_path.is_file():
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
            data.update(
                fps=raw.get("fps", 30),
                markers=raw.get("markers") or [],
                effects=raw.get("effects") or [],
                anchor_rule=raw.get("anchor_rule", ""),
            )
        except Exception as exc:
            data["error"] = f"manifest.json: {exc}"
    elif (MARKERS_ROOT / "markers").is_dir():
        data.update(_fallback_entries())
    else:
        data["error"] = f"marker 目录不存在：{MARKERS_ROOT}"

    _normalize(data)
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
