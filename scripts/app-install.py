#!/usr/bin/env python3
"""Administrator-only installer for prebuilt, frontend-only sandbox packages."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
import stat
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from neon.fs import HomeFS

p = argparse.ArgumentParser()
p.add_argument("package")
args = p.parse_args()
if os.geteuid() != 0:
    raise SystemExit("Administrator privileges required")
source = Path(args.package).resolve()
package = HomeFS(str(source))
manifest = json.loads(package.read("manifest.json"))
appid = manifest.get("id", "")
if not re.fullmatch(r"[a-z][a-z0-9.-]{2,100}", appid) or appid.startswith("org.neon."):
    raise SystemExit("Invalid/reserved application ID")
if manifest.get("runtime") != "sandbox":
    raise SystemExit("Only sandbox frontend packages are accepted")
if not set(manifest.get("permissions", [])) <= {
    "user-files",
    "network",
    "terminal",
    "ssh",
    "notifications",
    "audio",
    "system-information",
}:
    raise SystemExit("Unknown permissions")
for key in ["name", "version", "category", "window", "pinnable"]:
    assert key in manifest, key
if not (source / "frontend/index.html").is_file():
    raise SystemExit("Missing frontend/index.html")
target = Path("/opt/neon-desktop/apps") / appid
if target.exists():
    raise SystemExit("Application already installed; reviewed update required")
files = []
total = 0
for path in source.rglob("*"):
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
        raise SystemExit("Symlinks/special files are not accepted")
    if path.is_file():
        relative = path.relative_to(source)
        if str(relative) != "manifest.json" and relative.parts[0] != "frontend":
            raise SystemExit("Only manifest and frontend files are accepted")
        total += path.stat().st_size
        files.append((path, relative))
if total > 16 * 1024**2 or len(files) > 1000:
    raise SystemExit("Package limits exceeded")
with tempfile.TemporaryDirectory(
    prefix=".install-", dir=target.parent, ignore_cleanup_errors=True
) as temp:
    root = Path(temp)
    for source_file, relative in files:
        dst = root / relative
        dst.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        # Re-open descriptor-relative, rejecting symlink/hardlink swaps after enumeration.
        data = package.read(str(relative))
        dst.write_bytes(data)
        dst.chmod(0o644)
    root.chmod(0o755)
    os.rename(root, target)
package.close()
print("Installed", appid)
print(
    "Restart neon-broker and reload the desktop to discover the package. Worker processes survive broker restart; attached streams reconnect."
)
