#!/usr/bin/env python3
"""One-time upgrade bridge: retain a pre-persistence browser without restarting it.

Run as its Linux user with the original Node PID. Exits when that exact socket
peer changes/disappears. Future browser versions do not need this bridge.
"""

import argparse
import http.client
import os
import socket
import struct
import time

p = argparse.ArgumentParser()
p.add_argument("pid", type=int)
args = p.parse_args()
if os.getuid() < 1000:
    raise SystemExit("Run as the browser's Linux user")
path = f"/run/neon-browser-{os.getuid()}/api.sock"
while True:
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(path)
        peer, uid, _ = struct.unpack(
            "3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        )
        if peer != args.pid or uid != os.getuid():
            sock.close()
            break
        connection = http.client.HTTPConnection("localhost", timeout=5)
        connection.sock = sock
        connection.request(
            "POST",
            "/rpc",
            b'{"action":"browser.info"}',
            {"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        response.read()
        connection.close()
        if response.status != 200:
            break
    except (OSError, http.client.HTTPException):
        break
    time.sleep(60)
