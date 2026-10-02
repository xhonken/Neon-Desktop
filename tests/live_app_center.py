"""Installed HTTPS/PAM App Center acceptance with real smart HTTPS Git and two disposable users."""

import datetime, ipaddress, json, os, pathlib, pwd, secrets, ssl, subprocess, sys, tempfile, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

if os.geteuid() != 0 or len(sys.argv) != 3:
    raise SystemExit("root: live_app_center.py HTTPS_ORIGIN CONTROLLER_USER")
origin, controller = sys.argv[1:]
source = pathlib.Path(__file__).resolve().parents[1]
account = pwd.getpwnam(controller)
if account.pw_uid < 1000:
    raise SystemExit("Non-root controller required")
nonce = secrets.token_hex(3)
personal = "org.example.personal-" + nonce
glob = "org.example.system-" + nonce
bad = "org.example.invalid-" + nonce
users = []
web = None
process = None
tmp = tempfile.TemporaryDirectory(prefix="neon-app-test-")
root = pathlib.Path(tmp.name)
root.chmod(0o755)
catfile = pathlib.Path("/etc/neon-desktop/catalog.json")
cafile = pathlib.Path("/etc/neon-desktop/git-ca.pem")
backups = {
    p: (p.read_bytes(), p.stat().st_mode & 0o777) if p.exists() else None
    for p in (catfile, cafile)
}
cli = ["/usr/local/bin/neon-apps"]


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def git(*args):
    return subprocess.check_output(
        ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", *args],
        cwd=root / "repo",
        text=True,
    ).strip()


try:
    for suffix in ("a", "b"):
        name = "neon-app-" + nonce + suffix
        password = secrets.token_urlsafe(24)
        run(["useradd", "-m", "-s", "/bin/bash", name])
        u = pwd.getpwnam(name)
        os.chmod(u.pw_dir, 0o700)
        users.append({"username": name, "password": password, "uid": u.pw_uid})
        run(["chpasswd"], input=f"{name}:{password}\n", text=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "Neon temporary Git fixture")]
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(hours=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            False,
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
        .sign(key, hashes.SHA256())
    )
    (root / "key.pem").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    (root / "key.pem").chmod(0o600)
    (root / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    cafile.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    cafile.chmod(0o644)
    (root / "repo").mkdir()
    git("init", "--quiet")
    git("config", "http.receivepack", "false")
    git("config", "uploadpack.allowReachableSHA1InWant", "true")
    html = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="version"></h1><button id="notify">Notify</button><button id="write">Write my file</button><pre id="result"></pre><script src="app.js"></script></body></html>'

    def package(folder, ident, scope, version, permissions):
        p = root / "repo" / folder
        (p / "frontend").mkdir(parents=True, exist_ok=True)
        m = {
            "id": ident,
            "name": "Verification " + ("Personal" if scope == "user" else "Global"),
            "description": "Temporary acceptance fixture",
            "version": version,
            "runtime": "sandbox",
            "installation": scope,
            "permissions": permissions,
            "systemDependencies": ["git"] if scope == "system" else [],
            "category": "utilities",
            "window": {},
        }
        (p / "manifest.json").write_text(json.dumps(m))
        (p / "frontend/index.html").write_text(html)
        (p / "frontend/app.js").write_text(
            'document.querySelector("#version").textContent='
            + json.dumps(version)
            + ";"
            + """let seq=0;const pending=new Map();function call(action,args){const id=String(++seq);parent.postMessage({channel:'neon-sdk-v1',id,action,args},'*');return new Promise(r=>pending.set(id,r));}addEventListener('message',e=>{if(e.source===parent&&e.data.channel==='neon-sdk-v1')pending.get(e.data.id)?.(e.data);});document.querySelector('#notify').onclick=async()=>document.querySelector('#result').textContent=JSON.stringify(await call('notify',{message:'Fixture notification'}));document.querySelector('#write').onclick=async()=>document.querySelector('#result').textContent=JSON.stringify(await call('files.write',{path:'appcenter-proof.txt',data:btoa('owned by signed-in user')}));"""
        )

    package("personal", personal, "user", "1.0.0", ["notifications"])
    package("system", glob, "system", "1.0.0", ["user-files"])
    package("invalid", bad, "user", "1.0.0", [])
    (root / "repo/invalid/frontend/escape").symlink_to("/etc/passwd")
    git("add", ".")
    git("commit", "--quiet", "-m", "Fixture v1")
    first = git("rev-parse", "HEAD")
    package("personal", personal, "user", "2.0.0", ["notifications", "user-files"])
    git("add", ".")
    git("commit", "--quiet", "-m", "Fixture v2")
    second = git("rev-parse", "HEAD")

    class GitHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.handle_git()

        def do_POST(self):
            self.handle_git()

        def handle_git(self):
            url = urllib.parse.urlsplit(self.path)
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1024**2:
                self.send_error(413)
                return
            env = {
                **os.environ,
                "GIT_PROJECT_ROOT": str(root),
                "GIT_HTTP_EXPORT_ALL": "1",
                "REQUEST_METHOD": self.command,
                "PATH_INFO": url.path,
                "QUERY_STRING": url.query,
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                "HTTP_GIT_PROTOCOL": self.headers.get("Git-Protocol", ""),
                "REMOTE_ADDR": "127.0.0.1",
            }
            result = subprocess.run(
                [
                    "git",
                    "-c",
                    "safe.directory=" + str(root / "repo/.git"),
                    "http-backend",
                ],
                env=env,
                input=self.rfile.read(length),
                capture_output=True,
                timeout=30,
            )
            header, _, body = result.stdout.partition(b"\r\n\r\n")
            headers = []
            status = 200
            for line in header.decode().split("\r\n"):
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                if k.lower() == "status":
                    status = int(v.split()[0])
                else:
                    headers.append((k, v.strip()))
            self.send_response(status)
            for k, v in headers:
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    web = ThreadingHTTPServer(("127.0.0.1", 0), GitHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(root / "cert.pem", root / "key.pem")
    web.socket = ctx.wrap_socket(web.socket, server_side=True)
    threading.Thread(target=web.serve_forever, daemon=True).start()
    repository = f"https://127.0.0.1:{web.server_port}/repo/.git"

    def cat(version, commit):
        return {
            "schema": 1,
            "name": "Temporary verification catalog",
            "apps": [
                {
                    "id": personal,
                    "name": "Verification Personal",
                    "description": "Temporary acceptance fixture",
                    "version": version,
                    "installation": "user",
                    "repository": repository,
                    "commit": commit,
                    "path": "personal",
                },
                {
                    "id": glob,
                    "name": "Verification Global",
                    "version": "1.0.0",
                    "installation": "system",
                    "repository": repository,
                    "commit": first,
                    "path": "system",
                },
                {
                    "id": bad,
                    "name": "Invalid verification package",
                    "version": "1.0.0",
                    "installation": "user",
                    "repository": repository,
                    "commit": first,
                    "path": "invalid",
                },
            ],
        }

    (root / "repo/catalog.json").write_text(json.dumps(cat("1.0.0", first)))
    git("add", ".")
    git("commit", "--quiet", "-m", "Catalog v1")
    cat1 = git("rev-parse", "HEAD")
    (root / "repo/catalog.json").write_text(json.dumps(cat("2.0.0", second)))
    git("add", ".")
    git("commit", "--quiet", "-m", "Catalog v2")
    cat2 = git("rev-parse", "HEAD")
    run(cli + ["catalog", "sync", repository, "--commit", cat1])
    run(cli + ["install", glob])
    process = subprocess.Popen(
        [
            "runuser",
            "-u",
            controller,
            "--",
            "/opt/neon-node/bin/node",
            str(source / "scripts/app-center-check.mjs"),
            origin,
        ],
        cwd=source,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    process.stdin.write(
        json.dumps({"users": users, "personal": personal, "global": glob, "bad": bad})
        + "\n"
    )
    process.stdin.close()
    for line in process.stdout:
        if line.strip() == "CATALOG_V2":
            run(cli + ["catalog", "sync", repository, "--commit", cat2])
        else:
            print(line, end="", flush=True)
    code = process.wait(timeout=240)
    if code:
        raise SystemExit(code)
    for u in users:
        proof = pathlib.Path(pwd.getpwnam(u["username"]).pw_dir) / "appcenter-proof.txt"
        assert (
            proof.read_text() == "owned by signed-in user"
            and proof.stat().st_uid == u["uid"]
        )
    globalmanifest = pathlib.Path("/var/lib/neon-apps/system/registry.json")
    assert globalmanifest.stat().st_uid == 0
    print(
        "Actual HOME ownership for both users and root-owned global installation PASS"
    )
finally:
    if process and process.poll() is None:
        process.terminate()
    subprocess.run(
        cli + ["remove", glob], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    for u in users:
        uid = u["uid"]
        subprocess.run(
            [
                "systemctl",
                "stop",
                f"neon-worker-g*@{uid}.service",
                f"neon-browser@{uid}.service",
            ],
            check=False,
        )
        subprocess.run(["pkill", "-KILL", "-u", str(uid)], check=False)
        subprocess.run(
            ["systemctl", "reset-failed", f"neon-worker-g*@{uid}.service"], check=False
        )
        subprocess.run(["userdel", "-r", u["username"]], check=False)
    for p, old in backups.items():
        if old:
            p.write_bytes(old[0])
            p.chmod(old[1])
        else:
            p.unlink(missing_ok=True)
    if web:
        web.shutdown()
        web.server_close()
    tmp.cleanup()
