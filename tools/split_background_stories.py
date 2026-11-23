#!/usr/bin/env python3
"""Generate the individual static story payloads from the built-in catalog."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile

from package_publication import publication_lock, snapshot_file

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "jubeat_viewer/player"))
from media import write_atomic

INDEX = "background-stories-index.js"
PREVIOUS = ".background-stories.build-previous"
INDEX_PREFIX = "window.JUBEAT_BACKGROUND_STORY_FILES = "
COMPLETE = "window.JUBEAT_BACKGROUND_STORY_INDEX_COMPLETE = true;"
STORY_FILE = re.compile(r"background-story-[a-f0-9]{20}\.json")
DIGEST = re.compile(r"[a-f0-9]{20}")


def is_story_asset(name: str) -> bool:
    return name == INDEX or STORY_FILE.fullmatch(name) is not None


def story_digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()[:20]


def read_generation(directory: Path) -> dict[str, bytes]:
    index = (directory / INDEX).read_bytes()
    text = index.decode("utf-8")
    if not text.startswith(INDEX_PREFIX):
        raise ValueError("Invalid background story index")
    mapping, end = json.JSONDecoder().raw_decode(text, len(INDEX_PREFIX))
    if not isinstance(mapping, dict) or text[end:].strip() not in (";", ";\n" + COMPLETE):
        raise ValueError("Invalid background story index")

    files = {}
    for song_id, digest in mapping.items():
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ValueError(f"Invalid background story digest: {song_id!r}")
        name = f"background-story-{digest}.json"
        payload = (directory / name).read_bytes()
        record = json.loads(payload)
        if not isinstance(record, dict) or record.get("id") != song_id or story_digest(payload) != digest:
            raise ValueError(f"Invalid background story payload: {song_id!r}")
        files[name] = payload
    files[INDEX] = index
    return files


def write_generation(output: Path, files: dict[str, bytes], *, snapshot: Path | None = None) -> None:
    # Publish immutable payloads before switching the index. Cleanup follows the switch.
    output.mkdir(parents=True, exist_ok=True)
    for name, payload in files.items():
        path = output / name
        if (snapshot is not None and name != INDEX and not path.is_symlink()
                and not path.exists() and not (snapshot / name).is_symlink()):
            snapshot_file(snapshot / name, path)
        else:
            write_atomic(path, payload, skip_identical=not path.is_symlink())
    for path in output.iterdir():
        if (STORY_FILE.fullmatch(path.name) and path.name not in files
                and not path.is_symlink() and path.is_file()):
            path.unlink()


def copy_story_assets(source: Path, output: Path, *, complete: bool = False) -> None:
    """Install exactly the indexed payloads and retain the last valid generation."""
    files = read_generation(source)
    complete_flag = COMPLETE.encode()
    if complete and not files[INDEX].rstrip().endswith(complete_flag):
        files[INDEX] = files[INDEX].rstrip() + b"\n" + complete_flag + b"\n"
    try:
        previous = (output / INDEX).read_bytes()
        rollback = read_generation(output) if previous != files[INDEX] else None
    except (FileNotFoundError, ValueError):
        # A missing or damaged build can be repaired from a valid generation.
        rollback = None
    if rollback is not None:
        backup = output / PREVIOUS
        if backup.is_symlink():
            raise ValueError("Background story rollback directory is a symlink")
        write_generation(backup, rollback, snapshot=output)
    write_generation(output, files)


def split_catalog(source: Path, output: Path, *, complete: bool = False) -> int:
    output = output.resolve()
    lock_dir = output.parent / f".{output.name}.stories.build-lock"
    with publication_lock(lock_dir, "split"), tempfile.TemporaryDirectory(dir=lock_dir) as name:
        script = source.read_text(encoding="utf-8")
        start = script.index('{"documentCount":')
        catalog, _ = json.JSONDecoder().raw_decode(script, start)
        records = catalog["records"]
        stage = Path(name)
        index = {}
        for song_id, record in records.items():
            if not isinstance(record, dict) or record.get("id") != song_id:
                raise ValueError(f"Invalid story ID: {song_id!r}")
            payload = json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode()
            digest = story_digest(payload)
            index[song_id] = digest
            (stage / f"background-story-{digest}.json").write_bytes(payload)
        mapping = json.dumps(index, ensure_ascii=False, separators=(",", ":"))
        index_script = f"{INDEX_PREFIX}{mapping};\n"
        if complete:
            index_script += COMPLETE + "\n"
        (stage / INDEX).write_bytes(index_script.encode("utf-8"))
        copy_story_assets(stage, output)
    return len(records)


if __name__ == "__main__":
    static = Path(__file__).resolve().parents[1] / "jubeat_viewer/player/static"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=static / "background-stories-data.js")
    parser.add_argument("--out", type=Path, default=static)
    parser.add_argument("--complete", action="store_true",
                        help="Skip the legacy catalog download when this index covers all stories")
    args = parser.parse_args()
    print(f"Generated {split_catalog(args.source, args.out, complete=args.complete)} story files")
