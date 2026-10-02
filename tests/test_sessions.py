import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
from aiohttp import web
from neon.broker import Sessions, eligible


class SessionsTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.s = Sessions(Path(self.t.name) / "s.db")
        self.principal = patch("neon.broker.principal", return_value="test-account")
        self.principal.start()
        self.credentials = patch("neon.broker.credential_version", return_value="credential-v1")
        self.credentials.start()
        self.addCleanup(self.credentials.stop)
        self.addCleanup(self.principal.stop)

    def tearDown(self):
        self.s.db.close()
        self.t.cleanup()

    def test_root_cannot_log_in(self):
        with self.assertRaises(ValueError):
            eligible("root")

    def test_token_storage_and_expiry(self):
        token, csrf = self.s.issue(1000, "test")
        self.assertNotIn(
            token, str(self.s.db.execute("SELECT * FROM sessions").fetchall())
        )
        with (
            patch("neon.broker.eligible", return_value=SimpleNamespace(pw_name="test")),
            patch(
                "neon.broker.pwd.getpwuid", return_value=SimpleNamespace(pw_name="test")
            ),
        ):
            self.assertEqual(self.s.get(token)["uid"], 1000)
        self.s.db.execute("UPDATE sessions SET touched=0")
        self.s.db.commit()
        with self.assertRaises(web.HTTPUnauthorized):
            self.s.get(token)

    def test_reused_uid_invalidates_old_session(self):
        token, _ = self.s.issue(1000, "test")
        with (
            patch("neon.broker.principal", return_value="new-account"),
            patch("neon.broker.eligible", return_value=SimpleNamespace(pw_name="test")),
            patch(
                "neon.broker.pwd.getpwuid", return_value=SimpleNamespace(pw_name="test")
            ),
        ):
            with self.assertRaises(web.HTTPUnauthorized):
                self.s.get(token)

    def test_password_change_invalidates_existing_session(self):
        token, _ = self.s.issue(1000, "test")
        with patch("neon.broker.credential_version", return_value="credential-v2"), patch("neon.broker.eligible", return_value=SimpleNamespace(pw_name="test")):
            with self.assertRaises(web.HTTPUnauthorized):
                self.s.get(token)
            new_token, _ = self.s.issue(1000, "test")
            self.assertEqual(self.s.get(new_token)["uid"], 1000)

    def test_locked_account_invalidates_session(self):
        token, _ = self.s.issue(1000, "test")
        with patch("neon.broker.credential_version", side_effect=ValueError("locked")), patch("neon.broker.eligible", return_value=SimpleNamespace(pw_name="test")):
            with self.assertRaises(web.HTTPUnauthorized):
                self.s.get(token)

    def test_invalid_token(self):
        with self.assertRaises(web.HTTPUnauthorized):
            self.s.get("invalid")


if __name__ == "__main__":
    unittest.main()
