#!/usr/bin/env python3
"""响应头多端一致性静态检查（不启动服务、不依赖网络）。

同一个站点有五处会发响应头：

  * Python 开发服务器  jubeat_viewer/player/server.py        （基准，只读）
  * PHP 单文件入口      deploy/php/index.php
  * Electron 静态服务   electron/site-server.js
  * Android 静态服务    android/.../LocalServer.java
  * 线上 nginx          deploy/security-headers.conf

第一部分是 Cache-Control：四类资源必须按同一套语义（对齐 Python 开发服务器）：
  audio / data-charts → 1 天 (86400)、cover-thumb → 7 天 (604800)、
  markers → 300 秒，其余资源 no-cache。

以前三端各说各话：PHP 把 markers 设成 7 天、media/* 一律 no-cache；
Electron / Android 把 media/* 一律 7 天、其它 no-cache。

第二部分是 CSP：五处的指令必须逐条同序（nginx 多一条 upgrade-insecure-requests，
因为只有它确定跑在 HTTPS 上；PHP 按请求协议决定加不加）。这里纯粹解析源码里的
字面量，逐类断言一致，不启动任何服务、不需要 php / node / javac、不联网。
改了任一端却忘了同步，这里就会红。

    python3 tools/test_cache_headers.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SOURCES = {
    "python":   REPO / "jubeat_viewer" / "player" / "server.py",
    "php":      REPO / "deploy" / "php" / "index.php",
    "electron": REPO / "electron" / "site-server.js",
    "android":  REPO / "android" / "app" / "src" / "world" / "thregren" / "jubeatviewer" / "LocalServer.java",
}

# CSP 是「全站默认策略」，比缓存头多一处：线上 nginx 的 snippet。
# （deploy/php/nginx-php.conf.example 与 deploy/php/.htaccess 内联了同一串，
#   属于部署示例，不参与断言——它们没有自动化的运行路径。）
CSP_SOURCES = dict(SOURCES, nginx=REPO / "deploy" / "security-headers.conf")

# 一条 CSP 的完整指令序列（顺序即断言顺序：nginx 里 frame-ancestors 在 form-action 前，
# 以前 Electron / Android 是反的，看着无害，但「同序」是让人肉眼比得出来的前提）。
CSP_TOKENS = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "form-action 'none'",
]

# 只有确定跑在 HTTPS 上的端才发 upgrade-insecure-requests：
# 客户端本地服务与开发服务器都是明文回环，发了会把自己升级成 https://127.0.0.1。
CSP_UPGRADE = {"nginx", "php"}

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


def ordered_hits(text: str, tokens: list[str]) -> list[str]:
    """按顺序逐个查找，返回「找不到或顺序不对」的那些 token。

    CSP 在各端被拆成不同形状的字符串字面量（数组、拼接、单行 add_header），
    直接比较整串没法跨语言；只要「每条指令都出现、且出现位置递增」，就能把
    漏一条、写错一条、以及调换顺序都抓出来。
    """
    cursor, missing = 0, []
    for token in tokens:
        found = text.find(token, cursor)
        if found < 0:
            missing.append(token)
        else:
            cursor = found + len(token)
    return missing


COMMENT_PREFIX = ("#", "//", "*", "/*", "<!--")


def csp_region(text: str) -> str:
    """截出「CSP 字面量」那一段，把注释和语法噪音去掉再断言。

    不能直接扫全文：五处都在注释里讨论过 unsafe-inline / upgrade-insecure-requests
    （比如 Electron 的注释就写着「只去掉 upgrade-insecure-requests」），全文匹配会
    把说明文字当成实际指令。这里先丢掉整行注释，再从 default-src 截到 form-action
    之后一小段（PHP 把 upgrade 拼在字面量后面），最后抹掉引号/加号/续行符。
    """
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith(COMMENT_PREFIX)]
    clean = "\n".join(lines)
    start = clean.find("default-src 'self'")
    if start < 0:
        return ""
    end = clean.find("form-action 'none'", start)
    end = len(clean) if end < 0 else end + 400
    return clean[start:end].replace('"', "").replace("+", "").replace("\\", "")


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

    print("\n[CSP] 五处指令逐条同序")
    regions = {name: csp_region(path.read_text(encoding="utf-8"))
               for name, path in CSP_SOURCES.items()}
    for name, region in regions.items():
        missing = ordered_hits(region, CSP_TOKENS)
        check(f"{name} 含全部 {len(CSP_TOKENS)} 条指令且同序",
              not missing and bool(region), f"缺/乱序 {missing or '整段没找到'}")
        has_upgrade = "upgrade-insecure-requests" in region
        check(f"{name} upgrade-insecure-requests {'有' if name in CSP_UPGRADE else '无'}",
              has_upgrade == (name in CSP_UPGRADE), f"实际 {'有' if has_upgrade else '无'}")

    print("\n[CSP] 收紧项没被放松（这是最容易「顺手放开」的地方）")
    for name, region in regions.items():
        check(f"{name} 无 unsafe-inline / unsafe-eval",
              "unsafe-inline" not in region and "unsafe-eval" not in region)
        check(f"{name} img-src 不含 data:", "img-src 'self' data:" not in region)
        check(f"{name} 保留 media-src 的 blob:（前端复用已下载音源）",
              "media-src 'self' blob:" in region)

    print()
    if failures:
        print(f"\033[31m✗ {len(failures)} 项失败\033[0m")
        return 1
    print("\033[32m✓ 全部通过：缓存头四档 + CSP 五处在各端一致\033[0m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
