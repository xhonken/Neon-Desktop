#!/usr/bin/env python3
"""Install the shared Debian Bash theme without editing any user's HOME."""

import datetime
import os
from pathlib import Path
import stat
import subprocess
import tempfile

if os.geteuid() != 0:
    raise SystemExit("Run through administrative sudo/SSH")

source = Path(__file__).resolve().parents[1] / "deploy/neon.bashrc"
target = Path("/etc/neon-desktop/bashrc")
global_rc = Path("/etc/bash.bashrc")
begin = "# BEGIN NEON DESKTOP SHELL"
end = "# END NEON DESKTOP SHELL"
hook = f"""{begin}
if [ -r /etc/neon-desktop/bashrc ]; then
    . /etc/neon-desktop/bashrc
fi
{end}
"""


def checked(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit(f"Expected a root-owned, non-writable regular file: {path}")
    return path.read_bytes()


original = checked(global_rc)
old_theme = checked(target) if target.exists() or target.is_symlink() else None
text = original.decode()
if begin in text or end in text:
    if text.count(begin) != 1 or text.count(end) != 1:
        raise SystemExit("Ambiguous Neon shell hook; inspect /etc/bash.bashrc")
    start, end_start = text.index(begin), text.index(end)
    if end_start < start:
        raise SystemExit("Invalid Neon shell hook")
    stop = end_start + len(end)
    text = text[:start] + text[stop:].lstrip("\n")
updated = (text.rstrip("\n") + "\n\n" + hook).encode()
theme = source.read_bytes()
subprocess.run(["/bin/bash", "-n", str(source)], check=True)
subprocess.run(["/bin/bash", "-n"], input=updated, check=True)
target.parent.mkdir(mode=0o755, exist_ok=True)
directory = target.parent.lstat()
if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022:
    raise SystemExit("Expected a root-owned /etc/neon-desktop directory")
if updated == original and theme == old_theme:
    print("Neon Bash theme is already current; no files changed")
    raise SystemExit(0)

backup_root = Path("/root/neon-shell-backups")
backup_root.mkdir(mode=0o700, exist_ok=True)
backup = backup_root / datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
backup.mkdir(parents=True, mode=0o700)
(backup / "bash.bashrc").write_bytes(original)
if old_theme is not None:
    (backup / "neon.bashrc").write_bytes(old_theme)


def replace(path, content):
    fd, name = tempfile.mkstemp(prefix=".neon-shell-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o644)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


try:
    replace(target, theme)
    replace(global_rc, updated)
except BaseException:
    replace(global_rc, original)
    if old_theme is None:
        target.unlink(missing_ok=True)
    else:
        replace(target, old_theme)
    raise
print(f"Neon Bash theme installed for new interactive shells. Backup: {backup}")
print("Existing shells/jobs and all personal .bashrc files were left in place.")
