#!/usr/bin/env python3
"""Create a clean source release from an explicit allowlist, never HOME/config/state."""

import hashlib
import json
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text())["version"]
out = root / "artifacts/releases"
out.mkdir(parents=True, exist_ok=True)
name = "neon-desktop-" + version
archive = out / (name + "-source.tar.gz")
allow = [
    "neon",
    "frontend",
    "apps",
    "deploy",
    "scripts",
    "tests",
    "docs",
    "examples",
    ".github",
    "package.json",
    "package-lock.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "AGENTS.md",
    ".gitignore",
]
files = []
for item in allow:
    p = root / item
    if not p.exists():
        continue
    files.extend(
        [p]
        if p.is_file()
        else [
            f
            for f in p.rglob("*")
            if f.is_file()
            and "__pycache__" not in f.parts
            and not f.name.endswith(".pyc")
        ]
    )
with tarfile.open(archive, "w:gz") as tar:
    for file in sorted(files):
        if file.is_symlink():
            raise SystemExit("Unexpected symlink: " + str(file))
        info = tar.gettarinfo(
            str(file), arcname=name + "/" + str(file.relative_to(root))
        )
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mtime = 0
        with file.open("rb") as stream:
            tar.addfile(info, stream)
(out / "SHA256SUMS").write_text(
    hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n"
)
print(archive)
