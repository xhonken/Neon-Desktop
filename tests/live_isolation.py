"""Root-only installed-host acceptance using a disposable Linux account.
No credential is persisted. Stops/removes only resources created by this test.
"""

import asyncio
import json
import os
import pwd
import secrets
import ssl
import subprocess
import sys
from pathlib import Path
import aiohttp


async def main():
    origin = sys.argv[1]
    reference = pwd.getpwnam(sys.argv[2])
    name = "neon-check-" + secrets.token_hex(3)
    password = secrets.token_urlsafe(32)
    subprocess.run(["useradd", "-m", "-s", "/bin/bash", name], check=True)
    a = pwd.getpwnam(name)
    os.chmod(a.pw_dir, 0o700)
    try:
        subprocess.run(
            ["chpasswd"], input=(name + ":" + password + "\n").encode(), check=True
        )
        sslctx = ssl.create_default_context(
            cafile="/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt"
        )
        async with aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(ssl=sslctx),
            cookie_jar=aiohttp.CookieJar(unsafe=True),
        ) as c:

            async def post(path, data, csrf="", origin_header=origin):
                async with c.post(
                    origin + "/api/v1/" + path,
                    json=data,
                    headers={"Origin": origin_header, "X-CSRF-Token": csrf},
                ) as r:
                    raw = await r.text()
                    try:
                        b = json.loads(raw)
                    except ValueError:
                        b = {}
                    return r.status, b

            status, b = await post("login", {"username": name, "password": password})
            assert status == 200, (status, b)
            password = None
            csrf = b["csrf"]
            async with c.get(origin + "/api/v1/me") as r:
                me = await r.json()
            assert me["uid"] == a.pw_uid

            async def rpc(action, **kwargs):
                return await post(
                    "rpc", dict(app="org.neon.files", action=action, **kwargs), csrf
                )

            assert (
                await rpc(
                    "files.write", path="proof.txt", data="aXNvbGF0ZWQ=", exclusive=True
                )
            )[0] == 200
            assert Path(a.pw_dir + "/proof.txt").read_text() == "isolated"
            assert Path(a.pw_dir + "/proof.txt").stat().st_uid == a.pw_uid
            assert (await rpc("files.read", path=reference.pw_dir + "/.bashrc"))[
                0
            ] != 200
            assert (
                await rpc("files.read", path="../" + reference.pw_name + "/.bashrc")
            )[0] != 200
            # User-supplied identity cannot override capability-bound identity.
            status, b = await rpc(
                "files.list", path=".", uid=reference.pw_uid, username=reference.pw_name
            )
            assert status == 200
            assert any(e["name"] == "proof.txt" for e in b["entries"])
            assert (
                await post(
                    "rpc",
                    {"app": "org.neon.files", "action": "files.list"},
                    csrf,
                    origin_header="https://invalid.example",
                )
            )[0] == 403
            assert (
                await post("rpc", {"app": "org.neon.files", "action": "files.list"})
            )[0] == 403
            assert (
                await post(
                    "rpc",
                    {"app": "org.neon.applications", "action": "files.list"},
                    csrf,
                )
            )[0] == 403
            # The unprivileged gateway cannot open a worker socket directly.
            script = "import socket; s=socket.socket(socket.AF_UNIX); s.connect(%r)" % (
                str(
                    next(
                        Path("/run").glob(
                            "neon-worker-g*-" + str(a.pw_uid) + "/api.sock"
                        )
                    )
                )
            )
            r = subprocess.run(
                ["runuser", "-u", "neon-gateway", "--", "python3", "-c", script],
                capture_output=True,
            )
            assert r.returncode != 0
            assert (await post("logout", {}, csrf))[0] == 200
            async with c.get(origin + "/api/v1/me") as r:
                assert r.status == 401
            assert (await post("login", {"username": "root", "password": "invalid"}))[
                0
            ] == 401
            for _ in range(5):
                status, _ = await post(
                    "login",
                    {"username": "neon_nonexistent_test", "password": "invalid"},
                )
            status, _ = await post(
                "login", {"username": "neon_nonexistent_test", "password": "invalid"}
            )
            assert status == 429
            print(
                json.dumps(
                    {
                        "pam_second_user": True,
                        "uid_ownership": True,
                        "no_identity_override": True,
                        "cross_home_denied": True,
                        "origin_csrf_permissions": True,
                        "worker_socket_private": True,
                        "logout_revoked": True,
                        "root_rejected": True,
                        "login_throttle": True,
                    },
                    indent=2,
                )
            )
    finally:
        subprocess.run(
            [
                "systemctl",
                "stop",
                f"neon-worker@{a.pw_uid}.service",
                f"neon-worker-g*@{a.pw_uid}.service",
            ],
            check=False,
        )
        subprocess.run(["userdel", "-r", name], check=True)


if __name__ == "__main__":
    asyncio.run(main())
