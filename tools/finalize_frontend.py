"""Keep generated entry pages aligned with the final deployed viewer shell."""
from html.parser import HTMLParser
from pathlib import Path
import argparse
import os
import re
import tempfile
from urllib.parse import unquote, urlsplit


def write(path, text):
    if path.read_text(encoding='utf-8') == text:
        return
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.frontend-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(text)
        os.chmod(name, path.stat().st_mode & 0o777)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Tags(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.metadata = []
        self.entries = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and 'data-site-extension' in attrs:
            if not attrs.get('src'):
                raise ValueError('Deployment extensions require an external script')
            self.entries.append((attrs['src'], self.get_starttag_text() + '</script>'))
        if tag == 'meta' and (
            attrs.get('name', '').startswith(('jubeat-share-', 'twitter:'))
            or attrs.get('name') == 'description'
            or attrs.get('property', '').startswith('og:')
            or attrs.get('itemprop') in {'name', 'description', 'image'}
        ) or tag == 'link' and attrs.get('rel') == 'canonical':
            self.metadata.append(self.get_starttag_text())


def finalize(site, previous=None):
    site = Path(site).resolve()
    entry = site / 'index.html'
    if not entry.is_file():
        return {'extensions': 0, 'share_pages': 0}
    home = entry.read_text(encoding='utf-8')
    entries = Tags(home).entries
    if previous and (Path(previous) / 'index.html').is_file():
        entries += Tags((Path(previous) / 'index.html').read_text(encoding='utf-8')).entries
    unique = {}
    extension_ids = set()
    for src, tag in entries:
        marker = re.search(r'data-site-extension=["\']([^"\']+)["\']', tag)
        if marker and marker[1] in extension_ids:
            continue
        if marker:
            extension_ids.add(marker[1])
        url = urlsplit(src)
        path = unquote(url.path).lstrip('/')
        target = site / path
        if url.scheme or url.netloc or not path.startswith('static/') or not target.resolve().is_relative_to(site) or not target.is_file():
            raise ValueError('Deployment extension asset missing or unsafe: ' + src)
        unique.setdefault(src, tag)
    present = {src for src, _ in Tags(home).entries}
    for src, tag in unique.items():
        if src not in present:
            if '</body>' not in home:
                raise ValueError('Viewer entry has no closing body')
            home = home.replace('</body>', tag + '\n</body>', 1)
    pages = {}
    for page in sorted((site / 'share').glob('*.html')):
        old = page.read_text(encoding='utf-8')
        metadata = Tags(old).metadata
        if not any('jubeat-share-song' in tag for tag in metadata):
            raise ValueError('Share page lacks song identity: ' + page.name)
        text = home
        for tag in Tags(home).metadata:
            text = text.replace(tag, '')
        title = re.search(r'<title>.*?</title>', old, re.S)
        if title:
            text = re.sub(r'<title>.*?</title>', lambda _: title[0], text, count=1, flags=re.S)
        text = text.replace('</head>', '\n'.join(metadata) + '\n</head>', 1)
        # Keep server-rendered song information while copying all controls from home.
        for pattern in [r'<img\b[^>]*\bid="cover"[^>]*>', r'<h2\b[^>]*\bid="npTitle"[^>]*>.*?</h2>', r'<div\b[^>]*\bid="npArtist"[^>]*>.*?</div>']:
            original = re.search(pattern, old, re.S)
            if original:
                text = re.sub(pattern, lambda _: original[0], text, count=1, flags=re.S)
        text = re.sub(r'((?:src|href)=["\'])static/', lambda m: m[1] + '../static/', text)
        pages[page] = text
    # Validate every page before writing anything. Call inside SiteTransaction.
    write(entry, home)
    for page, text in pages.items():
        write(page, text)
    return {'extensions': len(unique), 'share_pages': len(pages)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', required=True, type=Path)
    parser.add_argument('--previous', type=Path)
    args = parser.parse_args()
    print(finalize(args.site, args.previous))
