#!/usr/bin/env python3
"""Build static song previews; no PHP, database, user input endpoint or credentials."""
from __future__ import annotations
import argparse
import hashlib
import html
import json
import os
import re
from pathlib import Path
import tempfile
from urllib.parse import quote, urlencode, urlsplit


def song_key(value):
    number = 0xcbf29ce484222325
    for byte in value.encode('utf-8'):
        number = ((number ^ byte) * 0x100000001b3) & ((1 << 64) - 1)
    return format(number, '016x')


def safe_file(root, relative):
    if not isinstance(relative, str) or not relative or '\\' in relative:
        return None
    rel = Path(relative)
    if rel.is_absolute() or any(part in ('..', '.') for part in rel.parts):
        return None
    path = (root / rel).resolve()
    if os.path.commonpath([str(root.resolve()), str(path)]) != str(root.resolve()) or not path.is_file():
        return None
    return path


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() == data:
        return
    fd, temporary = tempfile.mkstemp(prefix='.share-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_songs(root):
    manifest = json.loads((root / 'data/library.json').read_text(encoding='utf-8'))
    songs = list(manifest.get('songs', []))
    for name in manifest.get('versionIndexes', []):
        path = safe_file(root, name)
        if path is not None:
            songs.extend(json.loads(path.read_text(encoding='utf-8')).get('songs', []))
    return songs


def build_share_pages(library, out, base_url='https://ub.thregren.world/', version='dev', songs=None, template=None):
    library, out = Path(library).resolve(), Path(out).resolve()
    parsed = urlsplit(base_url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('分享站点地址必须是无参数的 HTTP(S) 根地址')
    base_url = base_url.rstrip('/') + '/'
    def emit(relative, data):
        target = out / relative
        if os.path.commonpath([str(out), str(target.resolve())]) != str(out):
            raise ValueError('分享输出路径越界')
        write(target, data)
    template = Path(template) if template else (out / 'index.html' if (out / 'index.html').is_file() else Path(__file__).resolve().parents[1] / '铺面查看器/player/static/index.html')
    viewer = template.read_text(encoding='utf-8')
    if 'id="app"' not in viewer or 'id="panel"' not in viewer:
        raise ValueError('分享模板必须是完整查看器入口')
    viewer = re.sub(r'((?:src|href)=["\'])static/', lambda m: m[1] + html.escape(base_url, quote=True) + 'static/', viewer)
    records, seen = [], {}
    try:
        from PIL import Image, ImageOps
        Image.MAX_IMAGE_PIXELS = 20000000
    except ImportError:
        Image = ImageOps = None
    for song in load_songs(library) if songs is None else songs:
        identity = song.get('id')
        if not isinstance(identity, str) or not identity or len(identity) > 4096:
            raise ValueError('曲目标识无效')
        key = song_key(identity)
        if key in seen:
            raise ValueError('重复曲目或分享标识冲突：' + identity)
        seen[key] = identity
        assets = song.get('assets', {})
        source_name = assets.get('cover') if isinstance(assets, dict) else None
        if not source_name and not assets and song.get('cover'):
            source_name = 'media/cover/' + (identity[:-4] if identity.lower().endswith('.mcz') else identity) + Path(song['cover']).suffix
        cover = safe_file(library, source_name)
        if cover and cover.suffix.lower() not in {'.png','.jpg','.jpeg','.webp','.gif','.bmp','.avif'}:
            cover = None
        image_path = None
        width = height = None
        if cover and Image:
            try:
                with Image.open(cover) as image:
                    image = ImageOps.exif_transpose(image).convert('RGBA')
                    background = Image.new('RGB', image.size, (10, 13, 20))
                    background.paste(image, mask=image.getchannel('A'))
                    image = background
                    image.thumbnail((300, 300), getattr(Image, 'Resampling', Image).LANCZOS)
                    width, height = image.size
                    import io
                    stream = io.BytesIO()
                    image.save(stream, 'JPEG', quality=82, optimize=True)
                    image_path = 'share/images/' + key + '-' + hashlib.sha256(stream.getvalue()).hexdigest()[:12] + '.jpg'
                    emit(image_path, stream.getvalue())
            except (OSError, ValueError, Image.DecompressionBombError):
                image_path = None
                cover = None
        if image_path is None:
            image_path = source_name if cover else 'static/apple-touch-icon-v2.png'
        image_url = base_url + quote(image_path, safe='/')
        title = str(song.get('title') or identity)
        artist = str(song.get('artist') or '')
        description = (artist + ' · ' if artist else '') + '查看歌曲谱面，打开后从头开始。'
        page = 'share/' + key + '.html'
        page_url = base_url + page + '?' + urlencode({'song': identity})
        e = lambda value: html.escape(str(value), quote=True)
        image_type = 'image/jpeg' if image_path.lower().endswith(('.jpg', '.jpeg')) else 'image/png'
        size = '' if not width else '<meta property="og:image:width" content="%s"><meta property="og:image:height" content="%s">' % (width, height)
        metadata = '''
<meta name="jubeat-share-root" content="{base}"><meta name="jubeat-share-song" content="{id}">
<meta name="description" content="{description}"><meta property="og:type" content="website"><meta property="og:site_name" content="jubeat 谱面确认">
<meta property="og:title" content="{title} · 谱面确认"><meta property="og:description" content="{description}"><meta property="og:url" content="{url}">
<meta property="og:image" content="{image}"><meta property="og:image:secure_url" content="{image}"><meta property="og:image:type" content="{image_type}">{size}
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="{title} · 谱面确认"><meta name="twitter:image" content="{image}">
<link rel="canonical" href="{url}">
'''.format(base=e(base_url), title=e(title), description=e(description), id=e(identity), url=e(page_url), image=e(image_url), image_type=e(image_type), size=size)
        content = re.sub(r'<title>.*?</title>', lambda _: '<title>' + e(title) + ' · 谱面确认</title>', viewer, count=1, flags=re.S)
        content = content.replace('</head>', metadata + '</head>', 1)
        content = re.sub(r'<img id="cover"[^>]*>', lambda _: '<img id="cover" class="on" src="' + e(image_url) + '" alt="' + e(title + ' 专辑封面') + '" />', content, count=1)
        for tag, identifier, value in [('h2', 'npTitle', title), ('div', 'npArtist', artist)]:
            content = re.sub(r'(<'+tag+r'[^>]*id="'+identifier+r'"[^>]*>).*?(</'+tag+'>)', lambda m: m[1] + e(value) + m[2], content, count=1, flags=re.S)
        emit(page, content.encode('utf-8'))
        records.append({'id': identity, 'page': page, 'image': image_path, 'title': title})
    summary = {'version': 1, 'songs': len(records), 'base_url': base_url, 'pages': records}
    emit('share/manifest.json', (json.dumps(summary, ensure_ascii=False, separators=(',', ':')) + '\n').encode())
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--base-url', default='https://ub.thregren.world/')
    parser.add_argument('--version', default='dev')
    parser.add_argument('--template', type=Path, help='完整查看器 index.html；部署时使用带缓存摘要的入口')
    args = parser.parse_args()
    result = build_share_pages(args.library, args.out, args.base_url, args.version, template=args.template)
    print(json.dumps({'songs': result['songs'], 'base_url': result['base_url']}, ensure_ascii=False))
