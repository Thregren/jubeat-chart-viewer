"""Build immutable catalog parts and marker metadata without changing chart timing."""
from __future__ import annotations
import copy
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import wave
from media import write_atomic, safe_join


def write_changed(path, content):
    if path.is_file() and path.read_bytes() == content:
        return
    write_atomic(path, content)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def audio_info(root, relative):
    path = safe_join(root, relative)
    stat = path.stat()
    identity = [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
    cache = root / '.build-state/audio-info' / (hashlib.sha256(relative.encode()).hexdigest() + '.json')
    try:
        saved = json.loads(cache.read_bytes())
        if saved['identity'] == identity:
            return saved['info']
    except (OSError, ValueError, KeyError):
        pass
    info = None
    try:
        if path.suffix.lower() == '.wav':
            with wave.open(str(path)) as stream:
                info = dict(duration=stream.getnframes()/stream.getframerate(),
                            sampleRate=stream.getframerate(), channels=stream.getnchannels())
        elif shutil.which('ffprobe'):
            process = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                '-show_entries', 'stream=sample_rate,channels:format=duration', '-of', 'json', str(path)],
                capture_output=True, timeout=15, check=True)
            value = json.loads(process.stdout)
            stream = value['streams'][0]
            info = dict(duration=float(value['format']['duration']), sampleRate=int(stream['sample_rate']), channels=int(stream['channels']))
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError, EOFError, wave.Error):
        pass  # Legacy or synthetic media can use the browser's metadata probe.
    write_changed(cache, encode(dict(identity=identity, info=info)))
    return info


def enrich_songs(root, songs):
    for song in songs:
        relative = song.get('assets', {}).get('audio')
        if relative:
            info = audio_info(root, relative)
            if info:
                song['audioInfo'] = info


def publish_catalog(root):
    """Keep canonical parts for version ZIPs; publish aliases before the manifest."""
    path = root / 'data/library.json'
    manifest = json.loads(path.read_bytes())
    aliases = []
    enrich_songs(root, manifest['songs'])
    for relative in manifest.get('versionIndexes', []):
        source = safe_join(root, relative)
        canonical = re.sub(r'\.[a-f0-9]{20}(?=\.json$)', '', relative)
        if not source.is_file():
            aliases.append(canonical)
            continue
        part = json.loads(source.read_bytes())
        enrich_songs(root, part['songs'])
        content = encode(part)
        write_changed(root / canonical, content)
        digest = hashlib.sha256(content).hexdigest()[:20]
        alias = canonical[:-5] + '.' + digest + '.json'
        write_changed(root / alias, content)
        aliases.append(alias)
    if 'versionIndexes' in manifest:
        manifest['versionIndexes'] = aliases
    manifest.pop('catalogRevision', None)
    manifest['catalogRevision'] = hashlib.sha256(encode(manifest)).hexdigest()[:20]
    write_changed(path, encode(manifest))
    return aliases


def optimize_markers(root, manifest):
    """Lossless per-channel atlases; raw frames remain available for older clients."""
    try:
        from PIL import Image
    except ImportError:
        write_changed(root/'data/markers.json', encode(manifest))
        print('未安装 Pillow，保留独立 marker PNG；安装 pillow 后可生成图集。', file=__import__('sys').stderr)
        return []
    result = copy.deepcopy(manifest)
    outputs = []
    for design in result.get('designs', []):
        channels = {'MA': design['ma'], **{'H'+str(k): v for k,v in design['h'].items()}}
        atlases = {}
        for channel, count in channels.items():
            if not count:
                continue
            relatives = [f"{design['dir']}/{design['prefix']}_{channel}{i:02d}.png" for i in range(count)]
            paths = [safe_join(root / 'markers', name) for name in relatives]
            if not all(path.is_file() for path in paths):
                continue
            identity = [[p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns] for p in paths]
            cache = root / '.build-state/marker-atlases' / (hashlib.sha256(str(design['id']).encode()).hexdigest()+'-'+channel+'.json')
            try:
                saved = json.loads(cache.read_bytes())
                if saved.get('schema') == 2 and saved['identity'] == identity and safe_join(root/'markers', saved['atlas']['file']).is_file():
                    atlases[channel] = saved['atlas']; outputs.append(saved['atlas']['file']); continue
            except (OSError, ValueError, KeyError):
                pass
            images = []
            for source in paths:
                with Image.open(source) as image:
                    if image.width > 512 or image.height > 512:
                        raise ValueError('Marker frame dimensions exceed budget')
                    images.append(image.convert('RGBA'))
            width = max(i.width for i in images); height = max(i.height for i in images)
            columns = min(8, count); rows = (count + columns - 1) // columns
            atlas = Image.new('RGBA', (columns*(width+4), rows*(height+4)))
            if atlas.width * atlas.height > 4*1024*1024:
                raise ValueError('Marker atlas exceeds pixel budget')
            rects = []
            for i,image in enumerate(images):
                x = (i % columns)*(width+4)+2; y = (i // columns)*(height+4)+2
                atlas.paste(image, (x,y))
                # Extrude edge pixels so scaled crops match the original image clamp.
                atlas.paste(image.crop((0,0,1,image.height)).resize((2,image.height), Image.Resampling.NEAREST), (x-2,y))
                atlas.paste(image.crop((image.width-1,0,image.width,image.height)).resize((2,image.height), Image.Resampling.NEAREST), (x+image.width,y))
                atlas.paste(atlas.crop((x-2,y,x+image.width+2,y+1)).resize((image.width+4,2), Image.Resampling.NEAREST), (x-2,y-2))
                atlas.paste(atlas.crop((x-2,y+image.height-1,x+image.width+2,y+image.height)).resize((image.width+4,2), Image.Resampling.NEAREST), (x-2,y+image.height))
                rects.append([x,y,image.width,image.height,image.getchannel('A').getextrema()[1]/255])
                image.close()
            stream = io.BytesIO(); atlas.save(stream, 'PNG', optimize=True); atlas.close()
            content = stream.getvalue(); digest = hashlib.sha256(content).hexdigest()[:20]
            relative = f"{design['dir']}/{design['prefix']}_{channel}.{digest}.png"
            write_changed(root/'markers'/relative, content)
            metadata = dict(file=relative, width=columns*(width+4), height=rows*(height+4), rects=rects)
            atlases[channel] = metadata; outputs.append(relative)
            write_changed(cache, encode(dict(schema=2, identity=identity, atlas=metadata)))
        design['atlases'] = atlases
    write_changed(root/'data/markers.json', encode(result))
    return outputs


def hash_frontend(root):
    html = (root/'index.html').read_text(encoding='utf-8')
    for relative in set(re.findall(r'(?:src|href)="(static/[^"?]+)', html)):
        source = safe_join(root, relative)
        data = source.read_bytes(); digest = hashlib.sha256(data).hexdigest()[:20]
        alias = relative + '.' + digest + source.suffix
        write_changed(root/alias, data)
        html = html.replace(relative+'?', alias+'?')
    write_changed(root/'index.html', html.encode('utf-8'))


def record_web_assets(root):
    from site_gc import record_snapshot
    catalog=json.loads((root/'data/library.json').read_bytes())
    paths=set(catalog.get('versionIndexes',[]))
    parts=[catalog]
    for relative in catalog.get('versionIndexes',[]):
        path=safe_join(root,relative)
        if path.is_file():parts.append(json.loads(path.read_bytes()))
    for part in parts:
        for song in part['songs']:paths.update(song.get('assets',{}).values())
    for design in json.loads((root/'data/markers.json').read_bytes()).get('designs',[]):
        paths.update('markers/'+atlas['file'] for atlas in design.get('atlases',{}).values())
    record_snapshot(root,paths)
