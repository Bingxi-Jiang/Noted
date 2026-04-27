from pathlib import Path
import zipfile
import pathspec

# ===== CONFIG =====
PROJECT_DIR = Path(r"./Noted")
OUTPUT_ZIP = Path(r"transcription_ai.zip")

# Extra excludes specifically for AI upload / compression optimization.
# These are excluded even if .gitignore does not mention them.
EXTRA_EXCLUDES = {
    ".gitignore",
    "package-lock.json",
    "README.md",
    ".env",
    ".env.local",
}

EXTRA_EXCLUDE_DIRS = {
    ".git",
    "__pycache__",
    ".next",
    "dist",
    "build",
    "coverage",
    "logs",
    "node_modules",
    ".venv",
    "venv",
    "env",
    "ENV",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}

# Optional: common temporary / local artifact file suffixes.
# Add or remove based on your project needs.
EXTRA_EXCLUDE_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".pyd",
    ".log",
    ".tmp",
    ".temp",
}

# Optional: local DB / generated artifacts.
EXTRA_EXCLUDE_FILENAMES = {
    "transcription.db",
}
# ==================


def posix_path(path: Path) -> str:
    """Convert Path to POSIX-style string for pathspec matching."""
    return str(path).replace("\\", "/")


def load_all_gitignore_specs(project_dir: Path):
    """
    Load every .gitignore under the project.

    Each .gitignore applies relative to the directory where it lives.
    Example:
        Noted/.gitignore applies to Noted/*
        Noted/testfunction/.gitignore applies to Noted/testfunction/*
    """
    specs = []

    for gitignore_path in project_dir.rglob(".gitignore"):
        base_dir = gitignore_path.parent

        try:
            with open(gitignore_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
        except UnicodeDecodeError:
            with open(gitignore_path, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()

        spec = pathspec.PathSpec.from_lines("gitwildmatch", lines)
        specs.append((base_dir, spec))

    # Apply higher-level .gitignore files first, then deeper ones.
    specs.sort(key=lambda item: len(item[0].relative_to(project_dir).parts))

    return specs


def matches_gitignore(abs_path: Path, is_dir: bool, gitignore_specs) -> bool:
    """
    Check whether a path matches any applicable .gitignore.

    This supports nested .gitignore files by matching paths relative to
    the .gitignore's own directory.
    """
    for base_dir, spec in gitignore_specs:
        try:
            rel_to_base = abs_path.relative_to(base_dir)
        except ValueError:
            # This .gitignore is not an ancestor of abs_path.
            continue

        rel_str = posix_path(rel_to_base)

        # For directories, also test with a trailing slash so patterns like
        # logs/ or __pycache__/ match reliably.
        candidates = [rel_str]
        if is_dir and not rel_str.endswith("/"):
            candidates.append(rel_str + "/")

        for candidate in candidates:
            if spec.match_file(candidate):
                return True

    return False


def should_exclude(abs_path: Path, rel_path: Path, is_dir: bool, gitignore_specs) -> bool:
    """
    Decide whether a file or directory should be excluded from the zip.
    """
    parts = set(rel_path.parts)

    # Exclude known unnecessary directories anywhere in the path.
    if parts.intersection(EXTRA_EXCLUDE_DIRS):
        return True

    # Exclude explicit filenames.
    if rel_path.name in EXTRA_EXCLUDES:
        return True

    if rel_path.name in EXTRA_EXCLUDE_FILENAMES:
        return True

    # Exclude suffix-based generated/temp files.
    if rel_path.suffix in EXTRA_EXCLUDE_SUFFIXES:
        return True

    # Exclude files/directories matched by any root or nested .gitignore.
    if matches_gitignore(abs_path, is_dir, gitignore_specs):
        return True

    return False


def zip_project():
    if not PROJECT_DIR.exists():
        raise FileNotFoundError(f"PROJECT_DIR does not exist: {PROJECT_DIR}")

    gitignore_specs = load_all_gitignore_specs(PROJECT_DIR)

    with zipfile.ZipFile(OUTPUT_ZIP, "w", zipfile.ZIP_DEFLATED) as zipf:
        for file_path in PROJECT_DIR.rglob("*"):
            rel_path = file_path.relative_to(PROJECT_DIR)

            if file_path.is_dir():
                continue

            if should_exclude(
                abs_path=file_path,
                rel_path=rel_path,
                is_dir=False,
                gitignore_specs=gitignore_specs,
            ):
                print(f"Skipping: {rel_path}")
                continue

            zipf.write(file_path, arcname=rel_path)
            print(f"Added: {rel_path}")

    print(f"\nDone! Created:\n{OUTPUT_ZIP}")


if __name__ == "__main__":
    zip_project()