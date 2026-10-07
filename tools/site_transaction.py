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
        if self.target.exists():
            shutil.copytree(self.target, self.stage, copy_function=os.link)
        else:
            self.stage.mkdir()
        return self
    def publish(self):
        old = {p.relative_to(self.target).as_posix(): p for p in self.target.rglob("*") if p.is_file()} if self.target.exists() else {}
        new = {p.relative_to(self.stage).as_posix(): p for p in self.stage.rglob("*") if p.is_file()}
        changed = [rel for rel, p in new.items() if rel not in old or not os.path.samefile(p, old[rel])]
        changed.sort(key=lambda rel: ({"data/build.json": 1, "data/library.json": 2, "index.html": 3}.get(rel, 0), rel))
        deleted = sorted(old.keys() - new.keys())
        backup = self.workspace / "backup"
        for rel in changed + deleted:
            if rel in old:
                p = backup / rel; p.parent.mkdir(parents=True, exist_ok=True); os.link(old[rel], p)
        applied = []
        try:
            self.target.mkdir(parents=True, exist_ok=True)
            for rel in changed:
                dest = self.target / rel; dest.parent.mkdir(parents=True, exist_ok=True)
                os.replace(new[rel], dest); applied.append(rel)
            for rel in deleted:
                old[rel].unlink(); applied.append(rel)
        except BaseException:
            for rel in reversed(applied):
                dest = self.target / rel
                if rel in old: os.replace(backup / rel, dest)
                else: dest.unlink(missing_ok=True)
            raise
    def __exit__(self, *exc):
        shutil.rmtree(self.workspace)
        self.lock.close()
