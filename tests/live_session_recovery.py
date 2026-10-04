"""Real HTTPS/PAM expiry recovery; age only this fixture's disposable account."""
import json
import os
import pwd
import queue
import secrets
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

if os.geteuid() != 0 or len(sys.argv) != 2:
    raise SystemExit("Usage (root): live_session_recovery.py CONTROLLER_LINUX_USER")
controller = pwd.getpwnam(sys.argv[1])
if controller.pw_uid < 1000:
    raise SystemExit("Use an ordinary browser controller account")
source = Path(__file__).resolve().parents[1]
origin = next(line.split("=", 1)[1].strip().strip('"') for line in Path("/etc/neon-desktop/environment").read_text().splitlines() if line.startswith("NEON_ORIGIN="))
name = "neon-expiry-" + secrets.token_hex(3)
password = secrets.token_urlsafe(32)
account = process = None
try:
    subprocess.run(["useradd", "--create-home", "--shell", "/bin/bash", name], check=True)
    account = pwd.getpwnam(name)
    assert account.pw_uid != controller.pw_uid and account.pw_uid >= 1000
    os.chmod(account.pw_dir, 0o700)
    subprocess.run(["chpasswd"], input=f"{name}:{password}\n", text=True, check=True)
    process = subprocess.Popen(
        ["runuser", "-u", controller.pw_name, "--", "/opt/neon-node/bin/node", str(source / "scripts/session-recovery-check.mjs"), origin, name],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, cwd=source, start_new_session=True,
    )
    process.stdin.write(json.dumps({"password": password}) + "\n"); process.stdin.flush()
    password = None
    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(line) for line in process.stdout], daemon=True).start()
    errors = []
    threading.Thread(target=lambda: errors.extend(process.stderr), daemon=True).start()
    deadline = time.monotonic() + 240
    while process.poll() is None or not lines.empty():
        if time.monotonic() > deadline:
            raise TimeoutError("Installed session recovery acceptance timed out")
        try: line = lines.get(timeout=0.5)
        except queue.Empty: continue
        try: message = json.loads(line)
        except json.JSONDecodeError: message = {}
        operation = message.get("control")
        if not operation:
            print(line, end="", flush=True)
            continue
        with sqlite3.connect("/var/lib/neon-broker/sessions.sqlite3") as db:
            if operation in ("expire-idle", "near-idle"):
                db.execute("UPDATE sessions SET touched=? WHERE uid=?", (time.time() - (1801 if operation == "expire-idle" else 1700), account.pw_uid))
                result = {"ok": True}
            elif operation == "expire-absolute":
                db.execute("UPDATE sessions SET expires=? WHERE uid=?", (time.time() - 1, account.pw_uid))
                result = {"ok": True}
            elif operation == "age":
                row = db.execute("SELECT touched FROM sessions WHERE uid=? ORDER BY created DESC LIMIT 1", (account.pw_uid,)).fetchone()
                assert row is not None
                result = {"ok": True, "age": time.time() - row[0]}
            elif operation == "verify-process":
                sessions = list(Path("/run").glob(f"neon-worker*-{account.pw_uid}/api.sock"))
                assert sessions, "Disposable worker is missing"
                pid = message.get("pid")
                assert isinstance(pid, int) and 1 < pid < 2**31
                status = Path(f"/proc/{pid}/status").read_text()
                uid_line = next(line for line in status.splitlines() if line.startswith("Uid:"))
                assert all(int(value) == account.pw_uid for value in uid_line.split()[1:])
                proof = Path(account.pw_dir) / "session-recovery-uid.txt"
                assert proof.read_text() == f"{account.pw_uid}\n"
                assert proof.stat().st_uid == account.pw_uid
                result = {"ok": True}
            else: raise ValueError("Unsupported fixture operation")
        process.stdin.write(json.dumps(result) + "\n"); process.stdin.flush()
    for line in errors: print(line, end="", file=sys.stderr)
    if process.returncode: raise SystemExit(process.returncode)
finally:
    if process is not None and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    if account is not None:
        uid = account.pw_uid
        subprocess.run(["systemctl", "stop", f"neon-worker@{uid}.service", f"neon-worker-g*@{uid}.service", f"neon-browser@{uid}.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        subprocess.run(["pkill", "-KILL", "-u", str(uid)], check=False)
        subprocess.run(["userdel", "--remove", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        with sqlite3.connect("/var/lib/neon-broker/sessions.sqlite3") as db:
            db.execute("DELETE FROM sessions WHERE uid=?", (uid,))
