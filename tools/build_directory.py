#!/usr/bin/env python3
"""构建开放目录曲库站点；原样保留WAV/试听/缺失标记，不读取旧曲库或转码。"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / '铺面查看器/player'))
from directory_library import load_directory, asset_path
from media import write_atomic
import markers
import config


def copy_or_link(source, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if os.path.samefile(source, dest):
            return
        if source.read_bytes() == dest.read_bytes():
            return
        # 仅替换构建产物路径，不改动源库或其他硬链接。
        dest.unlink()
    try:
        os.link(source, dest)
    except OSError:
        shutil.copyfile(source, dest)


def build_directory(source: Path, out: Path, include_markers=True):
    source, out = source.resolve(), out.resolve()
    data, assets = load_directory(source)
    # 先检查再写前端，部分安装的版本只检查已安装索引中的资源。
    for name in sorted(assets):
        if not asset_path(source, name).is_file():
            raise ValueError('已声明资源不存在: ' + name)
    if source != out:
        for top in ('data', 'songs'):
            for p in (source / top).rglob('*'):
                if p.is_file():
                    copy_or_link(p, out / p.relative_to(source))
    out.mkdir(parents=True, exist_ok=True)
    static = REPO / '铺面查看器/player/static'
    for p in static.iterdir():
        if p.is_file() and not p.name.startswith('.'):
            # 前端始终复制，避免未来编辑源码影响已发布站点。
            dest = out / ('index.html' if p.name == 'index.html' else 'static/' + p.name)
            write_atomic(dest, p.read_bytes())
    if include_markers:
        manifest = markers.manifest()
        if manifest.get('error'):
            raise ValueError(manifest['error'])
        for design in manifest['designs']:
            for name in markers.design_assets(design):
                copy_or_link(asset_path(config.MARKERS_ROOT, name), out / 'markers' / name)
        write_atomic(out / 'data/markers.json', json.dumps(manifest, ensure_ascii=False).encode())
    else:
        write_atomic(out / 'data/markers.json', b'{"designs":[],"error":null}')
    from build_share_pages import build_share_pages
    build_share_pages(out, out, version=(REPO/'VERSION').read_text().strip(), songs=data['songs'])
    stats = dict(format='jubeat-directory-v1', status='complete', songs=len(data['songs']),
                 charts=sum(len(s['charts']) for s in data['songs']),
                 resourceOnly=sum(bool(s.get('resourceOnly')) for s in data['songs']),
                 assets=len(assets), source='explicit-directory-index', mczOpened=0,
                 legacyMetadataRead=False)
    write_atomic(out / 'data/build.json', json.dumps(stats, ensure_ascii=False, indent=2).encode())
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)
    return stats


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--library', type=Path, required=True)
    p.add_argument('--out', type=Path)
    p.add_argument('--no-markers', action='store_true')
    args = p.parse_args(argv)
    try:
        build_directory(args.library, args.out or args.library, not args.no_markers)
    except (OSError, ValueError, KeyError) as error:
        print('目录站点构建失败: ' + str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
