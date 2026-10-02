import os, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from neon.fs import HomeFS
from neon.workbench import Workbench, profile, ssh_argv


class WorkbenchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fs = HomeFS(self.tmp.name)
        self.w = Workbench(
            self.fs, SimpleNamespace(pw_dir=self.tmp.name), self.tmp.name
        )

    def tearDown(self):
        self.fs.close()
        self.tmp.cleanup()

    async def test_profiles_migrate_stable_id_and_reject_secrets(self):
        p = {"name": "Server", "host": "example.test", "username": "developer"}
        await self.w.dispatch({"action": "ssh.save", "hosts": [p]})
        self.assertEqual(self.w.profiles()[0]["id"], self.w.profiles()[0]["id"])
        for secret in ("password", "passphrase", "privateKey"):
            with self.assertRaises(ValueError):
                profile({**p, secret: "not-stored"})
        self.assertNotIn(
            "not-stored", self.fs.read(".config/neon-desktop/ssh-hosts.json").decode()
        )

    async def test_ssh_argument_boundaries(self):
        p = profile(
            {
                "name": "Test",
                "host": "example.test",
                "username": "developer",
                "persistent": True,
                "session": "build_1",
                "auth": "key",
                "key": "neon_server",
            }
        )
        argv = ssh_argv(p, self.tmp.name)
        self.assertIn("StrictHostKeyChecking=ask", argv)
        self.assertIn("ForwardAgent=no", argv)
        self.assertEqual(argv[-5:], ["tmux", "new-session", "-A", "-s", "build_1"])
        for field, bad in [
            ("host", "-oProxyCommand=id"),
            ("session", "ok; touch hacked"),
            ("key", "../secret"),
            ("username", "user -o x"),
        ]:
            with self.assertRaises(ValueError):
                profile({**p, field: bad})

    async def test_history_exclusions_restore_and_bound(self):
        self.fs.write("file.py", b"one")
        for n in range(12):
            self.w.history("file.py", str(n).encode())
        versions = (
            await self.w.dispatch({"action": "history.list", "path": "file.py"})
        )["versions"]
        self.assertEqual(len(versions), 10)
        self.w.history(".env", b"secret")
        self.assertEqual(
            (await self.w.dispatch({"action": "history.list", "path": ".env"}))[
                "versions"
            ],
            [],
        )
        import hashlib

        await self.w.dispatch(
            {
                "action": "history.restore",
                "path": "file.py",
                "id": versions[0]["id"],
                "expected": hashlib.sha256(b"one").hexdigest(),
            }
        )
        self.assertEqual(self.fs.read("file.py"), b"11")
        self.assertEqual(
            os.stat(
                self.root / ".local/share/neon-desktop/history" / versions[0]["id"]
            ).st_mode
            & 0o777,
            0o600,
        )

    async def test_device_layouts_and_editing_lease(self):
        a = "a" * 8 + "-" + "a" * 4 + "-" + "a" * 4 + "-" + "a" * 4 + "-" + "a" * 12
        b = a.replace("a", "b")
        await self.w.dispatch(
            {"action": "config.save", "device": a, "value": {"windows": [1]}}
        )
        await self.w.dispatch(
            {"action": "config.save", "device": b, "value": {"windows": [2]}}
        )
        self.assertEqual(
            (await self.w.dispatch({"action": "config.get", "device": a}))["windows"],
            [1],
        )
        self.assertTrue(
            (
                await self.w.dispatch(
                    {"action": "document.lease", "client": a, "path": "file.py"}
                )
            )["acquired"]
        )
        self.assertFalse(
            (
                await self.w.dispatch(
                    {"action": "document.lease", "client": b, "path": "file.py"}
                )
            )["acquired"]
        )
        self.assertTrue(
            (
                await self.w.dispatch(
                    {
                        "action": "document.lease",
                        "client": b,
                        "path": "file.py",
                        "takeover": True,
                    }
                )
            )["acquired"]
        )

    async def test_import_rejects_plaintext_and_traversal(self):
        for name in ("../x", "id_ed25519", "neon_x/../x"):
            with self.assertRaises(ValueError):
                await self.w.dispatch(
                    {"action": "ssh.import", "name": name, "data": "invalid"}
                )

    async def test_alias_paths_share_editing_lease(self):
        from neon.fs import clean

        self.assertEqual(clean("./project/./file.py"), "project/file.py")
        a = "a1111111-1111-1111-1111-111111111111"
        b = "b1111111-1111-1111-1111-111111111111"
        self.assertTrue(
            (
                await self.w.dispatch(
                    {"action": "document.lease", "client": a, "path": "./file.py"}
                )
            )["acquired"]
        )
        self.assertFalse(
            (
                await self.w.dispatch(
                    {"action": "document.lease", "client": b, "path": "file.py"}
                )
            )["acquired"]
        )

    async def test_admission_refuses_low_ram_and_disk(self):
        from unittest.mock import patch
        from neon.workbench import admit

        for free_ram, free_disk in (
            (512 * 1024**2, 10 * 1024**3),
            (4 * 1024**3, 128 * 1024**2),
        ):
            with patch(
                "neon.workbench.resources",
                return_value={"memoryAvailable": free_ram, "diskAvailable": free_disk},
            ):
                with self.assertRaises(ValueError):
                    admit(self.tmp.name)
