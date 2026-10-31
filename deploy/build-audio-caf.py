#!/usr/bin/env python3
"""Create CBR Opus-in-CAF compatibility copies for legacy Safari."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

MIN_FREE_BYTES = 1024**3


def valid_caf(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size < 8 or path.read_bytes()[:4] != b"caff":
        return False
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=codec_name:format=format_name",
            "-of", "json", str(path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if probe.returncode:
        return False
    try:
        data = json.loads(probe.stdout)
        streams = data.get("streams") or []
        formats = (data.get("format") or {}).get("format_name", "")
        return bool(streams) and streams[0].get("codec_name") == "opus" and "caf" in formats
    except (ValueError, TypeError):
        return False


def build_one(source: Path) -> tuple[Path, str]:
    destination = source.with_suffix(".caf")
    stat = source.stat()
    if (
        destination.is_file()
        and destination.stat().st_mtime_ns >= stat.st_mtime_ns
        and valid_caf(destination)
    ):
        return destination, "cached"

    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.stem}-", suffix=".caf.tmp", dir=destination.parent
    )
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-i", str(source), "-map", "0:a:0", "-c:a", "libopus",
                "-b:a", "80k", "-vbr", "off", "-compression_level", "0",
                "-frame_duration", "60", "-application", "audio",
                "-map_metadata", "-1", "-f", "caf", str(temporary),
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if result.returncode:
            raise RuntimeError(result.stderr.strip()[-500:] or "ffmpeg failed")
        if not valid_caf(temporary):
            raise RuntimeError("output is not Opus-in-CAF")
        os.chmod(temporary, 0o644)
        try:
            os.chown(temporary, stat.st_uid, stat.st_gid)
        except PermissionError:
            pass
        os.replace(temporary, destination)
        return destination, "built"
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/www/wwwroot/ub.thregren.world/songs"))
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    for executable in ("ffmpeg", "ffprobe"):
        if not shutil.which(executable):
            parser.error(f"{executable} is required")
    root = args.root.resolve()
    sources = sorted(path for path in root.rglob("*.ogg") if path.is_file())
    if not sources:
        parser.error(f"no .ogg files under {root}")

    required = sum(path.stat().st_size for path in sources)
    free = shutil.disk_usage(root).free
    if args.dry_run:
        print(json.dumps({
            "sources": len(sources),
            "source_bytes": required,
            "free_bytes": free,
            "workers": max(1, args.jobs),
            "profile": "caf/opus/80k/cbr/60ms",
        }, ensure_ascii=False, indent=2))
        return 0
    if free < required + MIN_FREE_BYTES:
        parser.error("not enough free space for CAF copies plus 1 GiB reserve")

    failures: list[tuple[str, str]] = []
    counts = {"cached": 0, "built": 0}
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(build_one, source): source for source in sources}
        for done, future in enumerate(as_completed(futures), 1):
            source = futures[future]
            try:
                _, status = future.result()
                counts[status] += 1
            except Exception as error:
                failures.append((str(source.relative_to(root)), str(error)))
            if done % 100 == 0 or done == len(sources):
                print(
                    f"progress {done}/{len(sources)} built={counts['built']} "
                    f"cached={counts['cached']} failed={len(failures)}",
                    flush=True,
                )
    result = {
        "sources": len(sources),
        **counts,
        "failed": len(failures),
        "failures": failures[:20],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
