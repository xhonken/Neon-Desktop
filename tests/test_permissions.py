"""Exercise the broker's actual permission handler and capability checks over HTTP."""

from functools import partial
import json
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from neon.broker import Sessions, check_permission, grant_key, permissions


class PermissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sessions = Sessions(":memory:")
        self.uid = 1001
        self.app = {
            "id": "org.example.permissions",
            "revision": "a" * 32,
            "runtime": "sandbox",
            "permissions": ["user-files", "notifications"],
        }
        self.apps = {self.app["id"]: self.app}

        async def registry(uid):
            return self.apps

        def identify(request):
            # Authentication is supplied by the fixture; authorization is real.
            return "fixture", {"uid": self.uid, "peer": "test"}

        async def capability(request):
            await check_permission(
                self.app["id"], request.match_info["action"], self.uid,
                request.query.get("revision", self.app["revision"]),
                sessions=self.sessions, registry=registry,
            )
            return web.json_response({"ok": True})

        app = web.Application()
        app.router.add_post(
            "/permissions",
            partial(permissions, sessions=self.sessions, identify=identify, registry=registry),
        )
        app.router.add_get("/capability/{action}", capability)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.sessions.db.close()

    async def approve(self, granted, **changes):
        return await self.client.post("/permissions", json={
            "app": self.app["id"], "revision": self.app["revision"],
            "permissions": granted, **changes,
        })

    async def allowed(self, action="files.read", **query):
        response = await self.client.get("/capability/" + action, params=query)
        return response.status

    def rows(self):
        return self.sessions.db.execute(
            "SELECT uid,app,permission FROM grants ORDER BY uid,app,permission"
        ).fetchall()

    async def test_revoke_denies_an_already_open_apps_file_and_notification_calls(self):
        self.assertEqual((await self.approve(self.app["permissions"])).status, 200)
        self.assertEqual(await self.allowed(), 200)
        self.assertEqual(await self.allowed("notifications.check"), 200)
        response = await self.approve([])
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {"ok": True})
        self.assertEqual(await self.allowed(), 403)
        self.assertEqual(await self.allowed("notifications.check"), 403)
        self.assertEqual(self.rows(), [])

    async def test_repeated_approval_and_regrant_after_revoke_are_idempotent(self):
        for granted in (["user-files"], ["user-files"], [], ["user-files", "user-files"]):
            self.assertEqual((await self.approve(granted)).status, 200)
        self.assertEqual(await self.allowed(), 200)
        self.assertEqual(self.rows(), [(self.uid, grant_key(self.app), "user-files")])

    async def test_replacing_permissions_removes_the_previous_capability(self):
        self.assertEqual((await self.approve(["user-files"])).status, 200)
        self.assertEqual((await self.approve(["notifications"])).status, 200)
        self.assertEqual(await self.allowed(), 403)
        self.assertEqual(await self.allowed("notifications.check"), 200)

    async def test_revoke_cleans_legacy_and_old_revisions_without_cross_user_or_app_changes(self):
        ident = self.app["id"]
        preserved = [
            (1002, grant_key(self.app), "user-files"),
            (self.uid, ident + ".other@" + "a" * 32, "user-files"),
        ]
        self.sessions.db.executemany("INSERT INTO grants VALUES (?,?,?)", [
            (self.uid, ident, "user-files"),
            (self.uid, ident + "@" + "b" * 32, "user-files"),
            (self.uid, grant_key(self.app), "user-files"),
            *preserved,
        ])
        self.sessions.db.commit()
        self.assertEqual((await self.approve([])).status, 200)
        self.assertEqual(self.rows(), sorted(preserved))
        self.assertEqual(await self.allowed(), 403)
        self.uid = 1002
        self.assertEqual(await self.allowed(), 200)

    async def test_stale_revision_and_unknown_capabilities_do_not_change_grants(self):
        self.assertEqual((await self.approve(["user-files"])).status, 200)
        before = self.rows()
        self.assertEqual((await self.approve([], revision="b" * 32)).status, 400)
        self.assertEqual((await self.approve(["terminal"])).status, 403)
        self.assertEqual((await self.approve([], app="missing")).status, 400)
        self.assertEqual(self.rows(), before)
        self.assertEqual(await self.allowed(revision="b" * 32), 403)
        self.assertEqual(await self.allowed("terminal.create"), 403)

    async def test_invalid_payloads_preserve_existing_grants(self):
        self.assertEqual((await self.approve(["user-files"])).status, 200)
        before = self.rows()
        for body in ([], None, "invalid"):
            response = await self.client.post(
                "/permissions", data=json.dumps(body),
                headers={"Content-Type": "application/json"},
            )
            self.assertEqual(response.status, 400)
        for granted in ("user-files", [None], [["user-files"]]):
            self.assertEqual((await self.approve(granted)).status, 403)
        self.assertEqual(self.rows(), before)

    async def test_core_app_permissions_cannot_be_changed_through_third_party_api(self):
        self.app["runtime"] = "core"
        self.assertEqual((await self.approve(["user-files"])).status, 400)
        self.assertEqual(self.rows(), [])

    async def test_failed_replacement_rolls_back_all_previous_grants(self):
        self.assertEqual((await self.approve(["user-files"])).status, 200)
        before = self.rows()
        self.sessions.db.execute(
            "CREATE TRIGGER reject_notification BEFORE INSERT ON grants "
            "WHEN NEW.permission='notifications' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
        )
        with self.assertLogs("aiohttp.server", level="ERROR"):
            self.assertEqual((await self.approve(self.app["permissions"])).status, 500)
        self.assertFalse(self.sessions.db.in_transaction)
        self.assertEqual(self.rows(), before)
        self.assertEqual(await self.allowed(), 200)
