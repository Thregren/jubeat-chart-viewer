#!/bin/zsh
# 启动 jubeat 铺面查看器
set -e
cd "$(dirname "$0")/铺面查看器"
exec python3 player/server.py
