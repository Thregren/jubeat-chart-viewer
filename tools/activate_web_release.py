"""Validate a staged web build, then switch the web root symlink atomically."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


def activate(release, entry):
    release = release.resolve(strict=True)
    if not release.is_dir():
        raise ValueError('The staged release must be a directory')
    if entry.exists() and not entry.is_symlink():
        raise ValueError('An existing web root must be a symlink')
    subprocess.run([sys.executable, str(Path(__file__).with_name('verify_site.py')),
                    '--out', str(release)], check=True)
    with TemporaryDirectory(prefix='.web-release-', dir=entry.parent) as temporary:
        link = Path(temporary) / 'current'
        link.symlink_to(release, target_is_directory=True)
        os.replace(link, entry)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--entry', type=Path, required=True)
    args = parser.parse_args()
    activate(args.release, args.entry)
