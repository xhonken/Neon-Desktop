#!/usr/bin/python3
"""Single unlock request: stdin/argv never contain a passphrase."""

import os, socket, sys

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(3)
s.connect(os.environ["NEON_ASKPASS_SOCKET"])
s.sendall(bytes.fromhex(os.environ["NEON_ASKPASS_TOKEN"]))
value = b""
while not value.endswith(b"\n") and len(value) < 4097:
    part = s.recv(4097 - len(value))
    if not part:
        break
    value += part
sys.stdout.buffer.write(value)
value = b""
s.close()
