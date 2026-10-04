"""PTY shutdown must reach slow views even when their output queue is full."""

import asyncio
import os
import unittest
from unittest.mock import Mock

from neon.worker import Terminal


class TerminalOutputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.terminal = Terminal.__new__(Terminal)
        self.terminal.fd, self.slave = os.openpty()
        os.set_blocking(self.terminal.fd, False)
        self.terminal.alive = True
        self.terminal.clients = {}
        self.terminal.buffer = bytearray()
        self.terminal.process = Mock()
        self.terminal.process.poll.return_value = 0

    async def asyncTearDown(self):
        if self.terminal.alive:
            self.terminal.finish()
        if self.slave is not None:
            os.close(self.slave)

    def view(self, count=0):
        queue = asyncio.Queue(maxsize=32)
        for i in range(count):
            queue.put_nowait(f"chunk-{i}".encode())
        self.terminal.clients[queue] = "view-" + str(len(self.terminal.clients))
        return queue

    def drain(self, queue):
        return [queue.get_nowait() for _ in range(queue.qsize())]

    async def test_full_output_queue_delivers_end_and_preserves_the_remaining_tail(self):
        queue = self.view(32)
        self.terminal.finish()
        self.assertEqual(self.drain(queue), [f"chunk-{i}".encode() for i in range(1, 32)] + [None])
        self.assertFalse(self.terminal.alive)

    async def test_pty_eof_delivers_end_to_both_slow_and_fast_views(self):
        slow, fast = self.view(32), self.view()
        os.close(self.slave)
        self.slave = None
        self.terminal.read()
        self.assertFalse(self.terminal.alive)
        self.assertIsNone(self.drain(slow)[-1])
        self.assertEqual(self.drain(fast), [None])
        with self.assertRaises(OSError):
            os.fstat(self.terminal.fd)

    async def test_repeated_finish_sends_one_end_and_reaps_only_once(self):
        queue = self.view(31)
        self.terminal.finish()
        self.terminal.finish()
        self.assertEqual(self.drain(queue), [f"chunk-{i}".encode() for i in range(31)] + [None])
        self.terminal.process.poll.assert_called_once()

    async def test_shutdown_without_views_still_releases_the_pty(self):
        self.terminal.finish()
        self.assertFalse(self.terminal.alive)
        with self.assertRaises(OSError):
            os.fstat(self.terminal.fd)
