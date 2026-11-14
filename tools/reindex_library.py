"""Validate the directory manifest before restarting the local development server."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "jubeat_viewer/player"))
import config
from library import Library
if __name__ == "__main__":
    config.ensure_cache_dirs()
    library = Library()
    library.load(force=True)
    print(f"Validated {len(library.songs)} songs; restart the development server to reload its in-memory index")
