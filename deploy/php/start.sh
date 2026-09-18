#!/bin/sh
# 最省事的起法：不配 nginx，直接用 PHP 自带的服务器把整包跑起来。
#
#   ./start.sh            # 监听 0.0.0.0:8080
#   PORT=9000 ./start.sh  # 换端口
#
# 生产环境建议还是用 nginx（见 nginx-php.conf.example），静态文件由 nginx 直发更快。
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8080}"

if ! command -v php >/dev/null 2>&1; then
  echo "没找到 php，请先装 PHP（宝塔：软件商店 → PHP）" >&2
  exit 1
fi

echo "jubeat 铺面查看器 → http://<服务器IP>:$PORT/    （Ctrl+C 停止）"
# -t . 指定站点根目录；index.php 负责静态直发 + Range + gzip
exec php -S "0.0.0.0:$PORT" -t . index.php
