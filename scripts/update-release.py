#!/usr/bin/env python3
"""Root-only staged updates; immutable workers/jobs survive a gateway version switch."""

import argparse, datetime, hashlib, json, os, pathlib, shutil, socket, subprocess, sys, http.client, time
from urllib.parse import urlparse

BASE = pathlib.Path("/opt/neon-desktop")
STORE = BASE / "releases"
STATE = pathlib.Path("/etc/neon-desktop/releases.json")
p = argparse.ArgumentParser()
p.add_argument("--source", type=pathlib.Path)
p.add_argument("--status", action="store_true")
p.add_argument("--rollback")
p.add_argument("--wait-idle", action="store_true")
args = p.parse_args()
if os.geteuid() != 0:
    raise SystemExit("Run as an administrator through sudo/SSH")


def inventory():
    result = []
    for path in pathlib.Path("/run").glob("neon-worker-*/api.sock"):
        try:
            c = http.client.HTTPConnection("localhost", timeout=3)
            s = socket.socket(socket.AF_UNIX)
            s.settimeout(3)
            s.connect(str(path))
            c.sock = s
            c.request(
                "POST",
                "/rpc",
                b'{"action":"terminal.list"}',
                {"Content-Type": "application/json"},
            )
            r = c.getresponse()
            data = json.loads(r.read())
            c.close()
            live = sum(bool(t["alive"]) for t in data.get("terminals", []))
            result.append({"runtime": path.parent.name, "liveTerminals": live})
        except (OSError, ValueError, http.client.HTTPException):
            result.append({"runtime": path.parent.name, "liveTerminals": "unknown"})
    return result


def run(*cmd):
    subprocess.run(cmd, check=True)


def record(data):
    temp = STATE.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2) + "\n")
    temp.chmod(0o644)
    os.replace(temp, STATE)


def switch(target):
    temp = BASE / ".current-next"
    temp.unlink(missing_ok=True)
    temp.symlink_to(target)
    os.replace(temp, BASE / "current")


def check_ready():
    origin = next(
        line.split("=", 1)[1].strip().strip('"')
        for line in pathlib.Path("/etc/neon-desktop/environment")
        .read_text()
        .splitlines()
        if line.startswith("NEON_ORIGIN=")
    )
    for _ in range(30):
        try:
            c = http.client.HTTPConnection("127.0.0.1", 8780, timeout=2)
            c.request("GET", "/api/v1/me", headers={"Host": urlparse(origin).netloc})
            reply = c.getresponse()
            status = reply.status
            reply.read()
            c.close()
            if status == 401:
                return
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.2)
    raise RuntimeError("Gateway/broker did not become ready")


def configure(target, node):
    for name in ("neon-gateway.service", "neon-broker.service"):
        text = (
            (target / "deploy" / name)
            .read_text()
            .replace(
                "WorkingDirectory=/opt/neon-desktop",
                "WorkingDirectory=/opt/neon-desktop/current",
            )
        )
        (pathlib.Path("/etc/systemd/system") / name).write_text(text)
    gen = json.loads((target / "release.json").read_text())["generation"]
    text = (
        (target / "deploy/neon-worker@.service")
        .read_text()
        .replace(
            "WorkingDirectory=/opt/neon-desktop", "WorkingDirectory=" + str(target)
        )
        .replace(
            "RuntimeDirectory=neon-worker-%i",
            "RuntimeDirectory=neon-worker-" + gen + "-%i",
        )
    )
    (
        pathlib.Path("/etc/systemd/system") / ("neon-worker-" + gen + "@.service")
    ).write_text(text)
    text = (
        (target / "deploy/neon-browser@.service")
        .read_text()
        .replace(
            "WorkingDirectory=/opt/neon-desktop", "WorkingDirectory=" + str(target)
        )
        .replace(
            "/usr/bin/node /opt/neon-desktop/neon/browser.mjs",
            node + " " + str(target / "neon/browser.mjs"),
        )
    )
    (pathlib.Path("/etc/systemd/system/neon-browser@.service")).write_text(text)
    launcher = pathlib.Path("/usr/local/bin/neon-apps")
    launcher.write_text(
        "#!/usr/bin/python3\nimport os\nimport pathlib\np=pathlib.Path('/opt/neon-desktop/current')\nbase=p if p.exists() else pathlib.Path('/opt/neon-desktop')\nos.execv('/usr/bin/python3',['python3',str(base/'scripts/app-center.py'),*__import__('sys').argv[1:]])\n"
    )
    launcher.chmod(0o755)
    run("systemctl", "daemon-reload")


data = (
    json.loads(STATE.read_text())
    if STATE.exists()
    else {"current": None, "releases": {}}
)
active = inventory()
active_jobs = list(
    pathlib.Path("/sys/fs/cgroup/system.slice").glob("neon-job-*.service")
)
if args.status:
    print(
        json.dumps(
            {
                "releases": data,
                "workers": active,
                "jobs": [
                    p.name
                    for p in pathlib.Path("/sys/fs/cgroup/system.slice").glob(
                        "neon-job-*.service"
                    )
                ],
            },
            indent=2,
        )
    )
    sys.exit(0)
if args.wait_idle and (active_jobs or any(r["liveTerminals"] != 0 for r in active)):
    raise SystemExit(
        "Deferred: active jobs, terminals or an unresponsive worker. Run --status; retry when idle. No processes stopped."
    )
STORE.mkdir(mode=0o755, exist_ok=True)
if args.rollback:
    if args.rollback not in data["releases"]:
        raise SystemExit("Choose a registered release from --status")
    # Older APIs may not understand newer session IDs. Defer rollback until these are idle.
    if any(r["liveTerminals"] != 0 for r in active) or list(
        pathlib.Path("/sys/fs/cgroup/system.slice").glob("neon-job-*.service")
    ):
        raise SystemExit(
            "Rollback deferred while jobs/terminals are active. Nothing was stopped."
        )
    target = pathlib.Path(data["releases"][args.rollback]["path"]).resolve()
    if not target.is_relative_to(STORE.resolve()) or not target.is_dir():
        raise SystemExit("Invalid registered release")
    previous = (BASE / "current").resolve()
    switch(target)
    # Gateway/broker only: existing worker/browser units and immutable code are retained.
    try:
        run("systemctl", "restart", "neon-broker", "neon-gateway")
        run("systemctl", "is-active", "--quiet", "neon-broker", "neon-gateway")
        check_ready()
    except Exception:
        switch(previous)
        run("systemctl", "restart", "neon-broker", "neon-gateway")
        raise
    data["current"] = args.rollback
    record(data)
    print("Rolled back frontend/gateway/broker; retained all worker/browser processes")
    sys.exit(0)
source = (args.source or pathlib.Path(__file__).resolve().parents[1]).resolve()
if not (source / "dist/index.html").is_file():
    raise SystemExit("Build and test the checkout as an ordinary user before staging")
version = json.loads((source / "package.json").read_text())["version"]
fingerprint = hashlib.sha256()
for name in (
    "neon",
    "dist",
    "apps",
    "deploy",
    "scripts",
    "docs",
    "package.json",
    "package-lock.json",
    "README.md",
    "CHANGELOG.md",
):
    origin = source / name
    for f in sorted([origin] if origin.is_file() else origin.rglob("*")):
        if f.is_file() and "__pycache__" not in f.parts:
            fingerprint.update(str(f.relative_to(source)).encode() + f.read_bytes())
gen = "g" + fingerprint.hexdigest()[:12]
release = version + "-" + gen
target = STORE / release
if target.exists():
    raise SystemExit("This immutable release is already staged")
# Capture the pre-generation installation for recovery; never copy HOME/state/site config.
if not data["releases"]:
    baseline_version = json.loads((BASE / "package.json").read_text())["version"]
    baseline_name = "baseline-" + baseline_version
    baseline = STORE / baseline_name
    baseline.mkdir()
    for name in (
        "neon",
        "dist",
        "apps",
        "node_modules",
        "deploy",
        "scripts",
        "docs",
        "libexec",
        "package.json",
        "package-lock.json",
        "README.md",
        "LICENSE",
    ):
        origin = BASE / name
        if not origin.exists() and name == "deploy":
            origin = source / name
        if origin.is_dir():
            shutil.copytree(
                origin,
                baseline / name,
                symlinks=True,
                ignore=shutil.ignore_patterns("__pycache__"),
            )
        elif origin.exists():
            shutil.copy2(origin, baseline / name)
    data["releases"][baseline_name] = {
        "path": str(baseline),
        "version": baseline_version,
    }
    data["current"] = baseline_name
    switch(baseline)
    record(data)
target.mkdir()
try:
    for name in (
        "neon",
        "dist",
        "apps",
        "node_modules",
        "deploy",
        "scripts",
        "docs",
        "package.json",
        "package-lock.json",
        "README.md",
        "LICENSE",
        "CHANGELOG.md",
    ):
        origin = source / name
        if origin.is_dir():
            shutil.copytree(
                origin,
                target / name,
                symlinks=True,
                ignore=shutil.ignore_patterns("__pycache__"),
            )
        else:
            shutil.copy2(origin, target / name)
    for f in target.rglob("*"):
        if f.is_symlink() and not f.resolve().is_relative_to(target.resolve()):
            raise ValueError(
                "Release contains a symlink outside its immutable directory"
            )
    (target / "release.json").write_text(
        json.dumps({"generation": gen, "version": version})
    )
    (target / "libexec").mkdir()
    for name in ("pam-auth", "pty-launch"):
        src = "pam_auth.c" if name == "pam-auth" else "pty_launch.c"
        run(
            "cc",
            "-O2",
            "-Wall",
            "-Wextra",
            "-o",
            str(target / "libexec" / name),
            str(target / "neon" / src),
            *(["-lpam"] if name == "pam-auth" else []),
        )
        (target / "libexec" / name).chmod(0o700 if name == "pam-auth" else 0o755)
    # Copying from a trusted admin-selected checkout retains modes, but installation must not be user-writable.
    for parent, dirs, files in os.walk(target):
        os.chmod(parent, 0o755)
        for name in files:
            f = pathlib.Path(parent) / name
            if not f.is_symlink():
                f.chmod(0o755 if f.stat().st_mode & 0o111 else 0o644)
    (target / "libexec/pam-auth").chmod(0o700)
    node = (
        str(pathlib.Path("/opt/neon-node/bin/node").resolve())
        if pathlib.Path("/opt/neon-node/bin/node").exists()
        else shutil.which("node")
    )
    configure(target, node)
    previous = (BASE / "current").resolve()
    switch(target)
    try:
        run("systemctl", "restart", "neon-broker", "neon-gateway")
        run("systemctl", "is-active", "--quiet", "neon-broker", "neon-gateway")
        check_ready()
    except Exception:
        switch(previous)
        run("systemctl", "restart", "neon-broker", "neon-gateway")
        raise
    data["releases"][release] = {
        "path": str(target),
        "version": version,
        "generation": gen,
        "installed": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    data["current"] = release
    record(data)
    print(
        json.dumps(
            {
                "installed": release,
                "retainedWorkers": active,
                "note": "Only gateway/broker restarted; streams reconnect. No existing worker/browser/job terminated.",
            },
            indent=2,
        )
    )
except Exception:
    print(
        "Staging/switch failed. Existing worker/browser processes were not stopped.",
        file=sys.stderr,
    )
    raise
