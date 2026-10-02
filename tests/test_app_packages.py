import base64, tempfile, unittest
from pathlib import Path
from neon.app_packages import AppStore, catalog, git_source, validate_bundle
from neon.fs import HomeFS


def entry(scope="user", version="1.0.0"):
    return {
        "id": "org.example.fixture",
        "name": "Fixture",
        "description": "Test app",
        "version": version,
        "category": "utilities",
        "installation": scope,
        "repository": "https://example.org/apps.git",
        "commit": "a" * 40,
        "path": "neon-app",
    }


def bundle(scope="user", version="1.0.0"):
    return {
        "manifest": {
            "id": "org.example.fixture",
            "name": "Fixture",
            "version": version,
            "runtime": "sandbox",
            "installation": scope,
            "permissions": ["notifications"],
            "window": {},
        },
        "files": {
            "frontend/index.html": base64.b64encode(b"<h1>Fixture</h1>").decode()
        },
    }


class Packages(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fs = HomeFS(self.tmp.name)
        self.store = AppStore(self.fs)

    def tearDown(self):
        self.fs.close()
        self.tmp.cleanup()

    def test_catalog_identity_and_transport_validation(self):
        c = catalog({"schema": 1, "apps": [entry()]})
        self.assertEqual(c["apps"][0]["commit"], "a" * 40)
        for change in [
            {"repository": "file:///etc"},
            {"repository": "https://name:password@example.org/repo"},
            {"repository": "ext::run"},
            {"commit": "main"},
            {"path": "../secret"},
        ]:
            with self.assertRaises(ValueError):
                git_source({**entry(), **change})
        for bad in ["org.neon.terminal", "../outside", "bad/name"]:
            with self.assertRaises(ValueError):
                catalog({"schema": 1, "apps": [{**entry(), "id": bad}]})
        with self.assertRaises(ValueError):
            catalog({"schema": 1, "apps": [entry(), entry()]})

    def test_package_cannot_escalate_or_install_backend(self):
        for change in [
            {"runtime": "core"},
            {"permissions": ["terminal"]},
            {"installation": "system"},
            {"systemDependencies": ["git"]},
        ]:
            b = bundle()
            b["manifest"].update(change)
            with self.assertRaises(ValueError):
                validate_bundle(b, entry())
        for name in [
            "install.sh",
            "backend/app.py",
            "frontend/../../bad",
            "frontend/.hidden",
        ]:
            b = bundle()
            b["files"][name] = "YQ=="
            with self.assertRaises(ValueError):
                validate_bundle(b, entry())
        b = bundle()
        b["manifest"]["version"] = "wrong"
        with self.assertRaises(ValueError):
            validate_bundle(b, entry())

    def test_atomic_update_revision_asset_invalidation_and_uninstall(self):
        a = self.store.install(entry(), bundle())
        self.assertEqual(len(self.store.manifests()), 1)
        self.assertEqual(
            self.store.asset(entry()["id"], a["revision"], "index.html")["data"],
            bundle()["files"]["frontend/index.html"],
        )
        self.fs.write("user-document.txt", b"keep")
        with self.assertRaises(ValueError):
            self.store.install(entry(version="2"), bundle(version="2"), "stale")
        self.assertEqual(self.store.registry()[entry()["id"]]["package"], a["revision"])
        b = self.store.install(entry(version="2"), bundle(version="2"), a["revision"])
        with self.assertRaises(FileNotFoundError):
            self.store.asset(entry()["id"], a["revision"], "index.html")
        self.assertFalse(
            (self.root / self.store.base / "packages" / a["revision"]).exists()
        )
        self.store.remove(entry()["id"], b["revision"])
        self.assertEqual(self.store.manifests(), [])
        self.assertEqual(self.fs.read("user-document.txt"), b"keep")

    def test_private_modes_and_symlink_swap(self):
        installed = self.store.install(entry(), bundle())
        path = (
            self.root
            / self.store.base
            / "packages"
            / installed["revision"]
            / "frontend/index.html"
        )
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        path.unlink()
        path.symlink_to("/etc/passwd")
        with self.assertRaises(OSError):
            self.store.asset(entry()["id"], installed["revision"], "index.html")
        with self.assertRaises(ValueError):
            self.store.asset(entry()["id"], installed["revision"], "../manifest.json")

    def test_failed_package_does_not_replace_installed_version(self):
        first = self.store.install(entry(), bundle())
        broken = bundle(version="2")
        broken["files"]["frontend/index.html"] = "invalid"
        with self.assertRaises(ValueError):
            self.store.install(entry(version="2"), broken, first["revision"])
        self.assertEqual(
            self.store.registry()[entry()["id"]]["package"], first["revision"]
        )

    def test_global_installation_has_same_unprivileged_runtime(self):
        globalstore = AppStore(self.fs, "global", "system")
        globalstore.install(entry("system"), bundle("system"))
        m = globalstore.manifests()[0]
        self.assertEqual(m["scope"], "system")
        self.assertEqual(m["runtime"], "sandbox")
        b = bundle("system")
        b["manifest"]["systemDependencies"] = ["git; id"]
        with self.assertRaises(ValueError):
            validate_bundle(b, entry("system"))
