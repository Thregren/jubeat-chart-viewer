#!/usr/bin/env python3
"""构建开放目录曲库站点。

入口名保留 `build_site.py`（文档、脚本、测试都用这个名字调用），实际实现是
`build_directory.py`：读 `data/library.json` + 显式资源路径，原样复制音源，
不打开任何压缩包、不转码。旧版 `.mcz` 通道（`--legacy-mcz`）已下线。
"""
from build_directory import main

if __name__ == '__main__':
    raise SystemExit(main())
