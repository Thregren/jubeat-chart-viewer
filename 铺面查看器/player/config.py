"""运行时配置与路径解析。

所有路径都可以用环境变量覆盖，方便本机跑 / 丢到 VPS（宝塔 nginx 反代）上跑：

    JUBEAT_HOST        监听地址（默认 127.0.0.1，用 nginx 反代时不用改）
    JUBEAT_PORT        监听端口（默认 8765）
    JUBEAT_LIBRARY     曲库目录（默认 <repo>/music）
    JUBEAT_MARKERS     marker 素材目录（默认 <repo>/marker/jubeat_marker_frames）
    JUBEAT_CACHE       缓存目录（默认 <repo>/cache）：音频/封面/缩略图/索引
    JUBEAT_X_ACCEL     设成 nginx 内部 location（例如 /_audio/）后，音频走 X-Accel-Redirect
                       交给 nginx 直接 sendfile，Python 不参与传输
    JUBEAT_THUMB_SIZE  列表封面缩略图边长（默认 96）
"""
from __future__ import annotations

import os
from pathlib import Path

PLAYER_DIR = Path(__file__).resolve().parent   # …/铺面查看器/player
APP_DIR = PLAYER_DIR.parent                    # …/铺面查看器
REPO = APP_DIR.parent                          # …/Jubeat铺面查看（仓库根，含 music/ 与 marker/）
STATIC_DIR = PLAYER_DIR / "static"

LIBRARY_NAME = "music"
LEGACY_LIBRARY_NAMES = ("Jubeat2Malody-GUI-mcz-releases",)
MARKERS_NAME = "jubeat_marker_frames"
# 可选音效素材目录（clap/nyan/don/ka 等 .ogg/.mp3/.wav/.m4a），不入库；没有就用合成音
SE_NAME = "se"
SE_DIR = REPO / SE_NAME

HOST = os.environ.get("JUBEAT_HOST", "127.0.0.1").strip() or "127.0.0.1"
try:
    PORT = int(os.environ.get("JUBEAT_PORT", "8765"))
except ValueError:
    PORT = 8765

_cache_env = os.environ.get("JUBEAT_CACHE", "").strip()
CACHE_DIR = Path(_cache_env).expanduser() if _cache_env else REPO / "cache"
AUDIO_CACHE_DIR = CACHE_DIR / "audio"
COVER_CACHE_DIR = CACHE_DIR / "covers"
THUMB_CACHE_DIR = CACHE_DIR / "thumbs"
INDEX_CACHE = CACHE_DIR / "library_index.json"
INDEX_VERSION = 2  # 索引结构版本，改字段就 +1，旧缓存自动作废

# nginx 内部 location 前缀；设了才会返回 X-Accel-Redirect
X_ACCEL_PREFIX = os.environ.get("JUBEAT_X_ACCEL", "").strip().rstrip("/") + ("/" if os.environ.get("JUBEAT_X_ACCEL", "").strip() else "")

try:
    THUMB_SIZE = max(32, min(512, int(os.environ.get("JUBEAT_THUMB_SIZE", "96"))))
except ValueError:
    THUMB_SIZE = 96
try:
    THUMB_QUALITY = max(40, min(95, int(os.environ.get("JUBEAT_THUMB_QUALITY", "82"))))
except ValueError:
    THUMB_QUALITY = 82

GZIP_MIN_BYTES = 1024          # 小于这个大小的 JSON 不值得压缩
COVER_CACHE_MAX = 600          # 内存里缓存的封面条数（小图，几十 KB 级）


def _has_songs(path: Path) -> bool:
    try:
        if not path.is_dir():
            return False
        for _ in path.glob("**/*.mcz"):
            return True
    except OSError:
        return False
    return False


def resolve_library() -> Path:
    """找曲库：环境变量 → 项目内 → 仓库根目录 → 旧目录名 → 常见位置。"""
    candidates: list[Path] = []
    env = os.environ.get("JUBEAT_LIBRARY", "").strip()
    if env:
        candidates.append(Path(env).expanduser())
    candidates += [
        APP_DIR / LIBRARY_NAME,
        REPO / LIBRARY_NAME,
        *(REPO / name for name in LEGACY_LIBRARY_NAMES),
        *(Path.home() / "XiaomiMiMoProjects" / "jubeat铺面播放" / name
          for name in (LIBRARY_NAME, *LEGACY_LIBRARY_NAMES)),
        Path.home() / "Documents" / LIBRARY_NAME,
        Path.home() / "Downloads" / LIBRARY_NAME,
    ]
    for parent in (REPO, APP_DIR, REPO.parent, Path.home() / "Documents"):
        try:
            candidates += sorted(parent.glob(f"*/{LIBRARY_NAME}"))
            candidates += sorted(parent.glob(f"*/{LEGACY_LIBRARY_NAMES[0]}"))
        except OSError:
            pass

    seen: set[str] = set()
    for cand in candidates:
        key = str(cand)
        if key in seen:
            continue
        seen.add(key)
        if _has_songs(cand):
            return cand.resolve()
    return (REPO / LIBRARY_NAME).resolve()


def resolve_markers() -> Path:
    env = os.environ.get("JUBEAT_MARKERS", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    for cand in (REPO / "marker" / MARKERS_NAME, REPO / MARKERS_NAME, PLAYER_DIR / MARKERS_NAME):
        if (cand / "manifest.json").is_file() or (cand / "markers").is_dir():
            return cand.resolve()
    return (REPO / "marker" / MARKERS_NAME).resolve()


LIBRARY = resolve_library()
MARKERS_ROOT = resolve_markers()


def ensure_cache_dirs() -> None:
    for d in (CACHE_DIR, AUDIO_CACHE_DIR, COVER_CACHE_DIR, THUMB_CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)
