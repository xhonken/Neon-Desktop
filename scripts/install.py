#!/usr/bin/env python3
"""Install a prebuilt checkout. Deliberately does not alter firewall or unrelated Caddy sites."""

import argparse
import datetime
import os
from pathlib import Path
import pwd
import shutil
import subprocess
from urllib.parse import urlparse

p = argparse.ArgumentParser()
p.add_argument("--origin", required=True)
p.add_argument("--replace-caddy", action="store_true")
p.add_argument("--node", default=shutil.which("node"))
args = p.parse_args()
if os.geteuid() != 0:
    raise SystemExit("Run with sudo")
if "memory" not in Path("/sys/fs/cgroup/cgroup.controllers").read_text().split():
    raise SystemExit(
        "Memory cgroup controller is required. On Raspberry Pi OS, append cgroup_enable=memory to the existing boot cmdline, reboot during maintenance, and verify the controller before installing."
    )
u = urlparse(args.origin)
if (
    u.scheme != "https"
    or not u.hostname
    or u.path not in ("", "/")
    or u.username
    or u.password
    or u.query
    or u.fragment
):
    raise SystemExit("Expected an HTTPS origin")
node = Path(args.node or "").resolve()
st = node.stat()
if st.st_uid != 0 or st.st_mode & 0o022:
    raise SystemExit("Node runtime must be root-owned and not group/world-writable")
version = subprocess.check_output([str(node), "--version"], text=True).strip()
if tuple(map(int, version.lstrip("v").split(".")[:2])) < (22, 12):
    raise SystemExit(
        "Install supported Node LTS >=22.12 (recommended24), then pass --node /absolute/path/to/node"
    )
origin = args.origin.rstrip("/")
source = Path(__file__).resolve().parents[1]
target = Path("/opt/neon-desktop")
if not (source / "dist/index.html").exists():
    raise SystemExit("Run npm ci and npm run build as the development user first")
subprocess.run(
    ["systemctl", "is-active", "--quiet", "neon-gateway"], stdout=subprocess.DEVNULL
)
# Existing user workers are never restarted by install/update. Schedule that explicitly.
try:
    pwd.getpwnam("neon-gateway")
except KeyError:
    subprocess.run(
        [
            "useradd",
            "--system",
            "--user-group",
            "--home-dir",
            "/nonexistent",
            "--shell",
            "/usr/sbin/nologin",
            "neon-gateway",
        ],
        check=True,
    )
backup = Path("/root/neon-install-backups") / datetime.datetime.now(
    datetime.timezone.utc
).strftime("%Y%m%dT%H%M%SZ")
backup.mkdir(parents=True, mode=0o700)
if target.exists():
    raise SystemExit(
        "Existing installation: use a reviewed maintenance update; live workers are not restarted automatically"
    )
target.mkdir(mode=0o755)
for name in [
    "neon",
    "dist",
    "apps",
    "node_modules",
    "package.json",
    "package-lock.json",
    "scripts",
    "docs",
    "README.md",
    "LICENSE",
]:
    src = source / name
    dst = target / name
    if src.is_dir():
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
    else:
        shutil.copy2(src, dst)
(target / "libexec").mkdir(mode=0o755)
subprocess.run(
    [
        "gcc",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror=implicit-function-declaration",
        "-o",
        str(target / "libexec/pam-auth"),
        str(source / "neon/pam_auth.c"),
        "-lpam",
    ],
    check=True,
)
os.chmod(target / "libexec/pam-auth", 0o700)
subprocess.run(
    [
        "gcc",
        "-O2",
        "-Wall",
        "-Wextra",
        "-o",
        str(target / "libexec/pty-launch"),
        str(source / "neon/pty_launch.c"),
    ],
    check=True,
)
os.chmod(target / "libexec/pty-launch", 0o755)

for f in (source / "deploy").glob("*.service"):
    text = f.read_text().replace(
        "/usr/bin/node /opt/neon-desktop/neon/browser.mjs",
        str(node) + " /opt/neon-desktop/neon/browser.mjs",
    )
    if f.name == "neon-worker@.service":
        text = text.replace(
            "RuntimeDirectory=neon-worker-%i", "RuntimeDirectory=neon-worker-g3-%i"
        )
        unit = "neon-worker-g3@.service"
    else:
        unit = f.name
    (Path("/etc/systemd/system") / unit).write_text(text)
launcher = Path("/usr/local/bin/neon-apps")
launcher.write_text(
    "#!/usr/bin/python3\nimport os\nfrom pathlib import Path\np=Path('/opt/neon-desktop/current')\nbase=p if p.exists() else Path('/opt/neon-desktop')\nos.execv('/usr/bin/python3',['python3',str(base/'scripts/app-center.py'),*__import__('sys').argv[1:]])\n"
)
launcher.chmod(0o755)
shutil.copy2(source / "deploy/pam", "/etc/pam.d/neon-desktop")
config = Path("/etc/neon-desktop")
config.mkdir(mode=0o755, exist_ok=True)
(config / "environment").write_text("NEON_ORIGIN=" + origin + "\n")
os.chmod(config / "environment", 0o644)
caddy = Path("/etc/caddy/Caddyfile")
if caddy.exists() and not args.replace_caddy:
    raise SystemExit(
        "Caddyfile exists; review and pass --replace-caddy only on a dedicated host"
    )
if caddy.exists():
    shutil.copy2(caddy, backup / "Caddyfile")
caddy.write_text(
    """{
    admin localhost:2019
    servers {
        protocols h1 h2
    }
}
"""
    + origin
    + """ {
    tls internal
    header {
        -Server
        Strict-Transport-Security "max-age=31536000"
    }
    reverse_proxy 127.0.0.1:8780 {
        header_up X-Forwarded-For {remote_host}
        header_down -Server
    }
}
"""
)
subprocess.run(["caddy", "validate", "--config", str(caddy)], check=True)
subprocess.run(["systemctl", "daemon-reload"], check=True)
subprocess.run(
    ["systemctl", "enable", "--now", "neon-broker", "neon-gateway", "caddy"], check=True
)
subprocess.run(["systemctl", "reload", "caddy"], check=True)
print(
    "Installed. Open HTTPS in your host firewall; trust the Caddy local CA on clients. Verify real login before announcing readiness."
)
