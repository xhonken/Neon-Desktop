"""Installed HTTPS/PAM desktop handoff with a disposable Linux account."""

import json
import os
import pwd
import secrets
import subprocess
import sys
from pathlib import Path

if os.geteuid() != 0 or len(sys.argv) != 2:
    raise SystemExit("Usage (root): live_desktop_continuity.py CONTROLLER_LINUX_USER")

controller = pwd.getpwnam(sys.argv[1])
if controller.pw_uid < 1000:
    raise SystemExit("Browser controller must be an ordinary Linux user")
source = Path(__file__).resolve().parents[1]
origin = next(line.split("=", 1)[1].strip().strip('"') for line in Path("/etc/neon-desktop/environment").read_text().splitlines() if line.startswith("NEON_ORIGIN="))
name = "neon-view-" + secrets.token_hex(3)
password = secrets.token_urlsafe(32)
account = None
try:
    subprocess.run(["useradd", "--create-home", "--shell", "/bin/bash", name], check=True)
    account = pwd.getpwnam(name)
    os.chmod(account.pw_dir, 0o700)
    subprocess.run(["chpasswd"], input=f"{name}:{password}\n", text=True, check=True)
    result = subprocess.run(
        ["runuser", "-u", controller.pw_name, "--", "/opt/neon-node/bin/node", str(source / "scripts/desktop-continuity-check.mjs"), origin, name],
        input=json.dumps({"password": password}), text=True, capture_output=True,
        timeout=180, cwd=source,
    )
    password = None
    print(result.stdout)
    print(result.stderr, file=sys.stderr)
    if result.returncode:
        raise SystemExit(result.returncode)
    home = Path(account.pw_dir)
    assert (home / "continuity-uid.txt").read_text() == f"{account.pw_uid}\n"
    assert (home / "continuity-input.txt").read_text() == "RELOADED"
    for filename in ("continuity-uid.txt", "continuity-input.txt", ".config/neon-desktop/workspace.json"):
        assert (home / filename).stat().st_uid == account.pw_uid
    assert (home / ".config/neon-desktop/workspace.json").stat().st_mode & 0o777 == 0o600
    print("Actual PTY UID, on-disk content and private shared-workspace ownership PASS")
finally:
    if account is not None:
        uid = account.pw_uid
        subprocess.run(["systemctl", "stop", f"neon-worker@{uid}.service", f"neon-worker-g*@{uid}.service", f"neon-browser@{uid}.service"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["pkill", "-KILL", "-u", str(uid)], check=False)
        subprocess.run(["userdel", "--remove", name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["systemctl", "reset-failed", f"neon-worker-g*@{uid}.service"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
