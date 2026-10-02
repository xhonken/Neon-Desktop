"""Small unauthenticated bodies must not inherit the file-upload limit."""
from aiohttp import web

async def login_body(request):
    body = bytearray()
    async for chunk in request.content.iter_chunked(4097):
        body.extend(chunk)
        if len(body) > 4096:
            raise web.HTTPRequestEntityTooLarge(max_size=4096, actual_size=len(body))
    return bytes(body)
