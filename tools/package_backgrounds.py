"""Optional background resources shared by directory-library packages."""
from pathlib import Path


def background_files(root: Path) -> set[str]:
    names = set()
    catalog = root / "data/background-stories.json"
    if catalog.is_file():
        names.add(catalog.relative_to(root).as_posix())
    for file in (root / "data/background").rglob("*"):
        if file.is_file() and not any(part.startswith(".") for part in file.relative_to(root).parts):
            names.add(file.relative_to(root).as_posix())
    return names
