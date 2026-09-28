#!/usr/bin/env python3
"""把版本号同步到所有该改的地方（前端 ?v= / Electron 包版本）。

    python3 tools/set_version.py 0.6.2
    python3 tools/set_version.py --check     # 有地方没跟上就退出码 1

权威值只有一个：仓库根目录的 VERSION（读写逻辑见
铺面查看器/player/version.py）。这个脚本负责把它铺到下面几处，并用 --check
在 CI 里守住「有人手改了其中一处」的情况：

    铺面查看器/player/static/index.html   static/*.js|css 后面的 ?v=
    electron/package.json                "version"
    electron/package-lock.json           "version"（顶层 + packages.""）

README / release note 里的版本号是给人读的，不强制同步（--check 不看它们）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "铺面查看器" / "player"))
from version import (  # noqa: E402
    REPO,
    SEMVER_RE,
    V_QUERY_FIND,
    V_QUERY_RE,
    VERSION_FILE,
    html_versions,
    read_version,
)

INDEX_HTML = REPO / "铺面查看器" / "player" / "static" / "index.html"
# 构建产物里的那份 index.html 拷贝（site/ 是 gitignore 的，由 tools/build_site.py 生成）。
# 它也带着一整排 ?v=：改了源却忘了重建 site/，线上就会变成「新 HTML + 老 JS」。
SITE_INDEX = REPO / "site" / "index.html"
PACKAGE_JSON = REPO / "electron" / "package.json"
PACKAGE_LOCK = REPO / "electron" / "package-lock.json"

# 侧栏标题右边那枚版本号徽章（#brandVer）。
# app.js 启动时也会用 script 标签的 ?v= 覆盖一遍，但 HTML 里必须自己带一份：
# 万一脚本被 12h 缓存挡住，页面至少还能显示版本号，不会空着一块。
BRAND_VER_RE = re.compile(
    r'(<span class="brand-ver" id="brandVer"[^>]*>)v([0-9A-Za-z.\-]*)(</span>)'
)


def _pkg_versions(path: Path) -> list[str]:
    """package.json / package-lock.json 里记版本号的位置。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    found = [data.get("version")]
    packages = data.get("packages")
    if isinstance(packages, dict) and isinstance(packages.get(""), dict):
        found.append(packages[""].get("version"))
    return [v for v in found if v]


def _bump_pkg(path: Path, version: str) -> bool:
    """只替换顶层 version 与 packages."" 的 version，别的字段不动（保持原缩进）。"""
    raw = path.read_text(encoding="utf-8")
    out = re.sub(r'("version"\s*:\s*)"[^"]*"', rf'\g<1>"{version}"', raw, count=1)
    # packages 里的那一份：文件里第二次出现的 "version" 才是它
    if '"packages"' in out:
        head, sep, tail = out.partition('"packages"')
        tail2 = re.sub(r'("version"\s*:\s*)"[^"]*"', rf'\g<1>"{version}"', tail, count=1)
        out = head + sep + tail2
    if out == raw:
        return False
    path.write_text(out, encoding="utf-8")
    return True


def _bump_index(version: str) -> int:
    return _bump_html(INDEX_HTML, version)


def _bump_html(path: Path, version: str) -> int:
    """把某个 index.html 里的 ?v= 与版本号徽章都改成 version；文件不在就当没事。"""
    if not path.is_file():
        return 0
    raw = path.read_text(encoding="utf-8")
    out, n = V_QUERY_RE.subn(rf'\g<1>?v={version}', raw)
    out, m = BRAND_VER_RE.subn(rf'\g<1>v{version}\g<3>', out)
    if out != raw:
        path.write_text(out, encoding="utf-8")
    return n + m


def _brand_version(raw: str) -> str | None:
    """读出徽章里写的版本号；找不到元素返回 None。"""
    m = BRAND_VER_RE.search(raw)
    return m.group(2) if m else None


def check() -> int:
    """返回不一致的项数。"""
    want = read_version()
    problems: list[str] = []

    raw = INDEX_HTML.read_text(encoding="utf-8")
    found = sorted(html_versions(raw))
    if found != [want]:
        problems.append(f"index.html 的 ?v= = {found or '（一个都没有）'}")
    if len(V_QUERY_FIND.findall(raw)) < 6:
        problems.append("index.html 里 ?v= 的数量少于 6 处（有资源漏了版本号）")
    badge = _brand_version(raw)
    if badge is None:
        problems.append("index.html 里找不到版本号徽章 #brandVer")
    elif badge != want:
        problems.append(f"index.html 的版本号徽章 = v{badge}")

    if SITE_INDEX.is_file():
        site_raw = SITE_INDEX.read_text(encoding="utf-8")
        site_found = sorted(html_versions(site_raw))
        if site_found != [want]:
            problems.append(
                f"site/index.html 的 ?v= = {site_found or '（一个都没有）'}"
                f"（构建产物过期了，跑 python3 tools/build_site.py 重新生成）"
            )
        site_badge = _brand_version(site_raw)
        if site_badge != want:
            problems.append(
                f"site/index.html 的版本号徽章 = v{site_badge or '（缺）'}"
                f"（构建产物过期了，跑 python3 tools/build_site.py 重新生成）"
            )

    for path, label in ((PACKAGE_JSON, "package.json"), (PACKAGE_LOCK, "package-lock.json")):
        versions = _pkg_versions(path)
        if any(v != want for v in versions) or not versions:
            problems.append(f"electron/{label} 的 version = {versions or '（缺）'}")

    for line in problems:
        print(f"  ✗ {line}（应为 {want}）", file=sys.stderr)
    if problems:
        print(f"\n共 {len(problems)} 处不一致。跑 python3 tools/set_version.py {want} 修一下。", file=sys.stderr)
    return len(problems)


def apply(version: str) -> None:
    VERSION_FILE.write_text(version + "\n", encoding="utf-8")
    n = _bump_index(version)
    changed = [f"index.html（{n} 处 ?v= / 版本号徽章）"]
    m = _bump_html(SITE_INDEX, version)
    if m:
        changed.append(f"site/index.html（{m} 处 ?v= / 版本号徽章）")
    for path, label in ((PACKAGE_JSON, "package.json"), (PACKAGE_LOCK, "package-lock.json")):
        if _bump_pkg(path, version):
            changed.append(f"electron/{label}")
    print(f"版本号 → {version}")
    for item in changed:
        print(f"  ✓ {item}")


def main() -> int:
    ap = argparse.ArgumentParser(description="同步版本号（唯一来源：仓库根的 VERSION）")
    ap.add_argument("version", nargs="?", help="新版本号，例如 0.6.2")
    ap.add_argument("--check", action="store_true", help="只校验，不改文件")
    args = ap.parse_args()

    if args.check:
        bad = check()
        if not bad:
            print(f"版本号一致：{read_version()}")
        return 1 if bad else 0
    if not args.version:
        ap.error("要么给一个新版本号，要么用 --check")
    if not SEMVER_RE.match(args.version):
        ap.error(f"版本号格式不对：{args.version}")
    apply(args.version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
