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
sys.path.insert(0, str(REPO / 'jubeat_viewer/player'))
from directory_library import load_directory, asset_name, asset_path
from media import write_atomic
from package_site import equal_files
import markers
import config


def copy_or_link(source, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if os.path.samefile(source, dest):
            return
        # 先用轻量 stat 快路径：size + mtime 完全一致就直接跳过。
        src_stat, dst_stat = os.stat(source), os.stat(dest)
        if (src_stat.st_size, src_stat.st_mtime_ns) == (dst_stat.st_size, dst_stat.st_mtime_ns):
            return
        # mtime 变了不代表内容变了（重新拷库、rsync、时钟漂移都会改 mtime）。
        # 这里必须比内容，但不能把几十 MB 音频读成两份内存：流式分块比。
        if equal_files(source, dest):
            return
        # 仅替换构建产物路径，不改动源库或其他硬链接。
        dest.unlink()
    try:
        os.link(source, dest)
    except OSError:
        shutil.copyfile(source, dest)


def _build_directory(source: Path, out: Path, include_markers=True):
    source, out = source.resolve(), out.resolve()
    data, assets = load_directory(source)
    # 先检查再写前端，部分安装的版本只检查已安装索引中的资源。
    # 路径合法性在 load_directory 里已经用字符串判过（asset_name），这里只 stat 存在性；
    # 以前对每个资源再做一次 asset_path().is_file()，等于把同一批路径重新 resolve 一遍。
    for name in sorted(assets):
        if not source.joinpath(*name.split('/')).is_file():
            raise ValueError('已声明资源不存在: ' + name)
    if source != out:
        for top in ('data', 'songs'):
            for p in (source / top).rglob('*'):
                if p.is_file():
                    copy_or_link(p, out / p.relative_to(source))
    out.mkdir(parents=True, exist_ok=True)
    static = REPO / 'jubeat_viewer/player/static'
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
    from publish_site import publish_site, write_json
    publish_site(out, data['songs'], marker_manifest=manifest if include_markers else None)
    stats = dict(format='jubeat-directory-v1', status='complete', songs=len(data['songs']),
                 charts=sum(len(s['charts']) for s in data['songs']),
                 resourceOnly=sum(bool(s.get('resourceOnly')) for s in data['songs']),
                 assets=len(assets), source='explicit-directory-index', mczOpened=0,
                 legacyMetadataRead=False)
    write_json(out / 'data/build.json', stats)
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)
    return stats


def build_directory(source: Path, out: Path, include_markers=True):
    from site_transaction import SiteTransaction
    from web_assets import record_web_assets
    source,out=source.resolve(),out.resolve()
    with SiteTransaction(out) as build:
        result=_build_directory(source,build.stage,include_markers)
        record_web_assets(build.stage)
        build.publish()
    return result


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
