import os
import tempfile
import unittest
import uuid
from pathlib import Path

from neon.desktop_state import DesktopState
from neon.fs import HomeFS


class SharedDesktopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fs = HomeFS(self.tmp.name)
        self.fs.mkdir(".config")
        self.fs.mkdir(".config/neon-desktop")
        self.state = DesktopState(self.fs)
        self.a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        self.b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        self.first = {"id": self.a, "app": "org.neon.terminal", "state": {"terminal": "g3_first"}}
        self.second = {"id": self.b, "app": "org.neon.files", "state": {"path": "."}}

    def tearDown(self):
        self.fs.close()
        self.tmp.cleanup()

    def test_latest_legacy_layout_seeds_all_devices_once(self):
        older = self.state.path(self.a)
        newer = self.state.path(self.b)
        self.state.store(older, {"windows": [self.second], "accent": "old"})
        self.state.store(newer, {"windows": [{"app": "org.neon.terminal", "state": {"terminal": "g3_kept"}}], "accent": "new"})
        os.utime(Path(self.tmp.name) / older, (1, 1))
        a, b = self.state.get(self.a), self.state.get(self.b)
        self.assertEqual(a["windows"], b["windows"])
        self.assertEqual(a["windows"][0]["state"]["terminal"], "g3_kept")
        self.assertIn("id", a["windows"][0])
        self.assertEqual(a["accent"], "old")
        self.assertEqual(b["accent"], "new")
        self.assertEqual((Path(self.tmp.name) / self.state.workspace_path).stat().st_mode & 0o777, 0o600)
        self.assertIn(b'"g3_kept"', self.fs.read(newer))

    def test_stale_device_changes_preserve_other_device_windows_and_closes(self):
        self.state.save(self.a, {"accent": "mint"}, {"upsert": [self.first]})
        self.state.save(self.b, {"accent": "cyan"}, {"upsert": [self.second]})
        self.state.save(self.a, {"accent": "mint"}, {"remove": [self.a]})
        moved = {**self.second, "g": {"x": 20, "y": 10, "w": 500, "h": 400}}
        self.state.save(self.b, {"accent": "cyan"}, {"upsert": [moved]})
        self.assertEqual(self.state.get(self.a)["windows"], [moved])
        self.assertEqual(self.state.get(self.b)["windows"], [moved])
        self.assertEqual(self.state.get(self.a)["accent"], "mint")
        self.assertEqual(self.state.get(self.b)["accent"], "cyan")

    def test_new_device_and_reload_reuse_exact_terminal_and_window_identities(self):
        self.state.save(self.a, {"windows": [self.first]})
        self.assertEqual(self.state.get(self.b)["windows"], [self.first])
        # An older client omits window IDs but still refers to the retained PTY.
        legacy = {"app": "org.neon.terminal", "state": self.first["state"]}
        self.state.save(None, {"windows": [legacy]})
        self.assertEqual(self.state.get(self.a)["windows"][0]["id"], self.a)
        self.assertEqual(self.state.get(self.a)["windows"][0]["state"], self.first["state"])

    def test_invalid_patch_does_not_replace_existing_workspace(self):
        self.state.save(self.a, {"windows": [self.first]})
        for changes in ({"remove": ["../desktop.json"]}, {"upsert": [self.second, self.second]}, {"upsert": "invalid"}):
            with self.assertRaises(ValueError):
                self.state.save(self.b, {}, changes)
        self.assertEqual(self.state.get(self.a)["windows"], [self.first])

    def test_stale_geometry_and_reconnect_cannot_resurrect_a_closed_window(self):
        self.state.save(self.a, {"windows": [self.first]})
        stale = self.state.get(self.b)["windows"][0]
        self.state.save(self.a, {}, {"remove": [self.first["id"]]})
        # Restart/reload retains the close, including for an older patch client.
        self.state = DesktopState(self.fs)
        self.state.save(self.b, {}, {"upsert": [{**stale, "g": {"x": 50}}]})
        self.assertEqual(self.state.get(self.b)["windows"], [])
        self.state.save(self.b, {}, {"upsert": [{**stale, "minimized": True}]})
        self.assertEqual(self.state.get(self.a)["windows"], [])

    def test_legacy_layout_cannot_restore_a_closed_window_but_can_open_a_new_one(self):
        self.state.save(self.a, {"windows": [self.first]})
        self.state.save(self.a, {}, {"remove": [self.first["id"]]})
        self.state.save(self.b, {"windows": [self.first, self.second]})
        self.assertEqual(self.state.get(self.a)["windows"], [self.second])

    def test_remove_wins_over_an_upsert_in_the_same_patch(self):
        self.state.save(self.a, {"windows": [self.first]})
        self.state.save(self.b, {}, {
            "remove": [self.first["id"]], "upsert": [self.first],
        })
        self.assertEqual(self.state.get(self.a)["windows"], [])

    def test_explicit_opens_preserve_new_windows_but_ignore_absent_updates(self):
        self.state.save(self.a, {}, {"upsert": [self.first], "open": []})
        self.assertEqual(self.state.get(self.a)["windows"], [])
        self.state.save(self.a, {}, {"upsert": [self.first], "open": [self.first["id"]]})
        self.state.save(self.b, {}, {"upsert": [self.second], "open": [self.second["id"]]})
        moved = {**self.first, "g": {"x": 50}}
        self.state.save(self.a, {}, {"upsert": [moved], "open": []})
        self.assertEqual(self.state.get(self.a)["windows"], [moved, self.second])
        self.state.save(self.b, {}, {"remove": [self.first["id"]], "open": []})
        self.state.save(self.a, {}, {"upsert": [moved], "open": []})
        self.assertEqual(self.state.get(self.a)["windows"], [self.second])

    def test_close_records_are_bounded_and_modern_updates_stay_rejected_after_eviction(self):
        closed = [str(uuid.UUID(int=i)) for i in range(2000)]
        self.state.store(self.state.workspace_path, {"windows": [self.first], "closed": closed})
        self.state.save(self.a, {}, {"remove": [self.first["id"]], "open": []})
        saved = self.state.load(self.state.workspace_path, {})
        self.assertEqual(len(saved["closed"]), 2000)
        self.assertNotIn(closed[0], saved["closed"])
        stale = {**self.first, "id": closed[0]}
        self.state.save(self.b, {}, {"upsert": [stale], "open": []})
        self.assertEqual(self.state.get(self.a)["windows"], [])

    def test_invalid_open_identities_leave_windows_and_preferences_unchanged(self):
        self.state.save(self.a, {"windows": [self.first], "accent": "mint"})
        before = self.fs.read(self.state.workspace_path)
        for opened in (None, "invalid", ["../workspace.json"], [self.second["id"]]):
            with self.assertRaises(ValueError):
                self.state.save(self.a, {"accent": "red"}, {"upsert": [self.first], "open": opened})
        self.assertEqual(self.fs.read(self.state.workspace_path), before)
        self.assertEqual(self.state.get(self.a)["accent"], "mint")

    def test_ignored_closed_updates_do_not_consume_the_window_limit(self):
        self.state.save(self.a, {"windows": [self.first]})
        self.state.save(self.a, {}, {"remove": [self.first["id"]]})
        windows = [{**self.second, "id": str(uuid.UUID(int=i))} for i in range(1, 51)]
        self.state.save(self.a, {"windows": windows})
        self.state.save(self.b, {"accent": "cyan"}, {"upsert": [self.first]})
        saved = self.state.get(self.b)
        self.assertEqual(saved["windows"], windows)
        self.assertEqual(saved["accent"], "cyan")
