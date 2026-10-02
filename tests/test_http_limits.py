import unittest
from types import SimpleNamespace
from aiohttp import web
from neon.http_limits import login_body
class Content:
    def __init__(self,chunks): self.chunks=chunks;self.reads=0
    async def iter_chunked(self,size):
        for chunk in self.chunks:
            self.reads+=1
            yield chunk
class LoginLimit(unittest.IsolatedAsyncioTestCase):
    async def test_fragmented_body_reassembled(self):
        r=SimpleNamespace(content=Content([b'{"user',b'name":"test"}']))
        self.assertEqual(await login_body(r),b'{"username":"test"}')
    async def test_oversized_stream_stops_before_remaining_chunks(self):
        r=SimpleNamespace(content=Content([b'x'*2048]*10))
        with self.assertRaises(web.HTTPRequestEntityTooLarge):await login_body(r)
        self.assertEqual(r.content.reads,3)
