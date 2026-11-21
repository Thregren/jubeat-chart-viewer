#!/usr/bin/env python3
"""Generate the individual static story payloads from the built-in catalog."""
import argparse
import hashlib
import json
from pathlib import Path


def split_catalog(source: Path, output: Path, *, complete: bool = False) -> int:
    script = source.read_text(encoding="utf-8")
    start = script.index('{"documentCount":')
    catalog, _ = json.JSONDecoder().raw_decode(script[start:])
    records = catalog["records"]
    output.mkdir(parents=True, exist_ok=True)
    index = {}
    for song_id, record in records.items():
        if record["id"] != song_id:
            raise ValueError(f"Invalid story ID: {song_id!r}")
        payload = json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode()
        digest = hashlib.sha256(payload).hexdigest()[:20]
        index[song_id] = digest
        (output / f"background-story-{digest}.json").write_bytes(payload)
    mapping = json.dumps(index, ensure_ascii=False, separators=(",", ":"))
    index_script = f"window.JUBEAT_BACKGROUND_STORY_FILES = {mapping};\n"
    if complete:
        index_script += "window.JUBEAT_BACKGROUND_STORY_INDEX_COMPLETE = true;\n"
    (output / "background-stories-index.js").write_text(index_script, encoding="utf-8")
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
