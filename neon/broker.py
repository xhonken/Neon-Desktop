"""Privileged boundary: PAM, opaque sessions, fixed user service activation and routing.
No filesystem path, executable, unit name or UID is accepted from the gateway.
"""

import asyncio
import hashlib
import json
import logging
import os
import pwd
import re
import secrets
import socket
import sqlite3
import struct
import time
from collections import defaultdict, deque
from pathlib import Path
from aiohttp import web, ClientSession, UnixConnector, ClientTimeout, WSMsgType

LOG = logging.getLogger("neon.security")
STATE = Path("/var/lib/neon-broker")
RUNTIME = Path("/run/neon-broker")
APPROOT = Path("/opt/neon-desktop/apps")
ALLOWED = {
    "user-files",
    "terminal",
    "ssh",
    "network",
    "notifications",
    "system-information",
    "audio",
}
ACTION_PERMISSION = {
    "files.": "user-files",
    "terminal.": "terminal",
    "ssh.": "ssh",
    "browser.": "network",
    "storage.": "user-files",
}


class Sessions:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, sid TEXT, uid INTEGER, created REAL, touched REAL, expires REAL, csrf TEXT, peer TEXT)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS grants (uid INTEGER, app TEXT, permission TEXT, PRIMARY KEY(uid,app,permission))"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS audit (time REAL, uid INTEGER, event TEXT, peer TEXT)"
        )
        if "principal" not in {
            r[1] for r in self.db.execute("PRAGMA table_info(sessions)")
        }:
            self.db.execute(
                "ALTER TABLE sessions ADD COLUMN principal TEXT NOT NULL DEFAULT ''"
            )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS principals (uid INTEGER PRIMARY KEY, identity TEXT)"
        )
        self.db.commit()

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def issue(self, uid, peer):
        identity = principal(uid)
        old = self.db.execute(
            "SELECT identity FROM principals WHERE uid=?", (uid,)
        ).fetchone()
        if old and old[0] != identity:
            for table in ("sessions", "grants", "audit"):
                self.db.execute("DELETE FROM " + table + " WHERE uid=?", (uid,))
        self.db.execute(
            "INSERT OR REPLACE INTO principals VALUES (?,?)", (uid, identity)
        )
        now = time.time()
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        self.db.execute(
            "DELETE FROM sessions WHERE expires < ? OR touched < ?", (now, now - 1800)
        )
        if (
            self.db.execute(
                "SELECT count(*) FROM sessions WHERE uid=?", (uid,)
            ).fetchone()[0]
            >= 10
        ):
            raise web.HTTPTooManyRequests()
        self.db.execute(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)",
            (
                self.digest(token),
                secrets.token_hex(12),
                uid,
                now,
                now,
                now + 43200,
                csrf,
                peer,
                identity,
            ),
        )
        self.db.commit()
        return token, csrf

    def get(self, token):
        row = self.db.execute(
            "SELECT sid,uid,created,touched,expires,csrf,peer,principal FROM sessions WHERE token=?",
            (self.digest(token),),
        ).fetchone()
        if not row or row[4] < time.time() or row[3] < time.time() - 1800:
            raise web.HTTPUnauthorized()
        try:
            account = eligible(pwd.getpwuid(row[1]).pw_name)
            if row[7] != principal(row[1]):
                raise ValueError("Account changed")
        except (KeyError, ValueError, OSError):
            raise web.HTTPUnauthorized()
        self.db.execute(
            "UPDATE sessions SET touched=? WHERE token=?",
            (time.time(), self.digest(token)),
        )
        self.db.commit()
        return dict(
            sid=row[0],
            uid=row[1],
            created=row[2],
            csrf=row[5],
            peer=row[6],
            account=account,
        )

    def event(self, uid, event, peer):
        self.db.execute(
            "INSERT INTO audit VALUES (?,?,?,?)", (time.time(), uid, event, peer)
        )
        self.db.execute("DELETE FROM audit WHERE time < ?", (time.time() - 30 * 86400,))
        self.db.commit()
        LOG.info("%s uid=%s peer=%s", event, uid, peer)


def principal(uid):
    a = pwd.getpwuid(uid)
    st = os.stat(a.pw_dir, follow_symlinks=False)
    return json.dumps([a.pw_name, a.pw_dir, st.st_dev, st.st_ino])


def eligible(name):
    if not isinstance(name, str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", name):
        raise ValueError("Invalid account")
    a = pwd.getpwnam(name)
    shells = Path("/etc/shells").read_text().splitlines()
    if (
        a.pw_uid < 1000
        or a.pw_uid == 65534
        or a.pw_shell not in shells
        or a.pw_shell.endswith(("nologin", "false"))
        or not a.pw_dir.startswith("/home/")
    ):
        raise ValueError("Account not eligible")
    return a


def manifests():
    result = {}
    for file in APPROOT.glob("*/manifest.json"):
        data = json.loads(file.read_text())
        if (
            not re.fullmatch(r"[a-z][a-z0-9.-]{2,100}", data["id"])
            or data["id"] != file.parent.name
        ):
            raise ValueError("Invalid app id")
        if not set(data.get("permissions", [])) <= ALLOWED:
            raise ValueError("Unknown permission")
        if data.get("runtime") not in ("core", "sandbox"):
            raise ValueError("Unknown app runtime")
        result[data["id"]] = data
    return result


async def main():
    if "memory" not in Path("/sys/fs/cgroup/cgroup.controllers").read_text().split():
        raise RuntimeError(
            "Memory cgroup controller is required; refusing unbounded workers"
        )
    os.umask(0o077)
    STATE.mkdir(exist_ok=True)
    RUNTIME.mkdir(exist_ok=True)
    gateway = pwd.getpwnam("neon-gateway")
    sessions = Sessions(STATE / "sessions.sqlite3")
    apps = manifests()
    attempts = defaultdict(deque)
    global_attempts = deque()
    auth_slots = asyncio.Semaphore(3)
    locks = defaultdict(asyncio.Lock)

    @web.middleware
    async def boundary(request, handler):
        peer = request.transport.get_extra_info("socket").getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, 12
        )
        _, uid, _ = struct.unpack("3i", peer)
        if uid not in (0, gateway.pw_uid):
            raise web.HTTPForbidden()
        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except (ValueError, KeyError, TypeError):
            raise web.HTTPBadRequest(text="Invalid request")
        except Exception:
            LOG.exception("Broker request failed")
            raise web.HTTPServiceUnavailable(text="Service unavailable")

    def identify(request):
        token = request.headers.get("Authorization", "").removeprefix("Bearer ")
        s = sessions.get(token)
        if request.method not in ("GET", "HEAD") and not secrets.compare_digest(
            request.headers.get("X-CSRF-Token", ""), s["csrf"]
        ):
            raise web.HTTPForbidden()
        return token, s

    async def activate(uid, browser=False):
        key = ("browser" if browser else "worker", uid)
        path = f"/run/neon-{key[0]}-{uid}/api.sock"
        async with locks[key]:
            if not os.path.exists(path):
                proc = await asyncio.create_subprocess_exec(
                    "/usr/bin/systemctl",
                    "start",
                    f"neon-{key[0]}@{uid}.service",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                if await proc.wait() != 0:
                    raise web.HTTPServiceUnavailable()
                for _ in range(250 if browser else 60):
                    if os.path.exists(path):
                        break
                    await asyncio.sleep(0.1)
            if not os.path.exists(path):
                raise web.HTTPServiceUnavailable()
        return path

    async def worker(uid, payload):
        path = await activate(uid)
        async with ClientSession(
            connector=UnixConnector(path=path), timeout=ClientTimeout(total=45)
        ) as c:
            async with c.post("http://worker/rpc", json=payload) as r:
                data = await r.read()
                return web.Response(
                    status=r.status, body=data, content_type="application/json"
                )

    async def login(request):
        body = await request.json()
        name = body.get("username", "")
        password = body.get("password", "")
        peer = request.headers.get("X-Client-IP", "unknown")[:64]
        now = time.monotonic()
        key = (peer, str(name)[:32])
        q = attempts[key]
        while q and q[0] < now - 300:
            q.popleft()
        while global_attempts and global_attempts[0] < now - 60:
            global_attempts.popleft()
        if len(attempts) > 10000:
            attempts.clear()
        if len(q) >= 5 or len(global_attempts) >= 30:
            raise web.HTTPTooManyRequests(text="Sign in failed.")
        q.append(now)
        global_attempts.append(now)
        try:
            account = eligible(name)
            if (
                not isinstance(password, str)
                or not 1 <= len(password.encode()) <= 1024
                or any(c in password for c in "\n\x00\r")
            ):
                raise ValueError()
            async with auth_slots:
                proc = await asyncio.create_subprocess_exec(
                    "/opt/neon-desktop/libexec/pam-auth",
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                try:
                    await asyncio.wait_for(
                        proc.communicate((name + "\n" + password + "\n").encode()), 16
                    )
                except TimeoutError:
                    proc.kill()
                    await proc.wait()
                    raise ValueError()
                if proc.returncode:
                    raise ValueError()
            token, csrf = sessions.issue(account.pw_uid, peer)
            sessions.event(account.pw_uid, "login", peer)
            return web.json_response(dict(token=token, csrf=csrf))
        except (ValueError, KeyError):
            sessions.event(None, "login-failed", peer)
            await asyncio.sleep(0.7)
            raise web.HTTPUnauthorized(text="Sign in failed.")
        finally:
            password = None

    async def me(request):
        _, s = identify(request)
        a = s["account"]
        return web.json_response(
            dict(
                username=a.pw_name,
                uid=a.pw_uid,
                home=a.pw_dir,
                shell=a.pw_shell,
                csrf=s["csrf"],
                session=s["sid"],
                apps=[
                    {
                        **app,
                        "granted": [
                            r[0]
                            for r in sessions.db.execute(
                                "SELECT permission FROM grants WHERE uid=? AND app=?",
                                (s["uid"], app["id"]),
                            )
                        ],
                    }
                    for app in apps.values()
                ],
            )
        )

    async def logout(request):
        token, s = identify(request)
        sessions.db.execute(
            "DELETE FROM sessions WHERE token=?", (sessions.digest(token),)
        )
        sessions.db.commit()
        sessions.event(s["uid"], "logout", s["peer"])
        return web.json_response({"ok": True})

    async def permissions(request):
        _, s = identify(request)
        body = await request.json()
        appid = body.get("app")
        app = apps.get(appid)
        if not app or app["runtime"] != "sandbox":
            raise web.HTTPBadRequest()
        grants = body.get("permissions", [])
        if (
            not isinstance(grants, list)
            or not set(grants) <= set(app["permissions"])
            or not set(grants) <= {"user-files", "notifications"}
        ):
            raise web.HTTPForbidden(text="Unsupported third-party capability")
        sessions.db.execute(
            "DELETE FROM grants WHERE uid=? AND app=?", (s["uid"], appid)
        )
        sessions.db.executemany(
            "INSERT INTO grants VALUES (?,?,?)",
            [(s["uid"], appid, p) for p in set(grants)],
        )
        sessions.db.commit()
        sessions.event(s["uid"], "app-permissions", s["peer"])
        return web.json_response({"ok": True})

    async def security(request):
        token, s = identify(request)
        if request.method == "POST":
            sessions.db.execute(
                "DELETE FROM sessions WHERE uid=? AND token!=?",
                (s["uid"], sessions.digest(token)),
            )
            sessions.db.commit()
            return web.json_response({"ok": True})
        rows = sessions.db.execute(
            "SELECT sid,created,touched,peer FROM sessions WHERE uid=? AND expires>? AND touched>?",
            (s["uid"], time.time(), time.time() - 1800),
        ).fetchall()
        events = sessions.db.execute(
            "SELECT time,event,peer FROM audit WHERE uid=? ORDER BY time DESC LIMIT 20",
            (s["uid"],),
        ).fetchall()
        return web.json_response(
            dict(
                sessions=[
                    dict(
                        id=r[0],
                        created=r[1],
                        last=r[2],
                        peer=r[3],
                        current=r[0] == s["sid"],
                    )
                    for r in rows
                ],
                events=events,
            )
        )

    def permit(appid, action, uid):
        app = apps.get(appid)
        if not app:
            raise web.HTTPForbidden()
        needed = next(
            (p for prefix, p in ACTION_PERMISSION.items() if action.startswith(prefix)),
            None,
        )
        if needed and needed not in app["permissions"]:
            raise web.HTTPForbidden()
        if app["runtime"] != "core":
            grants = {
                r[0]
                for r in sessions.db.execute(
                    "SELECT permission FROM grants WHERE uid=? AND app=?", (uid, appid)
                )
            }
            if not action.startswith("files.") or needed not in grants:
                raise web.HTTPForbidden(text="Application permission denied")

    async def rpc(request):
        _, s = identify(request)
        body = await request.json()
        action = body.get("action", "")
        permit(body.get("app"), action, s["uid"])
        if action.startswith("browser."):
            await activate(s["uid"], True)
        return await worker(s["uid"], body)

    async def stream(request):
        token, s = identify(request)
        kind = request.match_info["kind"]
        appid = request.query.get("app", "")
        permit(appid, kind + ".stream", s["uid"])
        csrf = request.query.get("csrf", "")
        if not secrets.compare_digest(csrf, s["csrf"]):
            raise web.HTTPForbidden()
        if kind not in ("terminal", "browser"):
            raise web.HTTPNotFound()
        path = await activate(s["uid"], kind == "browser")
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=131072)
        await ws.prepare(request)
        endpoint = (
            "/stream" if kind == "browser" else "/terminal/" + request.match_info["id"]
        )
        async with ClientSession(connector=UnixConnector(path=path)) as c:
            async with c.ws_connect(
                "http://worker" + endpoint, max_msg_size=4 * 1024 * 1024
            ) as downstream:

                async def incoming():
                    async for m in ws:
                        sessions.get(token)
                        if m.type == WSMsgType.TEXT:
                            await downstream.send_str(m.data)
                        elif m.type == WSMsgType.BINARY:
                            await downstream.send_bytes(m.data)

                async def outgoing():
                    async for m in downstream:
                        sessions.get(token)
                        if m.type == WSMsgType.TEXT:
                            await ws.send_str(m.data)
                        elif m.type == WSMsgType.BINARY:
                            await ws.send_bytes(m.data)

                async def expires():
                    # Do not renew idle time by output alone.
                    while True:
                        await asyncio.sleep(15)
                        row = sessions.db.execute(
                            "SELECT expires,touched FROM sessions WHERE token=?",
                            (sessions.digest(token),),
                        ).fetchone()
                        if (
                            not row
                            or row[0] < time.time()
                            or row[1] < time.time() - 1800
                        ):
                            return

                tasks = [
                    asyncio.create_task(f()) for f in (incoming, outgoing, expires)
                ]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in tasks:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        await ws.close()
        return ws

    app = web.Application(middlewares=[boundary], client_max_size=24 * 1024**2)
    app.add_routes(
        [
            web.post("/login", login),
            web.get("/me", me),
            web.post("/logout", logout),
            web.get("/security", security),
            web.post("/security", security),
            web.post("/rpc", rpc),
            web.post("/permissions", permissions),
            web.get("/stream/{kind}/{id}", stream),
        ]
    )
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    path = RUNTIME / "api.sock"
    path.unlink(missing_ok=True)
    await web.UnixSite(runner, str(path)).start()
    os.chown(path, 0, gateway.pw_gid)
    os.chmod(path, 0o660)
    await asyncio.Event().wait()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
