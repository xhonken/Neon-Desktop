"""Unprivileged per-Linux-UID filesystem and persistent PTY runtime."""

import asyncio
import base64
import hashlib
import fcntl
import json
import os
import subprocess
import pwd
import re
import signal
import socket
import struct
import termios
import time
import uuid
from pathlib import Path
from aiohttp import web, ClientSession, UnixConnector, ClientTimeout, WSMsgType
from .fs import HomeFS, clean
from .app_packages import AppStore
from .workbench import Workbench, GENERATION, ROOT, admit, ssh_argv


class Terminal:
    def __init__(self, argv, env, cwd_fd=None):
        self.id = GENERATION + "_" + uuid.uuid4().hex
        self.created = time.time()
        self.name = "Terminal"
        self.kind = "shell"
        self.host = ""
        self.owner = None
        self.clients = set()
        self.buffer = bytearray()
        self.last = time.monotonic()
        self.alive = True
        fd, slave = os.openpty()
        try:
            self.process = subprocess.Popen(
                [str(ROOT / "libexec/pty-launch"), *argv],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                start_new_session=True,
                close_fds=True,
                cwd=env["HOME"] if cwd_fd is None else f"/proc/self/fd/{cwd_fd}",
                pass_fds=() if cwd_fd is None else (cwd_fd,),
                env=env,
            )
        except Exception:
            os.close(fd)
            raise
        finally:
            os.close(slave)
        self.pid, self.fd = self.process.pid, fd
        os.set_blocking(fd, False)
        asyncio.get_running_loop().add_reader(fd, self.read)

    def read(self):
        try:
            data = os.read(self.fd, 65536)
            if not data:
                self.finish()
                return
        except BlockingIOError:
            return
        except OSError:
            self.finish()
            return
        self.buffer.extend(data)
        if len(self.buffer) > 262144:
            del self.buffer[:-262144]
        for queue in tuple(self.clients):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(data)

    def finish(self):
        if not self.alive:
            return
        self.alive = False
        asyncio.get_running_loop().remove_reader(self.fd)
        os.close(self.fd)
        try:
            self.process.poll()
        except ChildProcessError:
            pass
        for q in self.clients:
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass

    def terminate(self):
        if self.alive:
            try:
                os.killpg(self.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
            self.finish()

    def resize(self, cols, rows):
        if self.alive:
            fcntl.ioctl(
                self.fd,
                termios.TIOCSWINSZ,
                struct.pack(
                    "HHHH",
                    max(2, min(200, int(rows))),
                    max(2, min(400, int(cols))),
                    0,
                    0,
                ),
            )


async def main():
    os.umask(0o077)
    a = pwd.getpwuid(os.getuid())
    if a.pw_uid < 1000:
        raise RuntimeError("Worker must run as a regular Linux user")
    os.environ.update(
        HOME=a.pw_dir,
        USER=a.pw_name,
        LOGNAME=a.pw_name,
        SHELL=a.pw_shell,
        TERM="xterm-256color",
        COLORTERM="truecolor",
    )
    fs = HomeFS(a.pw_dir)
    terminals = {}
    runtime = f"/run/neon-worker-{GENERATION}-{a.pw_uid}"
    workbench = Workbench(fs, a, runtime)
    app_store = AppStore(fs)
    asyncio.get_running_loop().add_signal_handler(
        signal.SIGCHLD, lambda: [t.process.poll() for t in terminals.values()]
    )
    write_lock = asyncio.Lock()
    config = ".config/neon-desktop"
    for p in [".config", config]:
        try:
            fs.mkdir(p)
        except FileExistsError:
            pass

    def read_config(name, default):
        try:
            return json.loads(fs.read(config + "/" + name + ".json"))
        except FileNotFoundError:
            return default

    @web.middleware
    async def secure(request, handler):
        _, uid, _ = struct.unpack(
            "3i",
            request.transport.get_extra_info("socket").getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, 12
            ),
        )
        if uid not in (0, a.pw_uid):
            raise web.HTTPForbidden()
        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except FileNotFoundError:
            return web.json_response({"error": "Not found"}, status=404)
        except FileExistsError:
            return web.json_response(
                {"error": "Destination already exists"}, status=409
            )
        except (PermissionError, ValueError, KeyError, OSError, UnicodeError) as e:
            return web.json_response({"error": str(e)[:180]}, status=400)

    async def browser(body):
        async with ClientSession(
            connector=UnixConnector(path=f"/run/neon-browser-{a.pw_uid}/api.sock"),
            timeout=ClientTimeout(total=35),
        ) as c:
            async with c.post("http://browser/rpc", json=body) as r:
                return web.Response(
                    body=await r.read(),
                    status=r.status,
                    content_type="application/json",
                )

    async def rpc(request):
        b = await request.json()
        if b.get("action") in (
            "files.write",
            "history.restore",
            "ssh.save",
            "config.save",
        ):
            async with write_lock:
                return await handle(b)
        return await handle(b)

    async def handle(b):
        action = b.get("action")
        if action.startswith("apps."):
            if action == "apps.registry":
                return web.json_response({"apps": app_store.manifests()})
            if action == "apps.asset":
                return web.json_response(
                    app_store.asset(b["target"], b["revision"], b["path"])
                )
            async with app_store.lock:
                if action == "apps.prepare":
                    result = await app_store.prepare(b["entry"])
                elif action == "apps.install":
                    result = app_store.commit(b["token"], b["entry"], b.get("expected"))
                elif action == "apps.remove":
                    result = app_store.remove(b["target"], b["expected"])
                elif action == "apps.cancel":
                    app_store.pending.pop(b.get("token"), None)
                    result = {"ok": True}
                else:
                    raise ValueError("Unknown app operation")
                return web.json_response(result)
        extra = await workbench.dispatch(b)
        if extra is not None:
            return web.json_response(extra)
        path = clean(b.get("path", "."))
        if action == "files.list":
            result = {"entries": await asyncio.to_thread(fs.list, path)}
        elif action == "files.read":
            data = await asyncio.to_thread(fs.read, path)
            result = {
                "data": base64.b64encode(data).decode(),
                "revision": hashlib.sha256(data).hexdigest(),
            }
        elif action == "files.write":
            data = base64.b64decode(b["data"], validate=True)
            lease = workbench.leases.get(path)
            if (
                lease
                and lease["until"] > time.monotonic()
                and b.get("client") != lease["client"]
            ):
                raise ValueError(
                    "This file is being edited in another view; take control or save as another file"
                )
            try:
                previous = await asyncio.to_thread(fs.read, path)
                if (
                    b.get("expected") is not None
                    and hashlib.sha256(previous).hexdigest() != b["expected"]
                ):
                    raise ValueError(
                        "File changed on disk; reopen or save under a new name"
                    )
                if not b.get("exclusive"):
                    await asyncio.to_thread(workbench.history, path, previous)
            except FileNotFoundError:
                pass
            await asyncio.to_thread(
                fs.write, path, data, b.get("exclusive", False), b.get("expected")
            )
            result = {"ok": True, "revision": hashlib.sha256(data).hexdigest()}
        elif action == "files.mkdir":
            await asyncio.to_thread(fs.mkdir, path)
            result = {"ok": True}
        elif action == "files.rename":
            await asyncio.to_thread(fs.rename, path, b["target"])
            result = {"ok": True}
        elif action == "files.delete":
            await asyncio.to_thread(fs.remove, path)
            result = {"ok": True}
        elif action == "files.copy":
            await asyncio.to_thread(fs.copy, path, b["target"])
            result = {"ok": True}
        elif action == "files.zip":
            await asyncio.to_thread(fs.zip, b["paths"], b["target"])
            result = {"ok": True}
        elif action == "files.extract":
            await asyncio.to_thread(fs.extract, path, b["target"])
            result = {"ok": True}
        elif action == "config.get":
            result = read_config("desktop", {})
        elif action == "config.save":
            if len(json.dumps(b["value"])) > 262144:
                raise ValueError("Configuration too large")
            if not isinstance(b["value"], dict):
                raise ValueError("Expected object")
            fs.write(config + "/desktop.json", json.dumps(b["value"]).encode())
            result = {"ok": True}
        elif action == "terminal.list":
            result = {
                "terminals": [
                    dict(
                        id=t.id,
                        alive=t.alive,
                        pid=t.pid,
                        name=t.name,
                        kind=t.kind,
                        host=t.host,
                        created=t.created,
                        attached=len(t.clients),
                        owner=t.owner,
                        exitCode=t.process.poll(),
                    )
                    for t in terminals.values()
                ]
            }
        elif action == "terminal.create":
            if len([t for t in terminals.values() if t.alive]) >= 8:
                raise ValueError("Terminal limit reached")
            admit(a.pw_dir)
            kind = b.get("kind", "shell")
            argv = [a.pw_shell, "-l"]
            if kind == "text":
                argv = ["/usr/bin/w3m", "https://www.debian.org"]
            elif kind == "ssh":
                profile = workbench.selected_profile(b)
                argv = ssh_argv(profile, a.pw_dir)
            elif kind != "shell":
                raise ValueError("Invalid terminal kind")
            ended = [k for k, t in terminals.items() if not t.alive and not t.clients]
            for k in ended[:-16]:
                terminals.pop(k)
            env = dict(os.environ)
            if kind == "ssh":
                env.update(await workbench.agent_env())
            cwd_fd = fs.open(b.get("cwd", "."), os.O_RDONLY | os.O_DIRECTORY) if kind == "shell" else None
            try:
                t = Terminal(argv, env, cwd_fd)
            finally:
                if cwd_fd is not None:
                    os.close(cwd_fd)
            t.kind = kind
            t.name = (
                profile["name"]
                if kind == "ssh"
                else ("Text browser" if kind == "text" else "Local terminal")
            )
            t.host = profile["host"] if kind == "ssh" else ""
            terminals[t.id] = t
            result = {"id": t.id, "alive": True}
        elif action == "terminal.claim":
            client = str(b.get("client", ""))
            if not re.fullmatch(r"[a-f0-9-]{36}", client):
                raise ValueError("Invalid view identity")
            terminals[b["id"]].owner = client
            result = {"ok": True}
        elif action == "terminal.rename":
            terminals[b["id"]].name = str(b["name"])[:80]
            result = {"ok": True}
        elif action == "terminal.stop":
            terminals[b["id"]].terminate()
            result = {"ok": True}
        elif action.startswith("browser."):
            return await browser(b)
        elif action == "storage.info":
            st = os.statvfs(a.pw_dir)
            result = {
                "total": st.f_blocks * st.f_frsize,
                "available": st.f_bavail * st.f_frsize,
                "home": a.pw_dir,
            }
        else:
            raise ValueError("Unknown API action")
        return web.json_response(result)

    async def terminal(request):
        t = terminals.get(request.match_info["id"])
        if not t:
            raise web.HTTPNotFound(text="Terminal process does not exist")
        client = request.query.get("view", "legacy")
        if client != "legacy" and not re.fullmatch(r"[a-f0-9-]{36}", client):
            raise web.HTTPBadRequest()
        if t.owner is None:
            t.owner = client
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=65536)
        await ws.prepare(request)
        await ws.send_bytes(bytes(t.buffer))
        await ws.send_json({"alive": t.alive, "readonly": t.owner != client})
        q = asyncio.Queue(maxsize=32)
        t.clients.add(q)

        async def output():
            while True:
                data = await q.get()
                if data is None:
                    await ws.send_json({"alive": False})
                    return
                await ws.send_bytes(data)

        task = asyncio.create_task(output())
        try:
            async for msg in ws:
                t.last = time.monotonic()
                if msg.type == WSMsgType.TEXT:
                    b = json.loads(msg.data)
                    if b.get("type") == "resize" and t.owner == client:
                        t.resize(b["cols"], b["rows"])
                    elif b.get("type") == "input" and t.alive:
                        if t.owner != client:
                            await ws.send_json(
                                {
                                    "readonly": True,
                                    "error": "Another view controls this terminal; use Take control",
                                }
                            )
                            continue
                        data = b.get("data", "").encode()
                        if len(data) <= 32768:
                            try:
                                os.write(t.fd, data)
                            except BlockingIOError:
                                await ws.send_json(
                                    {"error": "Terminal input busy; retry"}
                                )
        finally:
            t.clients.discard(q)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return ws

    app = web.Application(middlewares=[secure], client_max_size=24 * 1024**2)
    app.add_routes([web.post("/rpc", rpc), web.get("/terminal/{id}", terminal)])
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    path = Path(runtime) / "api.sock"
    path.unlink(missing_ok=True)
    await web.UnixSite(runner, str(path)).start()
    os.chmod(path, 0o600)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
