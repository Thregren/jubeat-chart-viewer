#!/usr/bin/env python3
"""缓存头四端一致性静态检查（不启动服务、不依赖网络）。

同一个站点有四套后端会发 Cache-Control：

  * Python 开发服务器  铺面查看器/player/server.py        （基准，只读）
  * PHP 单文件入口      deploy/php/index.php
  * Electron 静态服务   electron/site-server.js
  * Android 静态服务    android/.../LocalServer.java

四类资源必须按同一套语义（对齐 Python 开发服务器 server.py）：
  audio / data-charts → 1 天 (86400)、cover-thumb → 7 天 (604800)、
  markers → 300 秒，其余资源 no-cache。

以前三端各说各话：PHP 把 markers 设成 7 天、media/* 一律 no-cache；
Electron / Android 把 media/* 一律 7 天、其它 no-cache。这里纯粹解析四份
源码里的 Cache-Control 分支字面量，逐类断言四端一致，不启动任何服务、不需要
php / node / javac、不联网。改了任一端的缓存策略却忘了同步，这里就会红。

    python3 tools/test_cache_headers.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SOURCES = {
    "python":   REPO / "铺面查看器" / "player" / "server.py",
    "php":      REPO / "deploy" / "php" / "index.php",
    "electron": REPO / "electron" / "site-server.js",
    "android":  REPO / "android" / "app" / "src" / "world" / "thregren" / "jubeatviewer" / "LocalServer.java",
}

# 四类资源 → 期望档位（秒）。契约取自 Python 开发服务器 server.py 的既有语义，
# 也是 PHP / Electron / Android 三端要对齐到的值。
EXPECTED = {
    "audio":       86400,
    "cover-thumb": 604800,
    "data-charts": 86400,
    "markers":     300,
}

PASS, FAIL = "\033[32m✓\033[0m", "\033[31m✗\033[0m"
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"  {PASS} {name}")
    else:
        print(f"  {FAIL} {name}  {detail}")
        failures.append(name)


def read(name: str) -> str:
    path = SOURCES[name]
    if not path.is_file():
        raise SystemExit(f"找不到源码：{path}")
    return path.read_text(encoding="utf-8")


def window_value(lines: list[str], anchor_re: str, span: int) -> int | None:
    """找第一个匹配 anchor_re 的行，向下 span 行内取第一个 max-age=<秒数>。

    各端都把缓存策略写成「分支头行判断路径，下一两行 return 具体值」的形式，
    所以一个很小的窗口就足以把「资源类型」和「档位」关联起来，无需执行代码。
    """
    for i, line in enumerate(lines):
        if re.search(anchor_re, line):
            for j in range(i, min(i + span, len(lines))):
                m = re.search(r"max-age=(\d+)", lines[j])
                if m:
                    return int(m.group(1))
    return None


def extract_generic(text: str) -> dict[str, int | None]:
    """PHP / Electron / Android：缓存策略集中在 cacheControl/jubeat_cache_control 里，
    分支头统一用 str_starts_with / startsWith 判断资源路径。
    """
    lines = text.splitlines()
    head = r"(startsWith|str_starts_with)"
    return {
        "audio":       window_value(lines, head + r".*media/audio/", 2),
        "cover-thumb": window_value(lines, head + r".*media/cover/", 2),
        "data-charts": window_value(lines, head + r".*data/charts/", 2),
        "markers":     window_value(lines, head + r".*markers/", 2),
    }


def extract_python(text: str) -> dict[str, int | None]:
    """Python server.py 是只读基准，缓存头散落在各处理函数里，按函数/分支定位。"""
    lines = text.splitlines()
    return {
        "audio":       window_value(lines, r'kind == "audio"', 8),
        "cover-thumb": window_value(lines, r'kind == "cover"', 4),
        "data-charts": window_value(lines, r"def _media_chart", 20),
        "markers":     window_value(lines, r"def _serve_marker", 5),
    }


def main() -> int:
    texts = {name: read(name) for name in SOURCES}
    policies = {
        "python":   extract_python(texts["python"]),
        "php":      extract_generic(texts["php"]),
        "electron": extract_generic(texts["electron"]),
        "android":  extract_generic(texts["android"]),
    }

    print("[基准] python server.py 四类取值")
    base = policies["python"]
    for kind, want in EXPECTED.items():
        got = base[kind]
        check(f"python {kind} = {want}", got == want, f"实际 {got!r}")

    print("\n[一致性] php / electron / android 逐类对齐 python 基准")
    for name in ("php", "electron", "android"):
        for kind, want in EXPECTED.items():
            got = policies[name][kind]
            check(f"{name} {kind} == python ({want})",
                  got == want, f"实际 {got!r}")

    print("\n[结构] 每端保留 no-cache 且三档 max-age 都出现（防止一刀切）")
    tiers = tuple(dict.fromkeys(EXPECTED.values()))  # 86400 / 604800 / 300
    for name, text in texts.items():
        has_no_cache = "no-cache" in text
        has_tiers = all(f"max-age={n}" in text for n in tiers)
        check(f"{name} 含 no-cache + {'/'.join(str(n) for n in tiers)} 三档",
              has_no_cache and has_tiers,
              f"no-cache={has_no_cache} 三档={has_tiers}")

    print("\n[PHP 专有] 内容哈希资源仍走一年 immutable")
    check("php 保留 max-age=31536000, immutable",
          "max-age=31536000, immutable" in texts["php"])

    print()
    if failures:
        print(f"\033[31m✗ {len(failures)} 项失败\033[0m")
        return 1
    print("\033[32m✓ 全部通过：四类资源在四端配置一致\033[0m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
