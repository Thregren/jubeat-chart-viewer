#!/bin/sh
# 一条命令跑完全部自测。改完代码跑 `tools/check.sh`，发版前跑 `tools/check.sh --release`。
#
#   tools/check.sh              快：JS 语法 / core 单测 / Range 三实现一致性 / 版本号
#   tools/check.sh --site       再加上已有 ./site 的完整性检查（构建完、部署后）
#   tools/check.sh --full       再加上「临时建一个小站点 + 两种部署模式的接口冒烟」
#   tools/check.sh --release    = --full + PHP 入口冒烟（装了 php 才跑）
#
# 这里不含 Electron 打包（那要 GUI / 几分钟），打包单独跑 tools/pack_desktop.sh。
set -u

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO" || exit 1
PY=${PYTHON:-python3}

WANT_SITE=0
WANT_FULL=0
WANT_PHP=0
for arg in "$@"; do
  case "$arg" in
    --site) WANT_SITE=1 ;;
    --full) WANT_SITE=1; WANT_FULL=1 ;;
    --release) WANT_SITE=1; WANT_FULL=1; WANT_PHP=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

FAILED=""

run() {                       # run <说明> <命令…>
  desc=$1
  shift
  printf '\n\033[1m▸ %s\033[0m\n' "$desc"
  if "$@"; then
    return 0
  fi
  FAILED="$FAILED
  ✗ $desc"
}

skip() { printf '\n\033[2m▸ %s —— 跳过（%s）\033[0m\n' "$1" "$2"; }

# ── 1. 前端语法 ───────────────────────────────────────────────
check_js() {
  for f in 铺面查看器/player/static/*.js electron/*.js; do
    node --check "$f" || return 1
  done
  echo "语法 OK：$(ls 铺面查看器/player/static/*.js electron/*.js | wc -l | tr -d ' ') 个文件"
}
run "前端 JS 语法（node --check）" check_js

# ── 2. 前端纯逻辑单测 ─────────────────────────────────────────
run "core.js 单测（node --test）" node --test tools/test_core.mjs tools/test_runtime.mjs

run "构建失败与发布回滚" "$PY" tools/test_build.py

# ── 3. Range / 路径穿越三实现一致性 ──────────────────────────
run "Range + 路径穿越（python3 tools/test_range.py）" "$PY" tools/test_range.py

# ── 4. Python 语法 ───────────────────────────────────────────
# 字节码写到临时目录，别把 __pycache__ 弄进仓库
check_py() {
  cache=$(mktemp -d)
  PYTHONPYCACHEPREFIX="$cache" "$PY" -m py_compile \
    铺面查看器/player/*.py tools/*.py || return 1
  rm -rf "$cache"
  echo "语法 OK：$(ls 铺面查看器/player/*.py tools/*.py | wc -l | tr -d ' ') 个文件"
}
run "Python 语法（py_compile）" check_py

# ── 5. 版本号一致性 ──────────────────────────────────────────
run "版本号（VERSION → index.html ?v= / electron 包）" "$PY" tools/set_version.py --check

# ── 6. 可选：已有站点 / 端到端 / PHP ─────────────────────────
if [ "$WANT_SITE" = 1 ]; then
  if [ -f site/index.html ]; then
    run "站点完整性（tools/verify_site.py）" "$PY" tools/verify_site.py --quiet
  else
    skip "站点完整性" "没有 ./site，先跑 tools/build_site.py"
  fi
fi

if [ "$WANT_FULL" = 1 ]; then
  run "端到端冒烟（tools/smoke_test.py --build）" "$PY" tools/smoke_test.py --build
fi

if [ "$WANT_PHP" = 1 ]; then
  if command -v php >/dev/null 2>&1; then
    run "PHP 入口冒烟（tools/php_smoke_test.py）" "$PY" tools/php_smoke_test.py
  else
    skip "PHP 入口冒烟" "本机没装 php"
  fi
fi

echo
if [ -n "$FAILED" ]; then
  printf '\033[31m检查未通过：%s\033[0m\n' "$FAILED"
  exit 1
fi
printf '\033[32m✓ 全部检查通过\033[0m\n'
