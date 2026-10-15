"""开放目录曲库：只读 JSON 索引和显式资源路径，不打开 MCZ 或旧索引缓存。"""
from __future__ import annotations

import json
from pathlib import Path, PurePosixPath

FORMAT = 'jubeat-directory-v1'
MAX_INDEX = 8 * 1024 * 1024


def asset_path(root: Path, name: str) -> Path:
    if (not isinstance(name, str) or not name or '\\' in name or ':' in name
            or PurePosixPath(name).is_absolute()
            or any(part in ('', '.', '..') for part in name.split('/'))
            or any(ord(c) < 32 for c in name)):
        raise ValueError('无效目录资源路径')
    root = root.resolve()
    path = (root / name).resolve()
    if root not in path.parents:
        raise ValueError('目录资源越界')
    return path


def read_index(path: Path):
    if path.stat().st_size > MAX_INDEX:
        raise ValueError('曲库索引过大')
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('format') != FORMAT or not isinstance(data.get('songs'), list):
        raise ValueError('不是受支持的目录曲库索引')
    return data


def load_directory(root: Path):
    root = root.resolve()
    manifest = read_index(root / 'data/library.json')
    indexes = manifest.get('versionIndexes', [])
    if not isinstance(indexes, list) or len(indexes) > 256 or any(not isinstance(x, str) for x in indexes) or len(set(indexes)) != len(indexes):
        raise ValueError('版本索引清单无效')
    catalogs = [manifest]
    for name in indexes:
        if not isinstance(name, str) or not name.startswith('data/versions/') or not name.endswith('.json'):
            raise ValueError('版本索引路径无效')
        path = asset_path(root, name)
        if path.is_file():  # 允许只安装部分版本包。
            catalogs.append(read_index(path))
    songs, seen, assets = [], set(), set()
    for catalog in catalogs:
        for song in catalog['songs']:
            if not isinstance(song, dict) or not isinstance(song.get('id'), str) or song['id'] in seen:
                raise ValueError('曲目ID无效或重复')
            asset_path(root, song['id'])
            if not isinstance(song.get('title'), str) or not isinstance(song.get('version'), str):
                raise ValueError('曲目标题或版本无效')
            if not isinstance(song.get('charts'), list) or len(song['charts']) > 32:
                raise ValueError('谱面清单无效')
            if not song['charts'] and song.get('resourceOnly') is not True:
                raise ValueError('无谱条目必须标注resourceOnly')
            if not isinstance(song.get('assets'), dict):
                raise ValueError('资源清单无效')
            for name in song['assets'].values():
                asset_path(root, name)
                assets.add(name)
            if any(not isinstance(c, dict) or not isinstance(c.get('code'), str)
                   or '/' in c['code'] or not c['code'] or 'chart:' + c['code'] not in song['assets']
                   for c in song['charts']):
                raise ValueError('谱面缺少显式资源路径')
            if not isinstance(song.get('missing', []), list) or any(not isinstance(x, str) for x in song.get('missing', [])):
                raise ValueError('缺失素材清单无效')
            seen.add(song['id']); songs.append(song)
    if len(songs) > 50000:
        raise ValueError('曲库曲目数过大')
    return dict(format=FORMAT, version=1, songs=songs,
                versions=sorted({s['version'] for s in songs} | {v for c in catalogs for v in c.get('versions', [])})), assets
