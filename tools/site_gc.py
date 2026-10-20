#!/usr/bin/env python3
"""Collect obsolete immutable site assets; default is a read-only plan.

Keep the current catalog, at least three generations, and every generation from
seven days ago or later. Legacy files get an adoption grace period on first use.
Run against a stopped local builder or a deployment staging copy, never live files.
"""
import argparse
import json
import re
import time
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "铺面查看器/player"))
from media import write_atomic

HISTORY = '.asset-history.json'

def hashed(rel):
    return '_hashed' in Path(rel).parts or bool(re.search(r'\.[a-f0-9]{20}\.', rel))

def read_history(root):
    try:
        data = json.loads((root / HISTORY).read_text())
        if data.get('schema') != 1: raise ValueError('unsupported history schema')
        return data['snapshots']
    except FileNotFoundError:
        return []

def record_snapshot(root, paths, now=None):
    now = time.time() if now is None else now
    snapshots = read_history(root)
    if not snapshots:
        snapshots.append({'at': now, 'paths': sorted(p.relative_to(root).as_posix()
            for p in root.rglob('*') if p.is_file() and hashed(p.relative_to(root).as_posix()))})
    html = (root / 'index.html').read_text()
    paths = set(paths) | set(re.findall(r'(?:src|href)="(static/[^"?]+)', html))
    paths = sorted(p for p in paths if hashed(p))
    if snapshots[-1]['paths'] != paths:
        snapshots.append({'at': now, 'paths': paths})
    # Keep recent generations as well as the last three, even across rapid rebuilds.
    snapshots = [s for i, s in enumerate(snapshots)
                 if i >= len(snapshots) - 3 or s['at'] >= now - 7*86400]
    write_atomic(root / HISTORY, json.dumps({'schema': 1, 'snapshots': snapshots}).encode())

def candidates(root, now=None):
    now = time.time() if now is None else now
    snapshots = read_history(root)
    if not snapshots: raise ValueError('build with asset history before garbage collection')
    keep = set()
    for i, snapshot in enumerate(snapshots):
        if i >= len(snapshots)-3 or snapshot['at'] >= now-7*86400:
            keep.update(snapshot['paths'])
    # Independently protect the current index even if a deployment left stale history.
    index = json.loads((root / 'data/library.json').read_text())
    for relative in index.get('versionIndexes',[]):
        keep.add(relative)
        part=root/relative
        if part.is_file():
            for song in json.loads(part.read_text())['songs']:keep.update(song.get('assets',{}).values())
    for song in index['songs']: keep.update(song.get('assets', {}).values())
    marker_path=root/'data/markers.json'
    if marker_path.is_file():
        for design in json.loads(marker_path.read_text()).get('designs',[]):
            keep.update('markers/'+a['file'] for a in design.get('atlases',{}).values())
    keep.update(re.findall(r'(?:src|href)="(static/[^"?]+)', (root / 'index.html').read_text()))
    return sorted(p for p in root.rglob('*') if p.is_file() and not p.is_symlink()
                  and hashed(p.relative_to(root).as_posix())
                  and p.relative_to(root).as_posix() not in keep
                  and p.stat().st_mtime < now - 7*86400)

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', type=Path, default=Path(__file__).resolve().parent.parent/'site')
    ap.add_argument('--apply', action='store_true', help='publish a cleaned staging copy atomically')
    args = ap.parse_args()
    from site_transaction import SiteTransaction
    # Both planning and deletion use the same builder lock to avoid racing a publish.
    with SiteTransaction(args.out.resolve()) as tx:
        paths = candidates(tx.stage)
        report = {'apply': args.apply, 'files': len(paths), 'logicalBytes': sum(p.stat().st_size for p in paths),
                  'paths': [p.relative_to(tx.stage).as_posix() for p in paths]}
        if args.apply:
            for p in paths: p.unlink()
            tx.publish()
    print(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == '__main__': main()
