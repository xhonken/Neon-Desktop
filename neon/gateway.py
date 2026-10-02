"""Network-facing, unprivileged gateway. No PAM access, HOME access or sudo."""

import asyncio
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode
from aiohttp import web, ClientSession, UnixConnector, ClientTimeout, WSMsgType

ROOT = Path(__file__).resolve().parents[1] / "dist"
COOKIE = "__Host-neon"
ORIGIN = os.environ["NEON_ORIGIN"]
CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"


async def main():
    client = ClientSession(
        connector=UnixConnector(path="/run/neon-broker/api.sock"),
        timeout=ClientTimeout(total=50),
    )

    asset_tickets = {}

    def headers(r):
        return {
            "Authorization": "Bearer " + r.cookies.get(COOKIE, ""),
            "X-CSRF-Token": r.headers.get("X-CSRF-Token", ""),
            "X-Neon-Background": r.headers.get("X-Neon-Background", "0"),
            "X-Client-IP": r.headers.get("X-Forwarded-For", "unknown")
            .split(",")[0]
            .strip(),
        }

    @web.middleware
    async def security(r, handler):
        if r.headers.get("Host") != ORIGIN.removeprefix("https://"):
            raise web.HTTPForbidden()
        if (
            r.method not in ("GET", "HEAD")
            or r.headers.get("Upgrade", "").lower() == "websocket"
        ):
            if r.headers.get("Origin") != ORIGIN:
                raise web.HTTPForbidden()
        if r.method not in ("GET", "HEAD") and r.content_type != "application/json":
            raise web.HTTPUnsupportedMediaType()
        try:
            response = await handler(r)
        except web.HTTPException as e:
            response = e
        if not response.prepared:
            response.headers.setdefault("Content-Security-Policy", CSP)
            response.headers.update(
                {
                    "X-Content-Type-Options": "nosniff",
                    "Referrer-Policy": "no-referrer",
                    "Cache-Control": "no-store",
                    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
                }
            )
        return response

    async def authorized(r):
        async with client.get("http://broker/me", headers=headers(r)) as reply:
            if reply.status != 200:
                raise web.HTTPUnauthorized()
            return await reply.json()

    async def index(r):
        return web.FileResponse(ROOT / "index.html")

    async def asset(r):
        path = r.match_info["path"]
        if path not in ("login.js", "login.css"):
            await authorized(r)
        resolved = (ROOT / path).resolve()
        if not resolved.is_relative_to(ROOT) or not resolved.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(resolved)

    async def app_launch(r):
        me = await authorized(r)
        if not secrets.compare_digest(r.headers.get("X-CSRF-Token", ""), me["csrf"]):
            raise web.HTTPForbidden()
        body = await r.json()
        appid = body.get("app")
        if not any(a["id"] == appid and a["runtime"] == "sandbox" for a in me["apps"]):
            raise web.HTTPNotFound()
        for key in list(asset_tickets):
            if asset_tickets[key]["expires"] < time.time():
                del asset_tickets[key]
        if len(asset_tickets) >= 1024:
            raise web.HTTPTooManyRequests()
        ticket = secrets.token_urlsafe(32)
        asset_tickets[ticket] = {
            "app": appid,
            "session": r.cookies.get(COOKIE, ""),
            "expires": time.time() + 600,
        }
        return web.json_response(
            {"src": "/app-assets/" + appid + "/" + ticket + "/index.html"}
        )

    async def app_asset(r):
        grant = asset_tickets.get(r.match_info["ticket"])
        if (
            not grant
            or grant["expires"] < time.time()
            or grant["app"] != r.match_info["app"]
        ):
            raise web.HTTPNotFound()
        async with client.get(
            "http://broker/me", headers={"Authorization": "Bearer " + grant["session"]}
        ) as reply:
            if reply.status != 200:
                raise web.HTTPUnauthorized()
            me = await reply.json()
        appid = r.match_info["app"]
        path = r.match_info["path"]
        if not any(a["id"] == appid and a["runtime"] == "sandbox" for a in me["apps"]):
            raise web.HTTPNotFound()
        base = Path(__file__).resolve().parents[1] / "apps" / appid / "frontend"
        file = (base / path).resolve()
        if not file.is_relative_to(base) or not file.is_file():
            raise web.HTTPNotFound()
        response = web.FileResponse(file)
        response.headers["Content-Security-Policy"] = (
            "sandbox allow-scripts; default-src 'none'; script-src "
            + ORIGIN
            + "; style-src "
            + ORIGIN
            + " 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors "
            + ORIGIN
            + "; base-uri 'none'; form-action 'none'"
        )
        return response

    async def login(r):
        async with client.post(
            "http://broker/login",
            data=await r.read(),
            headers={**headers(r), "Content-Type": "application/json"},
        ) as result:
            if result.status != 200:
                return web.json_response(
                    {"error": "Sign in failed."},
                    status=429 if result.status == 429 else 401,
                )
            data = await result.json()
            response = web.json_response({"csrf": data["csrf"]})
            response.set_cookie(
                COOKIE,
                data["token"],
                secure=True,
                httponly=True,
                samesite="Strict",
                path="/",
                max_age=43200,
            )
            return response

    async def proxy(r):
        name = r.match_info["name"]
        if name not in ("me", "logout", "rpc", "security", "permissions"):
            raise web.HTTPNotFound()
        async with client.request(
            r.method,
            "http://broker/" + name,
            data=await r.read(),
            headers={**headers(r), "Content-Type": "application/json"},
        ) as reply:
            raw = await reply.read()
            response = web.Response(
                body=raw,
                status=reply.status,
                content_type="application/json"
                if reply.content_type == "application/json"
                else "text/plain",
            )
            if name == "logout":
                response.del_cookie(
                    COOKIE, path="/", secure=True, httponly=True, samesite="Strict"
                )
            return response

    async def stream(r):
        await authorized(r)
        kind = r.match_info["kind"]
        sid = r.match_info["id"]
        if kind not in ("terminal", "browser") or not re.fullmatch(
            r"[a-zA-Z0-9_]{1,64}", sid
        ):
            raise web.HTTPNotFound()
        try:
            downstream = await client.ws_connect(
                "http://broker/stream/"
                + kind
                + "/"
                + sid
                + "?"
                + urlencode(
                    {
                        "app": r.query.get("app", ""),
                        "csrf": r.query.get("csrf", ""),
                        "view": r.query.get("view", ""),
                    }
                ),
                headers=headers(r),
                max_msg_size=4 * 1024**2,
            )
        except Exception:
            raise web.HTTPUnauthorized()
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=131072)
        await ws.prepare(r)

        async def pipe(src, dst):
            async for m in src:
                if m.type == WSMsgType.TEXT:
                    await dst.send_str(m.data)
                elif m.type == WSMsgType.BINARY:
                    await dst.send_bytes(m.data)

        tasks = [
            asyncio.create_task(pipe(ws, downstream)),
            asyncio.create_task(pipe(downstream, ws)),
        ]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await downstream.close()
        await ws.close()
        return ws

    app = web.Application(middlewares=[security], client_max_size=24 * 1024**2)
    app.add_routes(
        [
            web.get("/", index),
            web.get("/assets/{path:.*}", asset),
            web.get("/app-assets/{app}/{ticket}/{path:.*}", app_asset),
            web.post("/api/v1/app-launch", app_launch),
            web.post("/api/v1/login", login),
            web.route("*", "/api/v1/{name}", proxy),
            web.get("/api/v1/stream/{kind}/{id}", stream),
        ]
    )
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 8780).start()
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
