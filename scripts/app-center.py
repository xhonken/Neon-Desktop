#!/usr/bin/env python3
"""Administrator app/catalog management. Git runs as the unprivileged gateway account."""

import argparse, asyncio, json, os, pathlib, pwd, stat, subprocess, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from neon.app_packages import (
    AppStore,
    CATALOG,
    SYSTEM_ROOT,
    catalog,
    fetch_bundle,
    fetch_files,
    git_source,
    load_catalog,
)
from neon.fs import HomeFS


def unprivileged_fetch(value, catalog_only=False):
    account = pwd.getpwnam("neon-gateway")
    with tempfile.TemporaryDirectory(prefix="neon-app-fetch-") as temp:
        path = pathlib.Path(temp)
        os.chown(path, 0, account.pw_gid)
        path.chmod(0o770)
        out = path / "result.json"
        subprocess.run(
            [
                "runuser",
                "-u",
                account.pw_name,
                "--",
                "/usr/bin/python3",
                str(pathlib.Path(__file__).resolve()),
                "fetch-internal",
                str(out),
            ],
            input=json.dumps({"value": value, "catalog": catalog_only}),
            text=True,
            check=True,
            timeout=95,
        )
        fd = os.open(out, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_size > 24 * 1024**2
            ):
                raise ValueError("Invalid fetch result")
            with os.fdopen(fd, "rb", closefd=False) as f:
                return json.loads(f.read(24 * 1024**2 + 1))
        finally:
            os.close(fd)


def save_catalog(value):
    value = catalog(value)
    CATALOG.parent.mkdir(mode=0o755, exist_ok=True)
    temp = CATALOG.with_name(".catalog-" + os.urandom(8).hex())
    try:
        with temp.open("x") as f:
            json.dump(value, f, indent=2)
            f.write("\n")
        temp.chmod(0o644)
        os.replace(temp, CATALOG)
    finally:
        temp.unlink(missing_ok=True)
    print(
        "Catalog activated:", len(value["apps"]), "apps. Users can refresh App Center."
    )


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "fetch-internal":
        if os.geteuid() == 0:
            raise SystemExit("Fetch must be unprivileged")
        value = json.loads(sys.stdin.read(1024**2))

        async def fetch():
            if value["catalog"]:
                source = git_source(value["value"])
                files = await fetch_files(source, True)
                return catalog(json.loads(files[source["path"]]))
            return await fetch_bundle(value["value"])

        result = asyncio.run(fetch())
        with open(sys.argv[2], "x") as f:
            json.dump(result, f)
        return
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="action", required=True)
    sub.add_parser("list")
    for name in ("install", "remove"):
        sub.add_parser(name).add_argument("id")
    c = sub.add_parser("catalog")
    cs = c.add_subparsers(dest="catalog_action", required=True)
    cs.add_parser("import").add_argument("file", type=pathlib.Path)
    sync = cs.add_parser("sync")
    sync.add_argument("repository")
    sync.add_argument("--commit", required=True)
    sync.add_argument("--path", default="catalog.json")
    args = p.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Use sudo from an administrative SSH session")
    if args.action == "catalog":
        if args.catalog_action == "import":
            if args.file.stat().st_size > 1024**2:
                raise ValueError("Catalog too large")
            value = json.loads(args.file.read_text())
        else:
            value = unprivileged_fetch(vars(args), True)
        save_catalog(value)
        return
    SYSTEM_ROOT.mkdir(mode=0o755, exist_ok=True)
    fs = HomeFS(str(SYSTEM_ROOT))
    store = AppStore(fs, "system", "system")
    try:
        if args.action == "list":
            print(json.dumps(store.manifests(), indent=2))
            return
        old = store.registry().get(args.id)
        if args.action == "remove":
            if not old:
                raise ValueError("System app not installed")
            store.remove(args.id, old["package"])
            print("Removed system app; per-user documents/data remain")
            return
        entry = next((e for e in load_catalog()["apps"] if e["id"] == args.id), None)
        if not entry or entry["installation"] != "system":
            raise ValueError("Choose an administrator-installed app from the catalog")
        bundle = unprivileged_fetch(entry)
        missing = []
        for package in bundle["manifest"].get("systemDependencies", []):
            # Package names are validated before any subprocess use.
            from neon.app_packages import validate_bundle

            validate_bundle(bundle, entry)
            result = subprocess.run(
                ["dpkg-query", "-W", "-f=${db:Status-Status}", package],
                capture_output=True,
                text=True,
            )
            if result.returncode or result.stdout != "installed":
                missing.append(package)
        if missing:
            raise ValueError(
                "Install reviewed system dependencies first: sudo apt-get install "
                + " ".join(missing)
            )
        store.install(entry, bundle, old["package"] if old else None)
        print("Installed for all users:", entry["id"], entry["version"])
        print(
            "App execution and data access use each signed-in user. Refresh App Center; no worker restart is needed."
        )
    finally:
        fs.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as e:
        raise SystemExit(str(e))
