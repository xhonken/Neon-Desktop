"""Per-user workspace features. All filesystem and process work remains unprivileged."""

import asyncio
import base64
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import stat
import struct
import time
import uuid
from .fs import HomeFS, beneath, clean
from .desktop_state import DesktopState

ROOT = Path(__file__).resolve().parents[1]
try:
    GENERATION = json.loads((ROOT / "release.json").read_text())["generation"]
except FileNotFoundError:
    GENERATION = "g3"
if not re.fullmatch(r"g[a-f0-9]{1,16}", GENERATION):
    raise RuntimeError("Invalid installed generation")


def resources(home):
    mem = {
        k: int(v.split()[0]) * 1024
        for k, v in (
            line.split(":", 1)
            for line in Path("/proc/meminfo").read_text().splitlines()
        )
    }
    st = os.statvfs(home)
    return {
        "memoryAvailable": mem["MemAvailable"],
        "memoryTotal": mem["MemTotal"],
        "diskAvailable": st.f_bavail * st.f_frsize,
        "warnings": (
            ["Low memory: new heavy sessions may be refused"]
            if mem["MemAvailable"] < 1024**3
            else []
        )
        + (
            ["Low disk space: save/export your work"]
            if st.f_bavail * st.f_frsize < 2 * 1024**3
            else []
        ),
    }


def admit(home, memory=256 * 1024**2):
    r = resources(home)
    if r["diskAvailable"] < 512 * 1024**2 or r["memoryAvailable"] < max(
        768 * 1024**2, memory + 512 * 1024**2
    ):
        raise ValueError(
            "Not enough free memory or disk space to start this session; existing jobs are left running"
        )


def profile(value):
    if not isinstance(value, dict) or any(
        k in value for k in ("password", "passphrase", "privateKey")
    ):
        raise ValueError("Secrets must not be saved in connection profiles")
    result = {
        k: str(value.get(k, ""))
        for k in ("id", "name", "host", "username", "group", "key", "session")
    }
    result["id"] = result["id"] or uuid.uuid4().hex
    if not re.fullmatch(r"[a-f0-9]{32}", result["id"]):
        raise ValueError("Invalid profile ID")
    if not result["name"] or len(result["name"]) > 80 or len(result["group"]) > 80:
        raise ValueError("Invalid profile name/group")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.:_-]{0,252}", result["host"]):
        raise ValueError("Invalid hostname")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", result["username"]):
        raise ValueError("A Linux username is required")
    result["port"] = int(value.get("port", 22))
    if not 1 <= result["port"] <= 65535:
        raise ValueError("Invalid port")
    result["auth"] = value.get("auth", "auto")
    if result["auth"] not in ("password", "key", "auto"):
        raise ValueError("Invalid authentication type")
    if result["key"] and not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", result["key"]):
        raise ValueError("Choose a key in ~/.ssh")
    result["persistent"] = bool(value.get("persistent", False))
    result["session"] = result["session"] or "neon"
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,40}", result["session"]):
        raise ValueError("Invalid tmux session name")
    return result


def ssh_argv(p, home):
    p = profile(p)
    argv = [
        "/usr/bin/ssh",
        "-F",
        "/dev/null",
        "-o",
        "StrictHostKeyChecking=ask",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-p",
        str(p["port"]),
        "-l",
        p["username"],
    ]
    if p["auth"] == "key":
        if not p["key"]:
            raise ValueError("Select a private key")
        argv += [
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "PreferredAuthentications=publickey",
            "-i",
            str(Path(home) / ".ssh" / p["key"]),
        ]
    elif p["auth"] == "password":
        argv += [
            "-o",
            "PubkeyAuthentication=no",
            "-o",
            "PreferredAuthentications=keyboard-interactive,password",
        ]
    if p["persistent"]:
        argv += ["-t"]
    argv += ["--", p["host"]]
    if p["persistent"]:
        # Every remote argument is fixed or constrained to alphanumeric/_/- above.
        argv += ["tmux", "new-session", "-A", "-s", p["session"]]
    return argv


class Workbench:
    def __init__(self, fs, account, runtime):
        self.fs, self.account, self.runtime = fs, account, Path(runtime)
        self.config = ".config/neon-desktop"
        self.data = ".local/share/neon-desktop"
        for folder in (
            ".config",
            self.config,
            ".local",
            ".local/share",
            self.data,
            self.data + "/history",
            self.data + "/jobs",
        ):
            try:
                fs.mkdir(folder)
            except FileExistsError:
                pass
        self.agent = None
        self.lock = asyncio.Lock()
        self.leases = {}

    def load(self, path, default):
        try:
            return json.loads(self.fs.read(path))
        except FileNotFoundError:
            return default

    def store(self, path, value):
        self.fs.write(path, json.dumps(value).encode())

    def profiles(self):
        original = self.load(self.config + "/ssh-hosts.json", [])
        normalized = [profile(v) for v in original]
        if original != normalized:
            self.store(self.config + "/ssh-hosts.json", normalized)
        return normalized

    def selected_profile(self, b):
        profiles = self.profiles()
        which = b.get("profile", 0)
        if isinstance(which, int):
            return profiles[which]
        return next(p for p in profiles if p["id"] == which)

    def keyfs(self):
        # Descriptor-relative beneath HOME including .ssh; do not traverse a replaced symlink.
        try:
            os.mkdir(".ssh", 0o700, dir_fd=self.fs.root)
        except FileExistsError:
            pass
        fd = beneath(self.fs.root, ".ssh", os.O_RDONLY | os.O_DIRECTORY)
        st = os.fstat(fd)
        if st.st_uid != os.getuid() or st.st_mode & 0o077:
            os.close(fd)
            raise ValueError("~/.ssh must be owned by you with mode0700")
        result = object.__new__(HomeFS)
        result.root = fd
        return result

    async def agent_env(self):
        async with self.lock:
            return await self._agent_env()

    async def _agent_env(self):
        sock = self.runtime / "agent.sock"
        if self.agent is None or self.agent.returncode is not None:
            sock.unlink(missing_ok=True)
            self.agent = await asyncio.create_subprocess_exec(
                "/usr/bin/ssh-agent",
                "-D",
                "-a",
                str(sock),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            for _ in range(40):
                if sock.exists():
                    break
                await asyncio.sleep(0.05)
        return {**os.environ, "SSH_AUTH_SOCK": str(sock)}

    async def unlock(self, b):
        name = str(b.get("key", ""))
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", name):
            raise ValueError("Invalid key name")
        seconds = int(b.get("seconds", 3600))
        if not 60 <= seconds <= 28800:
            raise ValueError("Unlock lifetime must be 1 minute to 8 hours")
        keyfs = self.keyfs()
        try:
            fd = keyfs.open(name, os.O_RDONLY | os.O_NONBLOCK)
            st = os.fstat(fd)
            if (
                not stat.S_ISREG(st.st_mode)
                or st.st_nlink != 1
                or st.st_uid != os.getuid()
                or st.st_mode & 0o077
                or st.st_size > 65536
            ):
                os.close(fd)
                raise ValueError(
                    "Private key must be a private regular file (mode0600)"
                )
        finally:
            keyfs.close()
        secret = str(b.pop("passphrase", "")).encode()
        if len(secret) > 4096:
            os.close(fd)
            raise ValueError("Passphrase too long")
        path = self.runtime / ("askpass-" + secrets.token_hex(12) + ".sock")
        token = secrets.token_bytes(32)

        async def answer(reader, writer):
            try:
                peer = writer.get_extra_info("socket").getsockopt(
                    socket.SOL_SOCKET, socket.SO_PEERCRED, 12
                )
                if struct.unpack("3i", peer)[1] != os.getuid():
                    return
                if await asyncio.wait_for(reader.readexactly(32), 2) != token:
                    return
                writer.write(secret + b"\n")
                await writer.drain()
            except (OSError, asyncio.IncompleteReadError, TimeoutError):
                pass
            finally:
                writer.close()

        server = await asyncio.start_unix_server(answer, str(path))
        os.chmod(path, 0o600)
        env = await self.agent_env()
        env.update(
            SSH_ASKPASS=str(ROOT / "scripts/ssh-askpass.py"),
            SSH_ASKPASS_REQUIRE="force",
            DISPLAY="neon",
            NEON_ASKPASS_SOCKET=str(path),
            NEON_ASKPASS_TOKEN=token.hex(),
        )
        try:
            proc = await asyncio.create_subprocess_exec(
                "/usr/bin/ssh-add",
                "-t",
                str(seconds),
                f"/proc/self/fd/{fd}",
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                pass_fds=(fd,),
                start_new_session=True,
            )
            try:
                code = await asyncio.wait_for(proc.wait(), 20)
            except TimeoutError:
                proc.kill()
                await proc.wait()
                raise ValueError("Key unlock timed out")
            if code:
                raise ValueError(
                    "Unable to unlock this key; check the key and passphrase"
                )
            return {"ok": True, "seconds": seconds}
        finally:
            secret = b""
            token = b""
            server.close()
            await server.wait_closed()
            path.unlink(missing_ok=True)
            os.close(fd)

    def history_config(self):
        return self.load(
            self.config + "/history.json",
            {
                "enabled": True,
                "exclude": [".env*", "*.pem", "*.key", "*secret*", "*credential*"],
                "versions": 10,
            },
        )

    def history(self, path, data):
        cfg = self.history_config()
        path = clean(path)
        if (
            not cfg["enabled"]
            or path.startswith((".config/", ".local/"))
            or any(
                fnmatch.fnmatch(path, p) or fnmatch.fnmatch(Path(path).name, p)
                for p in cfg["exclude"]
            )
        ):
            return
        if len(data) > 4 * 1024**2:
            return
        index = self.load(self.data + "/history/index.json", [])
        id = uuid.uuid4().hex
        self.fs.write(self.data + "/history/" + id, data, exclusive=True)
        index.append(
            {
                "id": id,
                "path": path,
                "time": time.time(),
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
        while (
            sum(x["size"] for x in index) > 64 * 1024**2
            or sum(x["path"] == path for x in index) > cfg["versions"]
        ):
            victim = (
                next((x for x in index if x["path"] == path), index[0])
                if sum(x["path"] == path for x in index) > cfg["versions"]
                else index[0]
            )
            self.fs.remove(self.data + "/history/" + victim["id"])
            index.remove(victim)
        self.store(self.data + "/history/index.json", index)

    async def dispatch(self, b):
        action = b["action"]
        if action.startswith("jobs."):
            folder = self.data + "/jobs/"
            if action == "jobs.prepare":
                command = str(b.get("command", ""))
                if len(command) > 8192:
                    raise ValueError("Command too long")
                argv = shlex.split(command)
                if not argv or len(argv) > 128:
                    raise ValueError("Enter a command")
                cwd = clean(b.get("cwd", "."))
                fd = self.fs.open(cwd, os.O_RDONLY | os.O_DIRECTORY)
                os.close(fd)
                if (
                    len(
                        [
                            f
                            for f in self.fs.list(folder.rstrip("/"))
                            if f["name"].endswith(".json")
                        ]
                    )
                    >= 100
                ):
                    raise ValueError("Remove old jobs before creating more")
                job = uuid.uuid4().hex
                spec = {
                    "id": job,
                    "name": str(b.get("name") or argv[0])[:80],
                    "argv": argv,
                    "cwd": cwd,
                    "created": time.time(),
                    "memoryMiB": int(b.get("memoryMiB", 512)),
                }
                if not 128 <= spec["memoryMiB"] <= 2048:
                    raise ValueError("Choose 128 to2048MiB")
                admit(self.account.pw_dir, spec["memoryMiB"] * 1024**2)
                self.store(folder + job + ".json", spec)
                return spec
            if action == "jobs.list":
                jobs = []
                for f in self.fs.list(folder.rstrip("/")):
                    if not re.fullmatch(r"[a-f0-9]{32}\.json", f["name"]):
                        continue
                    spec = self.load(folder + f["name"], {})
                    result = self.load(
                        folder + spec["id"] + ".result", {"status": "queued"}
                    )
                    jobs.append({**spec, **result})
                return {"jobs": sorted(jobs, key=lambda j: j["created"], reverse=True)}
            job = b.get("id", "")
            if not re.fullmatch(r"[a-f0-9]{32}", job):
                raise ValueError("Invalid job ID")
            if action == "jobs.log":
                try:
                    log = self.fs.read(folder + job + ".log").decode(
                        "utf8", errors="replace"
                    )
                except FileNotFoundError:
                    log = "No output yet"
                return {"log": log}
            if action == "jobs.delete":
                for suffix in (".json", ".result", ".log"):
                    try:
                        self.fs.remove(folder + job + suffix)
                    except FileNotFoundError:
                        pass
                return {"ok": True}
            return None
        if action == "resources.info":
            return resources(self.account.pw_dir)
        if action == "ssh.list":
            return {"hosts": self.profiles()}
        if action == "ssh.save":
            hosts = b["hosts"]
            if not isinstance(hosts, list) or len(hosts) > 100:
                raise ValueError("Maximum100 profiles")
            hosts = [profile(h) for h in hosts]
            if len({h["id"] for h in hosts}) != len(hosts):
                raise ValueError("Duplicate profile ID")
            self.store(self.config + "/ssh-hosts.json", hosts)
            return {"ok": True}
        if action == "ssh.import":
            name = str(b.get("name", ""))
            if not re.fullmatch(r"neon_[a-zA-Z0-9_-]{1,60}", name):
                raise ValueError(
                    "Key name must begin neon_ and contain letters, numbers, _ or -"
                )
            raw = str(b.pop("data", "")).encode()
            if len(raw) > 65536 or not raw.startswith(
                b"-----BEGIN OPENSSH PRIVATE KEY-----"
            ):
                raise ValueError("Import an encrypted OpenSSH private key")
            decoded = base64.b64decode(b"".join(raw.splitlines()[1:-1]), validate=True)
            if not decoded.startswith(b"openssh-key-v1\0"):
                raise ValueError("Unsupported key format")
            offset = 15

            def readstr():
                nonlocal offset
                if offset + 4 > len(decoded):
                    raise ValueError("Invalid key")
                length = struct.unpack(">I", decoded[offset : offset + 4])[0]
                offset += 4
                value = decoded[offset : offset + length]
                offset += length
                if len(value) != length:
                    raise ValueError("Invalid key")
                return value

            cipher = readstr()
            readstr()
            readstr()
            if cipher == b"none":
                raise ValueError("Import a passphrase-encrypted private key")
            if decoded[offset : offset + 4] != b"\0\0\0\1":
                raise ValueError("Expected one private key")
            offset += 4
            public = readstr()
            length = struct.unpack(">I", public[:4])[0]
            kind = public[4 : 4 + length].decode("ascii")
            if kind not in (
                "ssh-ed25519",
                "ssh-rsa",
                "ecdsa-sha2-nistp256",
                "ecdsa-sha2-nistp384",
                "ecdsa-sha2-nistp521",
            ):
                raise ValueError("Unsupported key algorithm")
            pub = kind + " " + base64.b64encode(public).decode() + " " + name + "\n"
            keys = self.keyfs()
            try:
                keys.write(name, raw, exclusive=True)
                try:
                    keys.write(name + ".pub", pub.encode(), exclusive=True)
                except Exception:
                    keys.remove(name)
                    raise
            finally:
                keys.close()
            return {"ok": True, "publicKey": pub}
        if action == "ssh.public":
            name = str(b.get("key", ""))
            if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", name):
                raise ValueError("Invalid key")
            keys = self.keyfs()
            try:
                return {"publicKey": keys.read(name + ".pub").decode()}
            finally:
                keys.close()
        if action == "session.rename":
            id = str(b["id"])
            if not re.fullmatch(r"(?:g[a-f0-9]{1,16}_)?[a-f0-9]{32}", id):
                raise ValueError("Invalid terminal ID")
            labels = self.load(self.config + "/session-names.json", {})
            labels[id] = str(b["name"])[:80]
            self.store(self.config + "/session-names.json", labels)
            return {"ok": True}
        if action == "session.names":
            return self.load(self.config + "/session-names.json", {})
        if action == "ssh.keys":
            keyfs = self.keyfs()
            try:
                keys = [
                    e["name"]
                    for e in keyfs.list()
                    if not e["directory"]
                    and not e["symlink"]
                    and e["name"] not in ("config", "known_hosts", "authorized_keys")
                    and not e["name"].endswith(".pub")
                    and e["size"] < 65536
                ]
            finally:
                keyfs.close()
            env = await self.agent_env()
            p = await asyncio.create_subprocess_exec(
                "/usr/bin/ssh-add",
                "-l",
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await p.communicate()
            return {
                "keys": keys,
                "unlocked": out.decode()[:4000] if p.returncode == 0 else "",
            }
        if action == "ssh.unlock":
            return await self.unlock(b)
        if action == "ssh.lock":
            p = await asyncio.create_subprocess_exec(
                "/usr/bin/ssh-add",
                "-D",
                env=await self.agent_env(),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await p.wait()
            return {"ok": True}
        if action.startswith("history."):
            if action == "history.settings":
                if "value" in b:
                    value = b["value"]
                    exclude = value.get("exclude", [])
                    if (
                        not isinstance(exclude, list)
                        or len(exclude) > 50
                        or any(not isinstance(v, str) or len(v) > 200 for v in exclude)
                    ):
                        raise ValueError("Invalid exclusions")
                    self.store(
                        self.config + "/history.json",
                        {
                            "enabled": bool(value.get("enabled", True)),
                            "exclude": exclude,
                            "versions": max(1, min(20, int(value.get("versions", 10)))),
                        },
                    )
                return self.history_config()
            index = self.load(self.data + "/history/index.json", [])
            if action == "history.list":
                return {
                    "versions": [
                        x for x in reversed(index) if x["path"] == clean(b["path"])
                    ]
                }
            entry = next(
                x
                for x in index
                if x["id"] == b.get("id") and x["path"] == clean(b["path"])
            )
            data = self.fs.read(self.data + "/history/" + entry["id"])
            if action == "history.read":
                return {"data": base64.b64encode(data).decode(), "version": entry}
            if action == "history.restore":
                lease = self.leases.get(entry["path"])
                if (
                    lease
                    and lease["until"] > time.monotonic()
                    and b.get("client") != lease["client"]
                ):
                    raise ValueError("Another view is editing this file")
                current = self.fs.read(entry["path"])
                self.history(entry["path"], current)
                self.fs.write(entry["path"], data, expected=b["expected"])
                return {"ok": True, "revision": hashlib.sha256(data).hexdigest()}
        if action in ("config.get", "config.save"):
            desktop = DesktopState(self.fs)
            if action == "config.get":
                return desktop.get(b.get("device"))
            return desktop.save(b.get("device"), b["value"], b.get("windowChanges"))
        if action == "document.lease":
            path = clean(b["path"])
            client = str(b["client"])
            now = time.monotonic()
            if not re.fullmatch(r"[a-f0-9-]{36}", client):
                raise ValueError("Invalid view identity")
            current = self.leases.get(path)
            if b.get("release"):
                if current and current["client"] == client:
                    self.leases.pop(path, None)
                return {"ok": True}
            if (
                current
                and current["until"] > now
                and current["client"] != client
                and not b.get("takeover")
            ):
                return {"acquired": False, "device": current["device"]}
            self.leases[path] = {
                "client": client,
                "device": str(b.get("name", "Another view"))[:80],
                "until": now + 45,
            }
            return {"acquired": True}
        return None
