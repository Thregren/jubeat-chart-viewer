"""Publish related package files through one atomic generation pointer."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import tempfile
from asset_hash import sha256_file

try:
    import fcntl
except ImportError:
    fcntl = None
    import msvcrt


@contextmanager
def publication_lock(parent: Path, name: str):
    parent.mkdir(parents=True, exist_ok=True)
    with (parent / ('.' + name + '.package.lock')).open('a+') as lock:
        try:
            if fcntl:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                lock.seek(0, 2)
                if lock.tell() == 0:
                    lock.write('0')
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise RuntimeError('同一输出已有打包任务在运行') from None
        yield


def plain_name(name: str) -> str:
    if not isinstance(name, str) or name in ('', '.', '..') or '/' in name or '\\' in name:
        raise ValueError('无效的包文件名')
    return name


def atomic_link(target: str, link: Path, directory=False):
    # Create first so unsupported symlinks do not replace the existing output.
    temp_dir = Path(tempfile.mkdtemp(prefix='.package-link-', dir=link.parent))
    temp = temp_dir / 'link'
    try:
        temp.symlink_to(target, target_is_directory=directory)
        os.replace(temp, link)
    finally:
        shutil.rmtree(temp_dir)


def snapshot_file(source: Path, dest: Path):
    try:
        os.link(source, dest)
    except OSError:
        shutil.copy2(source, dest)


class PackagePublication:
    def __init__(self, parent: Path, key: str):
        self.parent = parent
        self.key = plain_name(key)
        self.current = parent / ('.' + key + '.current')
        self.releases = parent / ('.' + key + '.releases')
        self.releases.mkdir(parents=True, exist_ok=True)
        # Check capability before migrating or replacing any published file.
        probe_dir = Path(tempfile.mkdtemp(prefix='.probe-', dir=self.releases))
        try:
            (probe_dir / 'link').symlink_to('.', target_is_directory=True)
        except OSError as error:
            raise RuntimeError('此文件系统不支持创建发布所需的符号链接') from error
        finally:
            shutil.rmtree(probe_dir)

    def new_generation(self):
        return Path(tempfile.mkdtemp(prefix='generation-', dir=self.releases))

    def initialize_legacy(self, names):
        if self.current.is_symlink():
            if not self.current.resolve().is_dir():
                raise RuntimeError('发布入口指向无效目录')
            return
        if self.current.exists():
            raise RuntimeError('发布入口已被其他文件占用')
        names = [plain_name(name) for name in names]
        if not names:
            return
        legacy = self.new_generation()
        try:
            for name in names:
                source = self.parent / name
                if source.is_symlink() or not source.is_file():
                    raise RuntimeError('旧包文件缺失或已被替换：' + name)
                snapshot_file(source, legacy / name)
            atomic_link(os.path.relpath(legacy, self.parent), self.current, directory=True)
        except BaseException:
            if not self.current.is_symlink():
                shutil.rmtree(legacy)
            raise

    def publish(self, generation: Path, names: list[str], legacy_names: list[str]):
        names = list(dict.fromkeys(plain_name(name) for name in names))
        legacy_names = list(dict.fromkeys(plain_name(name) for name in legacy_names))
        self.initialize_legacy(legacy_names)
        for name in names:
            if not (generation / name).is_file():
                raise ValueError('新包缺少文件：' + name)
            dest = self.parent / name
            expected = self.current.name + '/' + name
            if dest.is_symlink():
                if os.readlink(dest) != expected:
                    raise RuntimeError('输出路径已被其他链接占用：' + name)
            elif dest.exists() and name not in legacy_names:
                raise RuntimeError('输出路径已被其他文件占用：' + name)
            elif dest.exists() or not dest.is_symlink():
                atomic_link(expected, dest)
        atomic_link(os.path.relpath(generation, self.parent), self.current, directory=True)


def legacy_web_names(output: Path):
    manifest = output / 'packages.json'
    sums = output / 'SHA256SUMS'
    if not manifest.exists() and not sums.exists():
        return []
    if not manifest.is_file() or not sums.is_file():
        raise RuntimeError('旧包清单不完整，请先修复')
    data = json.loads(manifest.read_text(encoding='utf-8'))
    names = [plain_name(row['name']) for row in data['assets']]
    expected = ''.join(row['sha256'] + '  ' + row['name'] + '\n' for row in data['assets'])
    if sums.read_text(encoding='utf-8') != expected:
        raise RuntimeError('旧包 SHA256SUMS 与清单不一致')
    for row in data['assets']:
        file = output / row['name']
        if not file.is_file() or file.stat().st_size != row['bytes'] or sha256_file(file) != row['sha256']:
            raise RuntimeError('旧包校验不符：' + row['name'])
    return ['packages.json', 'SHA256SUMS', *names]
