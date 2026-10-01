"""Real PAM, WebSocket-loss, SSH, logout and editor recovery acceptance on a development host.

Uses a disposable Linux account and loopback-only SSH/HTTP fixtures. Never changes
the host SSH policy or persists the generated account password.
"""

import os, pathlib, pwd, secrets, subprocess, sys, socket, tempfile, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if os.geteuid() != 0 or len(sys.argv) != 3:
    raise SystemExit(
        "Usage (root): live_persistence.py HTTPS_ORIGIN CONTROLLER_LINUX_USER"
    )
controller = sys.argv[2]
if pwd.getpwnam(controller).pw_uid < 1000:
    raise SystemExit("Use a non-root browser controller account")
source = pathlib.Path(__file__).resolve().parents[1]


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h1>Neon session persistence fixture</h1>")

    def log_message(self, *args):
        pass


web = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=web.serve_forever, daemon=True).start()
name = "neon-retain-" + secrets.token_hex(3)
password = secrets.token_urlsafe(24)
uid = None
daemon = None
temp = tempfile.TemporaryDirectory(prefix="neon-ssh-test-")
probe = socket.socket()
probe.bind(("127.0.0.1", 0))
port = probe.getsockname()[1]
probe.close()
try:
    subprocess.run(
        ["useradd", "--create-home", "--shell", "/bin/bash", name], check=True
    )
    uid = pwd.getpwnam(name).pw_uid
    subprocess.run(["chpasswd"], input=f"{name}:{password}\n", text=True, check=True)
    home = pathlib.Path(pwd.getpwnam(name).pw_dir)
    ssh = home / ".ssh"
    ssh.mkdir(mode=0o700)
    os.chown(ssh, uid, pwd.getpwnam(name).pw_gid)
    subprocess.run(
        [
            "runuser",
            "-u",
            name,
            "--",
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-f",
            str(ssh / "id_ed25519"),
        ],
        check=True,
    )
    for file, data in [
        ("authorized_keys", (ssh / "id_ed25519.pub").read_text()),
        (
            "known_hosts",
            f"[127.0.0.1]:{port} "
            + pathlib.Path("/etc/ssh/ssh_host_ed25519_key.pub").read_text(),
        ),
    ]:
        p = ssh / file
        p.write_text(data)
        p.chmod(0o600)
        os.chown(p, uid, pwd.getpwnam(name).pw_gid)
    config = pathlib.Path(temp.name) / "sshd_config"
    config.write_text(
        f"Port {port}\nListenAddress 127.0.0.1\nHostKey /etc/ssh/ssh_host_ed25519_key\nPidFile {temp.name}/pid\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM yes\nPermitRootLogin no\nAllowUsers {name}\n"
    )
    daemon = subprocess.Popen(
        ["/usr/sbin/sshd", "-D", "-e", "-f", str(config)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.3)
    assert daemon.poll() is None, "Temporary loopback SSH daemon failed"
    result = subprocess.run(
        [
            "runuser",
            "-u",
            controller,
            "--",
            "/opt/neon-node/bin/node",
            str(source / "scripts/persistence-check.mjs"),
            sys.argv[1],
            name,
            str(port),
            f"http://127.0.0.1:{web.server_port}/",
        ],
        input=password + "\n",
        text=True,
        capture_output=True,
        timeout=200,
        cwd=source,
    )
    password = None
    print(result.stdout)
    print(result.stderr, file=sys.stderr)
    if result.returncode:
        raise SystemExit(result.returncode)
finally:
    if uid is not None:
        subprocess.run(
            ["systemctl", "stop", f"neon-browser@{uid}", f"neon-worker@{uid}"],
            check=False,
        )
    if daemon is not None:
        daemon.terminate()
        daemon.wait(timeout=5)
    subprocess.run(["userdel", "--remove", name], check=False)
    temp.cleanup()
    web.shutdown()
    web.server_close()
