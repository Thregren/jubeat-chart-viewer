#!/usr/bin/env python3
"""默认构建开放目录曲库；旧MCZ导入仅允许显式 --legacy-mcz。"""
import sys
import os
if __name__ == '__main__':
    if '--legacy-mcz' in sys.argv:
        sys.argv.remove('--legacy-mcz')
        if not os.environ.get('JUBEAT_LIBRARY', '').strip():
            raise SystemExit('旧导入必须显式指定 JUBEAT_LIBRARY；默认不读取任何旧曲库')
        from site_builder import main
    else:
        from build_directory import main
    raise SystemExit(main())
