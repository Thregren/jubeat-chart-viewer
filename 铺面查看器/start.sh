#!/bin/zsh
# 启动 jubeat 铺面确认
set -e
cd "$(dirname "$0")"
exec python3 player/server.py
