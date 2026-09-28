#!/usr/bin/env python3
"""发版助手：校验六份桌面包 → 生成 sha256 清单 → （可选）推 GitHub Release。

    python3 tools/release.py 0.6.2              # 校验 + 写清单 + 打印命令，不碰远端
    python3 tools/release.py 0.6.2 --run        # 校验完顺手发 Release（带重试）
    python3 tools/release.py --check 0.6.2      # 只校验，产物不齐就退出码 1（CI 用）

它守的是上次真正踩到的坑：

  * **附件必须是「不带曲库」的轻量包**（约 100 MB）。带曲库的包 2.9 GB，传上去
    下载端和 Release 页面都会很难受，而 GitHub 单文件上限 2 GB —— 所以这里对体积
    做硬校验，超过 MAX_LIGHT_MB 直接报错，免得手滑把 0.6.0 那批 2.7 GB 的包传上去。
  * **api.github.com 会间歇性 SSL 失败**，`gh release create` 带 6 个附件经常传到
    一半断掉：所以先建草稿、逐个附件上传并各自重试，最后再 `--draft=false --latest`。
  * **zip 结构不对** 在本地看不出来，到了 Windows 上才会「解压失败」：这里开一遍
    压缩包，确认 main.js / package.json 都在里面。

权威版本号只有一个：仓库根的 VERSION（见 铺面查看器/player/version.py）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO = TOOLS_DIR.parent
DIST = REPO / "electron" / "dist"
DOCS = REPO / "docs"

sys.path.insert(0, str(REPO / "铺面查看器" / "player"))
from version import read_version  # noqa: E402

PASS, FAIL, WARN = "\033[32m✓\033[0m", "\033[31m✗\033[0m", "\033[33m!\033[0m"

# 轻量包应该长这样：Windows/macOS 是 zip，Linux 是 AppImage
ARTIFACTS = [
    ("win-x64", "zip"),
    ("win-arm64", "zip"),
    ("mac-x64", "zip"),
    ("mac-arm64", "zip"),
    ("linux-x86_64", "AppImage"),
    ("linux-arm64", "AppImage"),
]
MAX_LIGHT_MB = 400          # 带曲库的包会到 2.7 GB，这里拦住


def artifact_path(tag_version: str, plat: str, ext: str, dist: Path) -> Path:
    return dist / f"jubeatViewer-{tag_version}-{plat}.{ext}"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _asar_files(blob: bytes | None) -> dict | None:
    """读 app.asar 的 JSON 头。

    Electron 的 asar 头是个 Pickle：`4` + 对齐后长度 + 头长度 + JSON 长度，
    JSON 从第 16 字节开始（实测 0.6.2 的包：4 / 824 / 820 / 814）。
    版本之间有细微差别，所以三个长度字段挨个试一遍，能解析出 files 就算数。
    """
    if blob is None or len(blob) < 16:
        return None
    import struct

    _marker, size_a, size_b, json_len = struct.unpack("<IIII", blob[:16])
    for length in (json_len, size_b, size_a):
        if not 0 < length <= min(len(blob) - 16, 32 * 1024 * 1024):
            continue
        try:
            header = json.loads(blob[16 : 16 + length].decode("utf-8"))
        except Exception:
            continue
        files = header.get("files")
        if isinstance(files, dict):
            return files
    return None


def inspect(path: Path) -> str:
    """看一遍包内部结构，返回 '' 表示没问题。

    负载在 app.asar 里（不是散文件），所以这里拆开 asar 看一眼：
    该有的入口在不在、以及**不该有的 site/ 有没有混进来**。
    """
    if path.suffix == ".AppImage":
        with open(path, "rb") as fh:
            if fh.read(4) != b"\x7fELF":
                return "AppImage 头不是 ELF"
        return ""

    import zipfile

    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            asar_name = next((n for n in names if n.endswith("app.asar")), None)
            if asar_name is None:
                return "压缩包里找不到 app.asar（应用负载）"
            blob = zf.read(asar_name)
    except Exception as exc:
        return f"打不开：{exc}"

    files = _asar_files(blob)
    if files is None:
        return "app.asar 头读不出来"
    for want in ("main.js", "site-server.js", "package.json"):
        if want not in files:
            return f"app.asar 里没有 {want}"
    if "site" in files:
        return "app.asar 里带了 site/（曲库）—— 这不是轻量包"
    return ""


def collect(version: str, dist: Path) -> tuple[list[tuple[Path, str, int]], list[str]]:
    """返回 ([(路径, sha256, 大小)], [问题…])。"""
    rows: list[tuple[Path, str, int]] = []
    problems: list[str] = []
    for plat, ext in ARTIFACTS:
        path = artifact_path(version, plat, ext, dist)
        if not path.is_file():
            problems.append(f"缺产物：{path.name}（先跑 sh tools/pack_desktop.sh）")
            continue
        size = path.stat().st_size
        mb = size / 1024 / 1024
        if mb < 1:
            problems.append(f"{path.name} 只有 {mb:.1f} MB，像是打包没完成")
            continue
        if mb > MAX_LIGHT_MB:
            problems.append(
                f"{path.name} 有 {mb:.0f} MB，超过 {MAX_LIGHT_MB} MB —— "
                f"这不像是「不带曲库」的轻量包（NO_SITE=1）"
            )
            continue
        bad = inspect(path)
        if bad:
            problems.append(f"{path.name}：{bad}")
            continue
        rows.append((path, sha256_of(path), size))
    return rows, problems


def write_manifest(version: str, rows: list[tuple[Path, str, int]]) -> Path:
    manifest = {
        "version": version,
        "note": "不带曲库的轻量包：首次启动时自己选 site 目录（含全部音乐的静态站点）",
        "assets": [
            {"name": p.name, "bytes": size, "sha256": digest}
            for p, digest, size in rows
        ],
    }
    out = DOCS / f"release-v{version}.manifest.json"
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sums = DOCS / f"release-v{version}.sha256"
    sums.write_text(
        "".join(f"{digest}  {p.name}\n" for p, digest, _ in rows), encoding="utf-8"
    )
    return out


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout.strip()


def gh(args: list[str], attempts: int = 5) -> tuple[int, str]:
    """跑 gh，SSL / 网络抖动就退避重试（api.github.com 在这台机器上很爱断）。"""
    delay = 4.0
    last = ""
    for i in range(1, attempts + 1):
        proc = subprocess.run(["gh", *args], cwd=REPO, capture_output=True, text=True)
        if proc.returncode == 0:
            return 0, proc.stdout
        last = (proc.stderr or proc.stdout).strip()
        if i < attempts:
            print(f"    {WARN} 第 {i} 次失败：{last.splitlines()[-1] if last else '（无输出）'}"
                  f" —— {delay:.0f}s 后重试")
            time.sleep(delay)
            delay = min(delay * 2, 60)
    return 1, last


def do_release(tag: str, rows: list[tuple[Path, str, int]], notes: Path, title: str) -> int:
    if shutil.which("gh") is None:
        print(f"{FAIL} 找不到 gh（GitHub CLI）", file=sys.stderr)
        return 1
    try:
        git("rev-parse", f"refs/tags/{tag}")
    except subprocess.CalledProcessError:
        print(f"{FAIL} 本地没有 tag {tag}：先 git tag -a {tag} 并 git push origin {tag}",
              file=sys.stderr)
        return 1

    code, out = gh(["release", "view", tag, "--json", "isDraft"])
    exists = code == 0
    if not exists:
        print(f"▸ 建草稿 {tag}")
        code, out = gh(["release", "create", tag, "--title", title,
                        "--notes-file", str(notes), "--draft"])
        if code != 0:
            print(f"{FAIL} 建 Release 失败：{out}", file=sys.stderr)
            return 1
    else:
        print(f"▸ Release {tag} 已存在，只补附件")

    uploaded, failed = 0, []
    for path, digest, size in rows:
        print(f"▸ 上传 {path.name}（{size / 1024 / 1024:.0f} MB）")
        code, out = gh(["release", "upload", tag, str(path), "--clobber"])
        if code == 0:
            uploaded += 1
        else:
            failed.append(path.name)
            print(f"    {FAIL} {path.name}：{out.splitlines()[-1] if out else '未知错误'}")

    if failed:
        print(f"\n{FAIL} 还有 {len(failed)} 个附件没传上去：{'、'.join(failed)}", file=sys.stderr)
        print("   传上去的那些已经在 Release 里了，重跑同一条命令会用 --clobber 覆盖重传。",
              file=sys.stderr)
        return 1

    print(f"▸ 取消草稿 + 标 latest（{uploaded} 个附件）")
    code, out = gh(["release", "edit", tag, "--draft=false", "--latest"])
    if code != 0:
        print(f"{FAIL} 发布失败：{out}", file=sys.stderr)
        return 1
    print(f"{PASS} 已发布：{tag}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="校验产物并生成 / 推送 GitHub Release")
    ap.add_argument("version", help="版本号，例如 0.6.2（不用写 v）")
    ap.add_argument("--dist", default=str(DIST), help="产物目录（默认 electron/dist）")
    ap.add_argument("--notes", help="Release 说明（默认 docs/release-v<版本>.md）")
    ap.add_argument("--title", help="Release 标题（默认 v<版本>）")
    ap.add_argument("--check", action="store_true", help="只校验，不写清单、不推远端")
    ap.add_argument("--run", action="store_true", help="校验通过后真的推 GitHub Release")
    args = ap.parse_args()

    version = args.version.lstrip("v")
    tag = f"v{version}"
    dist = Path(args.dist).expanduser().resolve()
    notes = Path(args.notes) if args.notes else DOCS / f"release-v{version}.md"
    title = args.title or tag

    want = read_version()
    bad = 0
    if want != version:
        print(f"{FAIL} VERSION 里是 {want}，和要发的 {version} 不一致"
              f"（先跑 python3 tools/set_version.py {version}）")
        bad += 1
    else:
        print(f"{PASS} 版本号：{version}")
    if not notes.is_file():
        print(f"{FAIL} 没有 Release 说明：{notes.relative_to(REPO)}")
        bad += 1
    else:
        print(f"{PASS} 说明：{notes.relative_to(REPO)}（{notes.stat().st_size} B）")

    print(f"\n▸ 检查产物（{dist}）")
    rows, problems = collect(version, dist)
    for path, _digest, size in rows:
        print(f"  {PASS} {path.name}（{size / 1024 / 1024:.1f} MB）")
    for item in problems:
        print(f"  {FAIL} {item}")
    bad += len(problems)

    if bad:
        print(f"\n{FAIL} {bad} 项没过，先修掉。", file=sys.stderr)
        return 1

    if args.check:
        print(f"\n{PASS} 产物齐全（--check 模式，没写清单）")
        return 0

    manifest = write_manifest(version, rows)
    print(f"\n{PASS} 清单：{manifest.relative_to(REPO)}")
    print(f"{PASS} 校验和：docs/release-v{version}.sha256")
    for path, digest, _size in rows:
        print(f"  {digest}  {path.name}")

    if not args.run:
        print(f"\n要发 Release 就跑：python3 tools/release.py {version} --run")
        print(f"（它会：先建草稿 → 逐个上传并重试 → 取消草稿并标 latest；"
              f"这之前记得 git push origin master 和 tag {tag}）")
        return 0
    return do_release(tag, rows, notes, title)


if __name__ == "__main__":
    sys.exit(main())
