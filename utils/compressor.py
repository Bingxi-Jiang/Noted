from pathlib import Path
import zipfile
import pathspec

# ===== CONFIG =====
PROJECT_DIR = Path(r"D:\Noted\Noted\claude_transcription")
OUTPUT_ZIP = Path(r"C:\Users\paul2\Downloads\claude_transcription_ai.zip")
GITIGNORE_PATH = PROJECT_DIR / ".gitignore"

# Extra excludes specifically for AI upload optimization
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
}
# ==================


def load_gitignore_spec(gitignore_path: Path):
    if not gitignore_path.exists():
        return None

    with open(gitignore_path, "r", encoding="utf-8") as f:
        return pathspec.PathSpec.from_lines("gitwildmatch", f.readlines())


def should_exclude(rel_path: Path, spec):
    rel_str = str(rel_path).replace("\\", "/")

    # Exclude directories anywhere in path
    if any(part in EXTRA_EXCLUDE_DIRS for part in rel_path.parts):
        return True

    # Exclude explicit files
    if rel_path.name in EXTRA_EXCLUDES:
        return True

    # Exclude .gitignore patterns
    if spec and spec.match_file(rel_str):
        return True

    return False


def zip_project():
    spec = load_gitignore_spec(GITIGNORE_PATH)

    with zipfile.ZipFile(OUTPUT_ZIP, "w", zipfile.ZIP_DEFLATED) as zipf:
        for file_path in PROJECT_DIR.rglob("*"):
            if file_path.is_dir():
                continue

            rel_path = file_path.relative_to(PROJECT_DIR)

            if should_exclude(rel_path, spec):
                print(f"Skipping: {rel_path}")
                continue

            zipf.write(file_path, arcname=rel_path)
            print(f"Added: {rel_path}")

    print(f"\nDone! Created:\n{OUTPUT_ZIP}")


if __name__ == "__main__":
    zip_project()