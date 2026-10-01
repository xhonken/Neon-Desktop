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
from .fs import HomeFS


class Terminal:
    def __init__(self, argv, env):
        self.id = uuid.uuid4().hex
        self.clients = set()
        self.buffer = bytearray()
        self.last = time.monotonic()
        self.alive = True
        fd, slave = os.openpty()
        try:
            self.process = subprocess.Popen(
                ["/opt/neon-desktop/libexec/pty-launch", *argv],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                start_new_session=True,
                close_fds=True,
                cwd=env["HOME"],
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
        action = b.get("action")
        path = b.get("path", ".")
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
            async with write_lock:
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
        elif action == "ssh.list":
            result = {"hosts": read_config("ssh-hosts", [])}
        elif action == "ssh.save":
            hosts = b["hosts"]
            if not isinstance(hosts, list) or len(hosts) > 100:
                raise ValueError("Too many profiles")
            clean = []
            for h in hosts:
                host = h.get("host", "")
                username = h.get("username", "")
                port = int(h.get("port", 22))
                if (
                    not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.:_-]{0,252}", host)
                    or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", username)
                    or not 1 <= port <= 65535
                ):
                    raise ValueError("Invalid SSH destination")
                clean.append(
                    dict(
                        name=str(h.get("name", ""))[:80],
                        group=str(h.get("group", ""))[:80],
                        host=host,
                        username=username,
                        port=port,
                    )
                )
            fs.write(config + "/ssh-hosts.json", json.dumps(clean).encode())
            result = {"ok": True}
        elif action == "terminal.list":
            result = {
                "terminals": [dict(id=t.id, alive=t.alive) for t in terminals.values()]
            }
        elif action == "terminal.create":
            if len([t for t in terminals.values() if t.alive]) >= 8:
                raise ValueError("Terminal limit reached")
            kind = b.get("kind", "shell")
            argv = [a.pw_shell, "-l"]
            if kind == "text":
                argv = ["/usr/bin/w3m", "https://www.debian.org"]
            elif kind == "ssh":
                hosts = read_config("ssh-hosts", [])
                h = hosts[int(b["profile"])]
                argv = [
                    "/usr/bin/ssh",
                    "-o",
                    "StrictHostKeyChecking=ask",
                    "-o",
                    "ForwardAgent=no",
                    "-o",
                    "ClearAllForwardings=yes",
                    "-p",
                    str(h["port"]),
                    "-l",
                    h["username"],
                    "--",
                    h["host"],
                ]
            elif kind != "shell":
                raise ValueError("Invalid terminal kind")
            ended = [k for k, t in terminals.items() if not t.alive and not t.clients]
            for k in ended[:-16]:
                terminals.pop(k)
            t = Terminal(argv, dict(os.environ))
            terminals[t.id] = t
            result = {"id": t.id, "alive": True}
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
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=65536)
        await ws.prepare(request)
        await ws.send_bytes(bytes(t.buffer))
        await ws.send_json({"alive": t.alive})
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
                    if b.get("type") == "resize":
                        t.resize(b["cols"], b["rows"])
                    elif b.get("type") == "input" and t.alive:
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
    path = Path(f"/run/neon-worker-{a.pw_uid}/api.sock")
    path.unlink(missing_ok=True)
    await web.UnixSite(runner, str(path)).start()
    os.chmod(path, 0o600)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
