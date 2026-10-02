"""Validated Git packages and per-user app storage. No repository code is executed."""

import asyncio, base64, hashlib, json, os, re, signal, sys, tempfile, time, uuid
from pathlib import Path
from urllib.parse import urlsplit
from .fs import clean

SYSTEM_ROOT = Path("/var/lib/neon-apps")
CATALOG = Path("/etc/neon-desktop/catalog.json")
APP_BASE = ".local/share/neon-desktop/apps"
MAX_PACKAGE = 16 * 1024**2
MAX_FILE = 2 * 1024**2
PERMISSIONS = {"user-files", "notifications"}
ID = r"[a-z][a-z0-9.-]{2,100}"
ROOT = Path(__file__).resolve().parents[1]


def app_id(value):
    if (
        not isinstance(value, str)
        or not re.fullmatch(ID, value)
        or value.startswith("org.neon.")
    ):
        raise ValueError("Invalid or reserved app ID")
    return value


def text(value, maximum=200):
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > maximum
        or any(ord(c) < 32 for c in value)
    ):
        raise ValueError("Invalid text field")
    return value


def relative(value):
    value = clean(value)
    if (
        value == "."
        or any(p.startswith(".") for p in value.split("/"))
        or len(value) > 240
        or len(value.split("/")) > 16
    ):
        raise ValueError("Invalid package path")
    return value


def git_source(value):
    url = text(value["repository"], 500)
    u = urlsplit(url)
    if (
        u.scheme != "https"
        or not u.hostname
        or u.username
        or u.password
        or u.query
        or u.fragment
        or not u.path
        or not re.fullmatch(r"[a-zA-Z0-9./_:-]+", url)
    ):
        raise ValueError("Use a public HTTPS Git repository without credentials")
    if not isinstance(value.get("commit"), str) or not re.fullmatch(
        r"[a-f0-9]{40}", value["commit"]
    ):
        raise ValueError("Use a full 40-character Git commit")
    return {
        "repository": url,
        "commit": value["commit"],
        "path": relative(value.get("path", "neon-app")),
    }


def manifest(value, scope=None):
    if not isinstance(value, dict) or value.get("runtime") != "sandbox":
        raise ValueError("Only isolated frontend app packages are supported")
    permissions = value.get("permissions", [])
    if (
        not isinstance(permissions, list)
        or any(not isinstance(p, str) for p in permissions)
        or not set(permissions) <= PERMISSIONS
    ):
        raise ValueError("Unsupported app permission")
    installation = value.get("installation", "user")
    if installation not in ("user", "system") or (scope and installation != scope):
        raise ValueError("Package installation scope does not match its catalog entry")
    dependencies = value.get("systemDependencies", [])
    if (
        not isinstance(dependencies, list)
        or len(dependencies) > 30
        or any(
            not isinstance(d, str) or not re.fullmatch(r"[a-z0-9][a-z0-9+.-]{0,80}", d)
            for d in dependencies
        )
    ):
        raise ValueError("Invalid system dependency list")
    if dependencies and installation != "system":
        raise ValueError("System dependencies require an administrator-installed app")
    window = value.get("window", {})
    if not isinstance(window, dict):
        raise ValueError("Invalid window definition")
    dimensions = {}
    for name, default in [
        ("width", 800),
        ("height", 600),
        ("minWidth", 350),
        ("minHeight", 250),
    ]:
        n = window.get(name, default)
        if type(n) is not int or not 180 <= n <= 4000:
            raise ValueError("Invalid window dimensions")
        dimensions[name] = n
    return {
        "id": app_id(value.get("id")),
        "name": text(value.get("name"), 80),
        "version": text(value.get("version"), 50),
        "description": text(value.get("description", value.get("name")), 500),
        "category": text(value.get("category", "utilities"), 50),
        "runtime": "sandbox",
        "installation": installation,
        "permissions": sorted(set(permissions)),
        "systemDependencies": sorted(set(dependencies)),
        "pinnable": bool(value.get("pinnable", True)),
        "icon": text(value.get("icon", "◇"), 8),
        "window": {**dimensions, "resizable": True},
    }


def catalog(value):
    if (
        not isinstance(value, dict)
        or value.get("schema") != 1
        or not isinstance(value.get("apps"), list)
        or len(value["apps"]) > 500
    ):
        raise ValueError("Expected catalog schema 1 with up to 500 apps")
    entries, ids = [], set()
    for item in value["apps"]:
        ident = app_id(item.get("id"))
        if ident in ids:
            raise ValueError("Duplicate catalog app")
        ids.add(ident)
        scope = item.get("installation", "user")
        if scope not in ("user", "system"):
            raise ValueError("Invalid installation scope")
        entries.append(
            {
                "id": ident,
                "name": text(item.get("name"), 80),
                "description": text(item.get("description", item.get("name")), 500),
                "version": text(item.get("version"), 50),
                "installation": scope,
                "category": text(item.get("category", "utilities"), 50),
                **git_source(item),
            }
        )
    return {
        "schema": 1,
        "name": text(value.get("name", "Neon app catalog"), 100),
        "apps": entries,
    }


def load_catalog():
    try:
        if CATALOG.stat().st_size > 1024**2:
            raise ValueError("Catalog too large")
        return catalog(json.loads(CATALOG.read_text()))
    except FileNotFoundError:
        return {"schema": 1, "name": "Neon app catalog", "apps": []}


def validate_bundle(bundle, entry):
    m = manifest(bundle["manifest"], entry["installation"])
    if m["id"] != entry["id"] or m["version"] != entry["version"]:
        raise ValueError("Package identity/version does not match the catalog")
    files = bundle.get("files", {})
    if (
        not isinstance(files, dict)
        or not 1 <= len(files) <= 1000
        or "frontend/index.html" not in files
    ):
        raise ValueError("Package must contain frontend/index.html")
    total, digest = 0, hashlib.sha256(json.dumps(m, sort_keys=True).encode())
    decoded = {}
    for path, encoded in sorted(files.items()):
        if relative(path) != path or not path.startswith("frontend/"):
            raise ValueError("Only frontend files are allowed")
        data = base64.b64decode(encoded, validate=True)
        total += len(data)
        if len(data) > MAX_FILE or total > MAX_PACKAGE:
            raise ValueError("Package size limit exceeded")
        digest.update(path.encode() + b"\0" + data)
        decoded[path] = data
    return m, decoded, digest.hexdigest()


async def git_command(directory, *args, output_limit=3 * 1024**2, input_data=None):
    env = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": directory,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ALLOW_PROTOCOL": "https",
    }
    ca = Path("/etc/neon-desktop/git-ca.pem")
    if ca.exists():
        env["GIT_SSL_CAINFO"] = str(ca)
    cmd = [
        sys.executable,
        str(ROOT / "scripts/git-limited.py"),
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "http.followRedirects=false",
        "-c",
        "credential.helper=",
        "-c",
        "gc.auto=0",
        "-c",
        "fetch.fsckObjects=true",
        *args,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=directory,
        env=env,
        start_new_session=True,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        stdin=asyncio.subprocess.PIPE if input_data else asyncio.subprocess.DEVNULL,
    )
    if input_data:
        proc.stdin.write(input_data)
        await proc.stdin.drain()
        proc.stdin.close()

    async def read():
        data = bytearray()
        while chunk := await proc.stdout.read(65536):
            data.extend(chunk)
            if len(data) > output_limit:
                raise ValueError("Git output limit exceeded")
        if await proc.wait():
            raise ValueError(
                "Git fetch/read failed; check repository, commit and TLS trust"
            )
        return bytes(data)

    try:
        return await asyncio.wait_for(read(), 28)
    finally:
        # Git HTTPS helpers inherit this private process group. Clean them up on
        # timeout/cancellation too, so a stalled transport cannot outlive fetch.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()


async def fetch_files(source, single=False):
    source = git_source(source)
    with tempfile.TemporaryDirectory(prefix="neon-git-") as directory:
        await git_command(directory, "init", "--bare", "--quiet", ".")
        await git_command(
            directory,
            "fetch",
            "--quiet",
            "--depth=1",
            "--no-tags",
            "--no-recurse-submodules",
            source["repository"],
            source["commit"],
        )
        found = (
            (await git_command(directory, "rev-parse", "FETCH_HEAD^{commit}"))
            .decode()
            .strip()
        )
        if found != source["commit"]:
            raise ValueError("Fetched commit mismatch")
        listing = await git_command(
            directory, "ls-tree", "-r", "-z", "-l", found, "--", source["path"]
        )
        records = [record for record in listing.split(b"\0") if record]
        if not records or len(records) > 1001:
            raise ValueError("Missing/oversized package")
        files, total, objects = {}, 0, []
        for record in records:
            meta, rawpath = record.split(b"\t", 1)
            mode, kind, oid, size = meta.split()
            path = rawpath.decode("utf8")
            if mode not in (b"100644", b"100755") or kind != b"blob":
                raise ValueError("Symlinks and submodules are not accepted")
            size = int(size)
            total += size
            if size > MAX_FILE or total > MAX_PACKAGE:
                raise ValueError("Package size limit exceeded")
            if single:
                if path != source["path"]:
                    raise ValueError("Expected one catalog file")
                name = path
            else:
                prefix = source["path"] + "/"
                if not path.startswith(prefix):
                    raise ValueError("Invalid package directory")
                name = path[len(prefix) :]
                if name != "manifest.json" and not name.startswith("frontend/"):
                    raise ValueError(
                        "Package contains unsupported backend/install files"
                    )
                relative(name)
            objects.append((name, oid, size))
        batch = await git_command(
            directory,
            "cat-file",
            "--batch",
            input_data=b"".join(oid + b"\n" for _, oid, _ in objects),
            output_limit=MAX_PACKAGE + 128 * 1024,
        )
        offset = 0
        for name, oid, size in objects:
            header = oid + b" blob " + str(size).encode() + b"\n"
            if batch[offset : offset + len(header)] != header:
                raise ValueError("Invalid Git object stream")
            offset += len(header)
            files[name] = batch[offset : offset + size]
            offset += size
            if batch[offset : offset + 1] != b"\n":
                raise ValueError("Invalid Git object boundary")
            offset += 1
        if offset != len(batch):
            raise ValueError("Unexpected Git output")
        return files


async def fetch_bundle(entry):
    files = await fetch_files(entry)
    raw = files.pop("manifest.json", b"")
    if len(raw) > 65536:
        raise ValueError("Manifest too large")
    bundle = {
        "manifest": json.loads(raw),
        "files": {p: base64.b64encode(v).decode() for p, v in files.items()},
    }
    validate_bundle(bundle, entry)
    return bundle


class AppStore:
    def __init__(self, fs, base=APP_BASE, scope="user"):
        self.fs, self.base, self.scope = fs, base, scope
        self.pending = {}
        self.lock = asyncio.Lock()
        self.mkdir(base + "/packages")

    def mkdir(self, path):
        parts = path.split("/")
        for n in range(1, len(parts) + 1):
            try:
                self.fs.mkdir("/".join(parts[:n]))
            except FileExistsError:
                pass

    def registry(self):
        try:
            value = json.loads(self.fs.read(self.base + "/registry.json"))
        except FileNotFoundError:
            return {}
        if not isinstance(value, dict) or len(value) > 100:
            raise ValueError("Invalid app registry")
        result = {}
        for ident, record in value.items():
            m = manifest(record["manifest"], self.scope)
            if (
                ident != m["id"]
                or not re.fullmatch(r"[a-f0-9]{32}", record["package"])
                or not re.fullmatch(r"[a-f0-9]{64}", record["digest"])
            ):
                raise ValueError("Invalid installed app")
            result[ident] = {
                "manifest": m,
                "package": record["package"],
                "digest": record["digest"],
                "source": git_source(record["source"]),
                "installed": float(record.get("installed", 0)),
            }
        return result

    def save(self, registry):
        self.fs.write(self.base + "/registry.json", json.dumps(registry).encode())

    def manifests(self):
        return [
            {
                **r["manifest"],
                "scope": self.scope,
                "revision": r["package"],
                "digest": r["digest"],
                "source": r["source"],
            }
            for r in self.registry().values()
        ]

    async def prepare(self, entry):
        if entry["installation"] != self.scope:
            raise ValueError("Administrator installation required")
        self.pending = {
            t: p for t, p in self.pending.items() if p["expires"] > time.monotonic()
        }
        if len(self.pending) >= 3:
            raise ValueError("Finish or cancel pending installations first")
        bundle = await fetch_bundle(entry)
        m, files, digest = validate_bundle(bundle, entry)
        token = uuid.uuid4().hex
        self.pending[token] = {
            "entry": entry,
            "bundle": bundle,
            "expires": time.monotonic() + 300,
        }
        return {
            "token": token,
            "manifest": m,
            "digest": digest,
            "bytes": sum(map(len, files.values())),
            "source": git_source(entry),
        }

    def install(self, entry, bundle, expected=None):
        m, files, digest = validate_bundle(bundle, entry)
        registry = self.registry()
        old = registry.get(m["id"])
        if (old["package"] if old else None) != expected:
            raise ValueError("Installed app changed; refresh and review again")
        if not old and len(registry) >= 100:
            raise ValueError("Personal app limit reached")
        package = uuid.uuid4().hex
        base = self.base + "/packages/" + package
        self.mkdir(base)
        try:
            for path, data in files.items():
                self.mkdir(base + "/" + path.rsplit("/", 1)[0])
                self.fs.write(base + "/" + path, data, exclusive=True)
            self.fs.write(
                base + "/manifest.json", json.dumps(m).encode(), exclusive=True
            )
            registry[m["id"]] = {
                "manifest": m,
                "package": package,
                "digest": digest,
                "source": git_source(entry),
                "installed": time.time(),
            }
            self.save(registry)
        except Exception:
            self.remove_tree(base)
            raise
        if old:
            self.remove_tree(self.base + "/packages/" + old["package"])
        return {"ok": True, "id": m["id"], "revision": package}

    def commit(self, token, entry, expected=None):
        pending = self.pending.pop(token, None)
        if (
            not pending
            or pending["expires"] < time.monotonic()
            or pending["entry"] != entry
        ):
            raise ValueError(
                "Installation review expired or catalog changed; prepare again"
            )
        return self.install(entry, pending["bundle"], expected)

    def remove_tree(self, path, depth=0):
        if depth > 30:
            raise ValueError("Invalid package depth")
        for item in self.fs.list(path):
            child = path + "/" + item["name"]
            if item["directory"] and not item["symlink"]:
                self.remove_tree(child, depth + 1)
            else:
                self.fs.remove(child)
        self.fs.remove(path)

    def remove(self, ident, expected):
        registry = self.registry()
        old = registry.get(app_id(ident))
        if not old or old["package"] != expected:
            raise ValueError("App changed; refresh before removing")
        del registry[ident]
        self.save(registry)
        self.remove_tree(self.base + "/packages/" + old["package"])
        return {"ok": True}

    def asset(self, ident, revision, path):
        record = self.registry().get(app_id(ident))
        if not record or record["package"] != revision:
            raise FileNotFoundError("App version no longer installed")
        path = relative(path)
        data = self.fs.read(self.base + "/packages/" + revision + "/frontend/" + path)
        if len(data) > MAX_FILE:
            raise ValueError("Asset too large")
        return {"data": base64.b64encode(data).decode()}


def system_manifests():
    try:
        with open(SYSTEM_ROOT / "system/registry.json") as f:
            records = json.load(f)
    except FileNotFoundError:
        return []
    if not isinstance(records, dict) or len(records) > 100:
        raise ValueError("Invalid system app registry")
    result = []
    for ident, r in records.items():
        m = manifest(r["manifest"], "system")
        if ident != m["id"] or not re.fullmatch(r"[a-f0-9]{32}", r["package"]):
            raise ValueError("Invalid system app")
        result.append(
            {
                **m,
                "scope": "system",
                "revision": r["package"],
                "digest": r["digest"],
                "source": r["source"],
            }
        )
    return result
