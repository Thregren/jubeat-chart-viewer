#!/bin/zsh
# 启动 jubeat 谱面确认
set -e
cd "$(dirname "$0")"
exec python3 player/server.py
