"""Create a portable catalog using canonical paths, without online hash aliases."""
from __future__ import annotations
import hashlib
import json
import re
import os
import shutil
import argparse
from pathlib import Path, PurePosixPath
from site_transaction import read_site

HASHED = re.compile(r"\.[a-f0-9]{20}(?=\.[^.]+$)")

def hashed_path(rel: str) -> bool:
    return "_hashed" in PurePosixPath(rel).parts or bool(HASHED.search(rel))

def safe_file(root: Path, rel: str) -> Path:
    path = PurePosixPath(rel)
    if path.is_absolute() or not rel or any(x in (".", "..", "") for x in rel.split("/")) or "\\" in rel:
        raise ValueError("Invalid package asset path")
    result = root / rel
    if not result.resolve().is_relative_to(root.resolve()) or not result.is_file():
        raise ValueError("Missing or escaped package asset: " + rel)
    return result

def equal_files(a: Path, b: Path) -> bool:
    if a.samefile(b): return True
    if a.stat().st_size != b.stat().st_size: return False
    with a.open("rb") as x, b.open("rb") as y:
        return equal_streams(x, y)

def equal_streams(x, y) -> bool:
    """Compare files in bounded chunks so packaging supports Python 3.9."""
    while True:
        left, right = x.read(1024 * 1024), y.read(1024 * 1024)
        if left != right:
            return False
        if not left:
            return True

def portable_files(root: Path) -> tuple[set[str], dict[str, bytes]]:
    """Keep canonical fallbacks and all nonhashed platform/extension resources.

    Ordinary directory archives are unaffected. Built sites are recognized by
    their catalog; rewrites are bytes in the archive, never edits to the site.
    """
    files = {p.relative_to(root).as_posix() for p in root.rglob("*")
             if p.is_file()}
    catalog_path = root / "data/library.json"
    if not catalog_path.is_file(): return files, {}
    files = {rel for rel in files if rel == ".htaccess" or not any(part.startswith(".") for part in PurePosixPath(rel).parts)}
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    if not isinstance(catalog.get("songs"), list): raise ValueError("Invalid package catalog")
    replacements = {}
    for index, relative in enumerate(catalog.get('versionIndexes', [])):
        canonical = HASHED.sub('', relative)
        if canonical != relative:
            if not equal_files(safe_file(root, relative), safe_file(root, canonical)):
                raise ValueError('Version index changed while packaging')
            catalog['versionIndexes'][index] = canonical
    for song in catalog["songs"]:
        stem = song["id"][:-4] if song["id"].lower().endswith(".mcz") else song["id"]
        assets = song.get("assets", {})
        for key, rel in list(assets.items()):
            if not hashed_path(rel):
                safe_file(root, rel)
                continue
            if key == "audio": canonical = f"media/audio/{stem}.ogg"
            elif key == "thumb": canonical = f"media/thumb/{stem}.jpg"
            elif key == "cover": canonical = f"media/cover/{stem}{Path(song.get('cover', '')).suffix.lower() or '.png'}"
            elif key.startswith("chart:"): canonical = f"data/charts/{stem}/{key.split(':', 1)[1]}.json"
            else:
                # Unknown extensions retain their explicit reference rather than guess.
                safe_file(root, rel)
                continue
            if not equal_files(safe_file(root, rel), safe_file(root, canonical)):
                raise ValueError("Catalog changed while packaging: " + rel)
            assets[key] = canonical
    replacements["data/library.json"] = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).encode()
    retained_hashes = {rel for song in catalog["songs"] for rel in song.get("assets", {}).values() if hashed_path(rel)}
    marker_path = root / 'data/markers.json'
    if marker_path.is_file():
        marker_manifest=json.loads(marker_path.read_bytes())
        retained_hashes.update('markers/'+atlas['file'] for design in marker_manifest.get('designs', [])
          for atlas in design.get('atlases', {}).values())
    index = root / "index.html"
    if index.is_file():
        html = index.read_text(encoding="utf-8")
        for rel in re.findall(r'(?:src|href)=["\']([^"\'?#]+)', html):
            if not HASHED.search(rel): continue
            canonical = re.sub(r"\.[a-f0-9]{20}\.[^.]+$", "", rel)
            if not equal_files(safe_file(root, rel), safe_file(root, canonical)):
                raise ValueError("Frontend changed while packaging: " + rel)
            html = html.replace(rel, canonical)
        replacements["index.html"] = html.encode()
    # Library media/charts have canonical fallbacks; unhashed marker and sound
    # assets, private extension directories, and dynamic frontend modules remain.
    return {rel for rel in files if not hashed_path(rel) or rel in retained_hashes}, replacements


def stage_portable(source: Path, target: Path) -> None:
    with read_site(source):
        _stage_portable(source, target)


def _stage_portable(source: Path, target: Path) -> None:
    source, target = source.resolve(), target.resolve()
    if target.is_relative_to(source) or source.is_relative_to(target):
        raise ValueError("Portable staging must be separate from source")
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise ValueError("Portable staging destination must be empty")
    files, replacements = portable_files(source)
    target.mkdir(parents=True, exist_ok=True)
    try:
        for rel in sorted(files):
            src = safe_file(source, rel)
            dest = target / rel; dest.parent.mkdir(parents=True, exist_ok=True)
            if rel in replacements:
                dest.write_bytes(replacements[rel])
            else:
                try: os.link(src, dest)
                except OSError: shutil.copy2(src, dest)
    except BaseException:
        shutil.rmtree(target)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stage a portable site without duplicate online aliases")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    stage_portable(args.source, args.out)
