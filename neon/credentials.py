"""Root-only credential state for local PAM session revocation; no passwords stored."""
import hashlib
import time
from pathlib import Path


def shadow_version(record, day=None):
    fields = record.rstrip('\n').split(':')
    if len(fields) != 9 or not fields[1] or fields[1].startswith(('!', '*')):
        raise ValueError('Account unavailable')
    today = int(time.time() // 86400) if day is None else day
    def number(index):
        return int(fields[index]) if fields[index] else -1
    last, maximum, expires = number(2), number(4), number(7)
    if last == 0 or (expires >= 0 and today >= expires) or (last >= 0 and maximum >= 0 and today > last + maximum):
        raise ValueError('Account unavailable')
    return hashlib.sha256(record.rstrip('\n').encode()).hexdigest()


def credential_version(username):
    # Read as the root broker, never through the unprivileged gateway or worker.
    with Path('/etc/shadow').open() as stream:
        for line in stream:
            if line.split(':', 1)[0] == username:
                return shadow_version(line)
    raise ValueError('Account unavailable')
