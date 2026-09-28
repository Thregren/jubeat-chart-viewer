#!/usr/bin/env python3
"""Range 解析 + 路径穿越防护的三实现一致性测试。

同一个站点有三套后端都会「发文件」：

  * Python 开发服务器  铺面查看器/player/media.py :: parse_range / safe_join
  * Electron 静态服务   electron/site-server.js  :: parseRange / resolveSafe
  * PHP 单文件入口      deploy/php/index.php     :: jubeat_parse_range

三边的语义必须一模一样：同一个音频、同一发 `Range:` 请求头，在本地开发、
桌面版、线上（宝塔 / nginx + PHP）三种部署下必须给出同一个 206 区间。以前不是：
`bytes=500`（没有短横线）只有 Node 那份放行，`bytes=10-x` 在 Node 上被当成
「到文件尾」。这类差异不会报错，只会让某一端的进度条行为跟别处不一样，所以
这里用同一张用例表把三份实现钉在一起。

第四处 `tools/serve.py`（本机预览 ./site 用）不再自带实现，改成直接
`from media import parse_range` —— 它以前抄了一份自己的，结果 `bytes=0 - 99`
被它放行、前导空格反过来只有它拒绝，而这张用例表又没把它算进来，谁都没发现。

PHP 没装就跳过 PHP 那一段（只在本机跑得动的部分做断言），不会当成失败。

    python3 tools/test_range.py
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLAYER_DIR = REPO / "铺面查看器" / "player"
NODE_SERVER = REPO / "electron" / "site-server.js"
PHP_ENTRY = REPO / "deploy" / "php" / "index.php"

PASS, FAIL = "\033[32m✓\033[0m", "\033[31m✗\033[0m"
failures: list[str] = []


def check(name: str, got, want) -> None:
    if got == want:
        print(f"  {PASS} {name}")
    else:
        print(f"  {FAIL} {name}\n      期望 {want!r}\n      实际 {got!r}")
        failures.append(name)


# (size, header, 期望)  —— 期望 None 表示「忽略 Range，整文件 200」
RANGE_CASES: list[tuple[int, str, tuple[int, int] | None]] = [
    # 正常区间
    (1000, "bytes=0-99", (0, 99)),
    (1000, "bytes=0-0", (0, 0)),
    (1000, "bytes=0-", (0, 999)),
    (1000, "bytes=500-", (500, 999)),
    (1000, "bytes=999-999", (999, 999)),
    (1000, "bytes=900-2000", (900, 999)),          # 尾端越界 → 夹到文件尾
    (1000, "bytes=0000-0005", (0, 5)),             # 前导零
    (1000, "bytes=0-99 ", (0, 99)),                # 值尾随空白
    (1000, " bytes=0-99 ", (0, 99)),               # 整值首尾空白（RFC 允许的 OWS）
    # 后缀语法：bytes=-N 取最后 N 字节
    (1000, "bytes=-100", (900, 999)),
    (1000, "bytes=-99999", (0, 999)),              # N 比文件还大 → 整个文件
    # 大小边界
    (1, "bytes=0-0", (0, 0)),
    (1, "bytes=0-99", (0, 0)),
    (1, "bytes=-1", (0, 0)),
    (0, "bytes=0-", None),                         # 空文件不谈 Range
    (0, "bytes=0-0", None),
    # 非法：一律回 None
    (1000, "", None),
    (1000, "-100", None),
    (1000, "-0", None),
    (1000, "bytes=-0", None),
    (1000, "bytes=-", None),
    (1000, "bytes", None),
    (1000, "bytes=", None),
    (1000, "bytes=500", None),                     # 没有短横线（Node 曾经的漏洞）
    (1000, "bytes=1000-1001", None),               # 起点越界
    (1000, "bytes=2000-", None),
    (1000, "bytes=50-40", None),                   # end < start
    (1000, "bytes=0-99,200-299", None),            # 多段不支持
    (1000, "items=0-99", None),
    (1000, "abc-def", None),
    (1000, "x-10", None),
    (1000, "10-x", None),                          # 结束位置不是数字
    (1000, "1-2-3", None),
    (1000, "bytes=0 - 99", None),
    (1000, "bytes=0-99,", None),
]


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def load_python_impl():
    return load_module(PLAYER_DIR / "media.py", "jubeat_media")


NODE_DRIVER = r"""
const path = require("node:path");
const srv = require(process.argv[1]);
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const req = JSON.parse(raw);
  const range = req.range.map((c) => {
    const r = srv.parseRange(c[1], c[0]);
    return r === null ? null : [r[0], r[1]];
  });
  const safe = req.safe.map((p) => {
    const r = srv.resolveSafe(req.root, p);
    if (r === null) return null;
    const rel = path.relative(req.root, r).split(path.sep).join("/");
    return rel === "" ? "." : rel;
  });
  process.stdout.write(JSON.stringify({ range, safe }));
});
"""

PHP_DRIVER = r"""
define('JUBEAT_PHP_NO_RUN', true);
require getenv('JV_PHP_ENTRY');
$cases = json_decode(stream_get_contents(STDIN), true);
$out = [];
foreach ($cases as $c) {
    $r = jubeat_parse_range($c[1], $c[0]);
    $out[] = $r === null ? null : [(int) $r[0], (int) $r[1]];
}
echo json_encode($out);
"""

# Node resolveSafe：路径 → 期望的「相对站点根」结果（null = 越界，拒绝）
SAFE_ROOT = "/tmp/jv-range-root/site"
SAFE_CASES: list[tuple[str, str | None]] = [
    ("/index.html", "index.html"),
    ("/static/app.js", "static/app.js"),
    ("/data/charts/a/b.json", "data/charts/a/b.json"),
    ("/media/jubeat-saucer/Windy Fairy.ogg", "media/jubeat-saucer/Windy Fairy.ogg"),
    ("/./static/./app.js", "static/app.js"),
    ("/static/../index.html", "index.html"),
    ("/", "."),
    ("/../site-evil/x", None),          # 前缀比较漏洞的回归用例
    ("/../etc/passwd", None),
    ("/a/../../etc/passwd", None),
    ("/static/../../site-evil/x", None),
]


def run_node(payload: dict) -> dict:
    proc = subprocess.run(
        ["node", "-e", NODE_DRIVER, str(NODE_SERVER)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node 失败：{proc.stderr.strip()}")
    return json.loads(proc.stdout)


def main() -> int:
    print("Range 三实现一致性")
    node_out = run_node({
        "range": [[size, header] for size, header, _ in RANGE_CASES],
        "safe": [],
        "root": SAFE_ROOT,
    })
    node_range = [None if r is None else (r[0], r[1]) for r in node_out["range"]]

    php_ok = shutil.which("php") is not None
    php_range: list[tuple[int, int] | None] | None = None
    if php_ok:
        env = {"JV_PHP_ENTRY": str(PHP_ENTRY)}
        proc = subprocess.run(
            ["php", "-r", PHP_DRIVER],
            input=json.dumps([[size, header] for size, header, _ in RANGE_CASES]),
            capture_output=True,
            text=True,
            env={**__import__("os").environ, **env},
        )
        if proc.returncode != 0:
            print(f"  {FAIL} 跑 PHP 失败：{proc.stderr.strip()}")
            failures.append("php driver")
        else:
            raw = json.loads(proc.stdout)
            php_range = [None if r is None else (r[0], r[1]) for r in raw]

    media = load_python_impl()
    # 第四处 tools/serve.py（本机预览 ./site）也要过同一张表：它以前自带一份实现，
    # `bytes=0 - 99` 被它放行、前导空格反过来只有它拒绝。现在它 from media import
    # parse_range，这里再钉一遍行为 —— 谁将来又抄一份走样了，这条会红。
    serve = load_module(REPO / "tools" / "serve.py", "jubeat_serve")

    counts = {"python": 0, "node": 0, "php": 0, "serve": 0}
    for i, (size, header, want) in enumerate(RANGE_CASES):
        label = f"size={size} Range={header!r} → {want}"
        check(f"py   {label}", media.parse_range(header, size), want)
        counts["python"] += 1
        check(f"node {label}", node_range[i], want)
        counts["node"] += 1
        check(f"serve {label}", serve.parse_range(header, size), want)
        counts["serve"] += 1
        if php_range is not None:
            check(f"php  {label}", php_range[i], want)
            counts["php"] += 1

    if not php_ok:
        print("  \033[33m·\033[0m 本机没有 php，跳过 PHP 实现（线上部署前请在服务器上跑一次）")

    print("\nElectron resolveSafe 路径穿越")
    safe_out = run_node({
        "range": [],
        "safe": [p for p, _ in SAFE_CASES],
        "root": SAFE_ROOT,
    })["safe"]
    for i, (p, want) in enumerate(SAFE_CASES):
        check(f"node {p} → {want}", safe_out[i], want)
    py_root = Path(SAFE_ROOT).resolve()   # macOS 上 /tmp 是软链，safe_join 返回的是展开后的路径
    for i, (p, want) in enumerate(SAFE_CASES):
        try:
            got = media.safe_join(py_root, p)
            rel = got.relative_to(py_root).as_posix() or "."
        except ValueError:
            rel = None
        want_py = None if want is None else want
        # Python 的 safe_join 里 "/" 会被 normpath 成 "."，和 Node 的 rel=="" 对齐
        check(f"py   {p} → {want_py}", rel, want_py)

    total = sum(counts.values()) + len(SAFE_CASES) * 2
    print()
    if failures:
        print(f"{FAIL} 失败 {len(failures)} / {total}")
        for name in failures:
            print(f"    - {name}")
        return 1
    impl_note = f"Python+Node+PHP 三份" if php_ok else "Python+Node 两份"
    print(f"{PASS} 全部通过（{total} 项，Range 用例 {len(RANGE_CASES)} × {impl_note}，路径穿越 {len(SAFE_CASES)} × 2）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
