"""运行时配置与路径解析。

所有路径都可以用环境变量覆盖，方便本机跑 / 丢到 VPS（宝塔 nginx 反代）上跑：

    JUBEAT_HOST        监听地址（默认 127.0.0.1，用 nginx 反代时不用改）
    JUBEAT_PORT        监听端口（默认 8765）
    JUBEAT_LIBRARY     曲库目录（默认 <repo>/music）
    JUBEAT_MARKERS     marker 素材目录（默认 <repo>/marker/jubeat_official）
    JUBEAT_CACHE       缓存目录（默认 <repo>/cache）：音频/封面/缩略图/索引
    JUBEAT_X_ACCEL     设成 nginx 内部 location（例如 /_audio/）后，音频走 X-Accel-Redirect
                       交给 nginx 直接 sendfile，Python 不参与传输
    JUBEAT_THUMB_SIZE  列表封面缩略图边长（默认 96）

两点约定：

* 环境变量统一走 _env()，顺手做 strip / 类型夹取；解析失败一律回落到默认值，
  不因为一个手滑的环境变量把服务端起不来。
* 曲库 / marker 目录是**惰性解析**的：只有真去访问 config.LIBRARY 时才扫盘。
  以前是在 import 时就算，连只想读个缩略图参数的脚本都要先扫一遍磁盘。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

import version as version_mod

PLAYER_DIR = Path(__file__).resolve().parent   # …/铺面查看器/player
APP_DIR = PLAYER_DIR.parent                    # …/铺面查看器
REPO = APP_DIR.parent                          # 仓库根（含 music/ 与 marker/）
STATIC_DIR = PLAYER_DIR / "static"

APP_VERSION = version_mod.read_version()       # 唯一来源：仓库根的 VERSION 文件

LIBRARY_NAME = "music"
LEGACY_LIBRARY_NAMES = ("Jubeat2Malody-GUI-mcz-releases",)
# 官方提取的 marker 素材（逐帧 PNG + manifest.json，见 marker/jubeat_official/README.md）
MARKERS_NAME = "jubeat_official"
# 可选音效素材目录（clap/nyan/don/ka 等 .ogg/.mp3/.wav/.m4a），不入库；没有就用合成音
SE_NAME = "se"
SE_DIR = REPO / SE_NAME


def _env(name: str) -> str:
    """环境变量取值（去掉首尾空白）。没设 / 只设了空白都算「没设」。"""
    return (os.environ.get(name) or "").strip()


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    """整型环境变量，带区间夹取；写坏了就用默认值，不抛异常。"""
    raw = _env(name)
    if not raw:
        return default
    try:
        return max(lo, min(hi, int(raw)))
    except ValueError:
        return default


HOST = _env("JUBEAT_HOST") or "127.0.0.1"
PORT = _env_int("JUBEAT_PORT", 8765, 1, 65535)

_cache_env = _env("JUBEAT_CACHE")
CACHE_DIR = Path(_cache_env).expanduser() if _cache_env else REPO / "cache"
AUDIO_CACHE_DIR = CACHE_DIR / "audio"
COVER_CACHE_DIR = CACHE_DIR / "covers"
THUMB_CACHE_DIR = CACHE_DIR / "thumbs"
INDEX_CACHE = CACHE_DIR / "library_index.json"
# 索引结构版本，改字段就 +1，旧缓存自动作废。
# v3：charts[].notesKnown 新增；缓存里多了 fingerprint（曲库指纹，见 library.fingerprint）
INDEX_VERSION = 3

# nginx 内部 location 前缀；设了才会返回 X-Accel-Redirect。
# 统一成「恰好一个结尾斜杠」：/_audio 与 /_audio/ 两种写法行为一致（以前
# 同一份 env 被读了三次，逻辑散在表达式里，改一处容易漏）。
_x_accel = _env("JUBEAT_X_ACCEL").rstrip("/")
X_ACCEL_PREFIX = (_x_accel + "/") if _x_accel else ""

THUMB_SIZE = _env_int("JUBEAT_THUMB_SIZE", 96, 32, 512)
THUMB_QUALITY = _env_int("JUBEAT_THUMB_QUALITY", 82, 40, 95)

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
    """找曲库：环境变量 → 项目内 → 仓库根目录 → 旧目录名 → 常见位置。

    以前还写死了一个个人目录（~/XiaomiMiMoProjects/…）。别人的机器上这个路径
    只会在每次启动时白扫一遍；真要指定就用 JUBEAT_LIBRARY。
    """
    candidates: list[Path] = []
    env = _env("JUBEAT_LIBRARY")
    if env:
        candidates.append(Path(env).expanduser())
    candidates += [
        APP_DIR / LIBRARY_NAME,
        REPO / LIBRARY_NAME,
        *(REPO / name for name in LEGACY_LIBRARY_NAMES),
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
    env = _env("JUBEAT_MARKERS")
    if env:
        return Path(env).expanduser().resolve()
    for cand in (REPO / "marker" / MARKERS_NAME, REPO / MARKERS_NAME, PLAYER_DIR / MARKERS_NAME):
        if (cand / "manifest.json").is_file() or (cand / "markers").is_dir():
            return cand.resolve()
    return (REPO / "marker" / MARKERS_NAME).resolve()


_lazy: dict[str, object] = {}


def _cached(key: str, fn: Callable[[], Path]) -> Path:
    """惰性 + 只算一次：曲库目录在进程生命周期里不会变，不用每次请求都扫盘。"""
    if key not in _lazy:
        _lazy[key] = fn()
    return _lazy[key]  # type: ignore[return-value]


def library_dir() -> Path:
    return _cached("library", resolve_library)


def markers_root() -> Path:
    return _cached("markers", resolve_markers)


def __getattr__(name: str) -> Path:
    """config.LIBRARY / config.MARKERS_ROOT 保持可用，但改成用到才算（PEP 562）。"""
    if name == "LIBRARY":
        return library_dir()
    if name == "MARKERS_ROOT":
        return markers_root()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def ensure_cache_dirs() -> None:
    for d in (CACHE_DIR, AUDIO_CACHE_DIR, COVER_CACHE_DIR, THUMB_CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)
