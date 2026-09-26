#!/bin/sh
# 打桌面版轻量包（Release 附件），并把产物收回 electron/dist。
#
#   tools/pack_desktop.sh                      # 轻量包（NO_SITE=1，每个约 100 MB）
#   WORK=/tmp/jubeat-dist tools/pack_desktop.sh
#
# 为什么要搬到 WORK（默认 /Users/Shared/jubeat-dist-build）里打：
#   1) 仓库在外置 exFAT 盘上时，electron-builder 读 asar 会因偏移溢出失败
#      （RangeError: The value of "offset" is out of range）；
#   2) ~/Documents 在 iCloud 管理下，依赖文件可能被「抽水」（dataless 标记），
#      读它们会一直阻塞 —— 表现是 electron-builder 静默卡死、0% CPU。
# 放到本地盘、用已实体化的依赖，就能同时绕开这两件事。
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/Users/Shared/jubeat-dist-build}"
MIRROR_ELECTRON="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
MIRROR_BINARIES="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

echo "仓库：$REPO"
echo "工作目录：$WORK"

mkdir -p "$WORK/electron" "$WORK/docs"
cp "$REPO/electron/main.js" "$REPO/electron/site-server.js" "$REPO/electron/package.json" \
   "$REPO/electron/package-lock.json" "$REPO/electron/electron-builder.config.js" "$WORK/electron/"
rm -rf "$WORK/electron/build"
cp -R "$REPO/electron/build" "$WORK/electron/"
cp "$REPO/docs/README-electron.txt" "$WORK/docs/"
cp "$REPO/LICENSE" "$REPO/THIRD-PARTY.md" "$WORK/"

if [ ! -d "$WORK/electron/node_modules/electron-builder" ]; then
  if [ -d "$REPO/electron/node_modules/electron-builder" ]; then
    echo "从仓库复制依赖到工作目录（排除 exFAT 的 ._ 边车文件）…"
    rsync -a --exclude '._*' "$REPO/electron/node_modules/" "$WORK/electron/node_modules/"
  else
    echo "工作目录里没有依赖，走国内镜像安装…"
    ( cd "$WORK/electron" && npm install --registry="$REGISTRY" --no-audit --no-fund )
  fi
fi

# 顺手体检：被 iCloud 抽水的依赖文件会读不动，早点报出来比静默卡死好
dataless=$(find "$WORK/electron/node_modules" -flags +dataless 2>/dev/null | wc -l | tr -d ' ')
if [ "$dataless" != "0" ]; then
  echo "⚠️  工作目录里有 $dataless 个文件被 iCloud 抽水，先跑：brctl download '$WORK/electron/node_modules'" >&2
fi

echo "开始打包…"
( cd "$WORK/electron" \
  && rm -rf dist \
  && ELECTRON_MIRROR="$MIRROR_ELECTRON" \
     ELECTRON_BUILDER_BINARIES_MIRROR="$MIRROR_BINARIES" \
     NO_SITE=1 NO_WINE=1 npm run dist )

mkdir -p "$REPO/electron/dist"
cp "$WORK"/electron/dist/*.zip "$WORK"/electron/dist/*.AppImage "$REPO/electron/dist/" 2>/dev/null || true
echo "产物已收回：$REPO/electron/dist"
ls -lh "$REPO/electron/dist"/*.zip "$REPO/electron/dist"/*.AppImage | awk '{print $5, $9}'
