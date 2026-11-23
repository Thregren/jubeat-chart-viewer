#!/usr/bin/env python3
"""Apply literal HTML substitutions to the homepage and the published share pages."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


def listed_pages(root):
    manifest = json.loads((root / 'share/manifest.json').read_text())
    pages = [item['page'] for item in manifest['pages']]
    if manifest['songs'] != len(pages) or len(set(pages)) != len(pages):
        raise ValueError('分享页清单数量不符')
    for name in pages:
        path = Path(name)
        if path.parent != Path('share') or path.suffix != '.html' or path.as_posix() != name:
            raise ValueError(f'无效分享页路径 {name}')
    actual = {path.relative_to(root).as_posix() for path in (root / 'share').glob('*.html')}
    if set(pages) != actual:
        raise ValueError('分享页清单与已发布的文件不一致')
    return [*sorted(pages), 'index.html']


def patch_pages(root, backup, replacements, expected_home, lock_path):
    root = root.resolve(strict=True)
    backup = backup.resolve()
    if not replacements or any(not old or old == new for old, new in replacements.items()):
        raise ValueError('需要提供有效的替换表')
    if backup == root or backup.is_relative_to(root):
        raise ValueError('备份目录必须在站点之外')

    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        pages = listed_pages(root)
        if hashlib.sha256((root / 'index.html').read_bytes()).hexdigest() != expected_home:
            raise ValueError('首页摘要与预期不符')
        with tempfile.TemporaryDirectory(prefix='.share-patch-', dir=root.parent) as temp:
            stage = Path(temp)
            (stage / 'share').mkdir()
            original = {}
            for name in pages:
                live = root / name
                if live.resolve(strict=True) != live or not live.is_file():
                    raise ValueError(f'无效页面 {name}')
                stat = live.stat()
                original[name] = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
                html = live.read_text(encoding='utf-8')
                for old, new in replacements.items():
                    if html.count(old) != 1:
                        raise ValueError(f'{name} 中的替换项出现次数异常')
                    html = html.replace(old, new, 1)
                staged = stage / name
                staged.write_text(html, encoding='utf-8')
                if os.geteuid() == 0:
                    os.chown(staged, stat.st_uid, stat.st_gid)
                shutil.copymode(live, staged)

            backup.mkdir(mode=0o700)
            (backup / 'share').mkdir()
            for name in pages:
                live = root / name
                stat = live.stat()
                if (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns) != original[name]:
                    raise RuntimeError(f'发布期间页面已变更 {name}')
                os.link(live, backup / name)

            applied = []
            try:
                for name in pages:
                    os.replace(stage / name, root / name)
                    applied.append(name)
            except BaseException:
                for name in reversed(applied):
                    os.link(backup / name, stage / name)
                    os.replace(stage / name, root / name)
                raise
        return len(pages)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('root', 'backup', 'replacements', 'lock'):
        parser.add_argument('--' + key, required=True, type=Path)
    parser.add_argument('--expected-home', required=True)
    args = parser.parse_args()
    print(patch_pages(args.root, args.backup, json.loads(args.replacements.read_text()),
                      args.expected_home, args.lock))
