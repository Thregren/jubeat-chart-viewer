"""Stage complete builds; atomically replace files and publish entry points last."""
from __future__ import annotations
try:
    import fcntl
except ImportError:
    fcntl = None
    import msvcrt
import os
import shutil
import tempfile
from pathlib import Path
from contextlib import contextmanager


@contextmanager
def read_site(target: Path):
    """Keep a published tree stable while a portable archive is being read."""
    target = target.resolve()
    with (target.parent / ("." + target.name + ".build.lock")).open("a+") as lock:
        try:
            if fcntl:
                fcntl.flock(lock.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            else:
                lock.write("0"); lock.flush(); lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise RuntimeError("站点正在构建，完成后再打包") from None
        yield

def _link_tree(source: Path, dest: Path) -> dict[str, tuple[int, int]]:
    """把已经发布的站点硬链接成 staging 副本，顺手记下每个文件的 (dev, ino)。

    以前是 `copytree(..., copy_function=os.link)` 之后再各 rglob 一遍新旧两棵树、
    逐文件 `os.path.samefile` —— 站点两万文件，等于每构建四万次 readdir 加四万次
    stat 的两倍。这里在链接的同时就把「发布态清单」记下来，后面 publish() 只需要
    走一遍 stage，拿同一个 (dev, ino) 比，就知道哪些文件真的变了。
    """
    inventory: dict[str, tuple[int, int]] = {}
    dest.mkdir(parents=True, exist_ok=True)
    for dirpath, dirnames, filenames in os.walk(source):
        rel_dir = os.path.relpath(dirpath, source)
        target_dir = dest if rel_dir == "." else dest / rel_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        for name in filenames:
            src = Path(dirpath) / name
            rel = name if rel_dir == "." else f"{Path(rel_dir).as_posix()}/{name}"
            try:
                os.link(src, target_dir / name)
                st = os.stat(src, follow_symlinks=False)
            except OSError:
                # 跨设备 / 不支持硬链接（Windows 非 NTFS）：退回复制，仍然记清单
                shutil.copyfile(src, target_dir / name)
                st = os.stat(target_dir / name, follow_symlinks=False)
            inventory[rel] = (st.st_dev, st.st_ino)
    return inventory


class SiteTransaction:
    def __init__(self, target: Path):
        self.target = target
    def __enter__(self):
        self.target.parent.mkdir(parents=True, exist_ok=True)
        self.lock = (self.target.parent / ("." + self.target.name + ".build.lock")).open("a")
        try:
            if fcntl:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                self.lock.write("0"); self.lock.flush(); self.lock.seek(0)
                msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            self.lock.close()
            raise RuntimeError("同一输出目录已有构建在运行") from None
        self.workspace = Path(tempfile.mkdtemp(prefix="." + self.target.name + ".build-", dir=self.target.parent))
        self.stage = self.workspace / "stage"
        try:
            if self.target.exists():
                self.inventory = _link_tree(self.target, self.stage)
            else:
                self.stage.mkdir()
                self.inventory = {}
            return self
        except BaseException:
            shutil.rmtree(self.workspace, ignore_errors=True)
            self.lock.close()
            raise
    def publish(self):
        from finalize_frontend import finalize
        finalize(self.stage, self.target)
        new = {p.relative_to(self.stage).as_posix(): p for p in self.stage.rglob("*") if p.is_file()}
        changed = []
        for rel, path in new.items():
            try:
                st = os.stat(path, follow_symlinks=False)
            except OSError:
                changed.append(rel)
                continue
            if self.inventory.get(rel) != (st.st_dev, st.st_ino):
                changed.append(rel)
        changed.sort(key=lambda rel: ({"data/build.json": 1, "data/library.json": 2, "index.html": 3}.get(rel, 0), rel))
        deleted = sorted(self.inventory.keys() - new.keys())
        backup = self.workspace / "backup"
        for rel in changed + deleted:
            if rel in self.inventory:
                p = backup / rel; p.parent.mkdir(parents=True, exist_ok=True); os.link(self.target / rel, p)
        applied = []
        try:
            self.target.mkdir(parents=True, exist_ok=True)
            for rel in changed:
                dest = self.target / rel; dest.parent.mkdir(parents=True, exist_ok=True)
                os.replace(new[rel], dest); applied.append(rel)
            for rel in deleted:
                (self.target / rel).unlink(missing_ok=True); applied.append(rel)
        except BaseException:
            for rel in reversed(applied):
                dest = self.target / rel
                if rel in self.inventory: os.replace(backup / rel, dest)
                else: dest.unlink(missing_ok=True)
            raise
    def __exit__(self, *exc):
        try:
            shutil.rmtree(self.workspace)
        finally:
            self.lock.close()
