"""Fixed Linux account operations. Only the root broker can reach this private service.
Passwords use PAM/chpasswd stdin, never command arguments, storage or logs.
"""
import asyncio
from collections import defaultdict, deque
import grp
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import struct
import time
from aiohttp import web
from .credentials import credential_version
from .workbench import ROOT

STATE = Path('/var/lib/neon-accounts')
RUNTIME = Path('/run/neon-accounts')


def valid_name(name):
    if not isinstance(name, str) or not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', name):
        raise ValueError('Use a Linux username: lowercase letters, digits, underscore or hyphen')
    return name


def account(name):
    valid_name(name)
    # This administrative API supports local accounts only, never NSS identities.
    local = {line.split(':', 1)[0] for line in Path('/etc/passwd').read_text().splitlines()}
    a = pwd.getpwnam(name)
    if name not in local or not 1000 <= a.pw_uid < 65534 or a.pw_dir != '/home/' + name or a.pw_shell not in Path('/etc/shells').read_text().splitlines() or a.pw_shell.endswith(('false', 'nologin')):
        raise ValueError('This account is not managed by Neon')
    st = os.stat(a.pw_dir, follow_symlinks=False)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != a.pw_uid:
        raise ValueError('Account HOME ownership is invalid')
    return a


def is_admin(name):
    try:
        a = account(name)
        sudo = grp.getgrnam('sudo')
        credential_version(name)
        return a.pw_gid == sudo.gr_gid or name in sudo.gr_mem
    except (KeyError, OSError, ValueError):
        return False


def shadow(name):
    for row in Path('/etc/shadow').read_text().splitlines():
        f = row.split(':')
        if f[0] == name:
            return f
    raise ValueError('Local password record unavailable')


def new_password(value):
    if not isinstance(value, str) or not 12 <= len(value) or len(value.encode()) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('Use at least 12 characters, at most 1024 bytes, with no control characters')
    return value


async def run(argv, data=None, timeout=20):
    proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(data), timeout)
    except BaseException:
        if proc.returncode is None:
            proc.kill(); await proc.wait()
        raise
    if proc.returncode:
        raise ValueError('Linux rejected the operation; check account state and password policy')
    return out


def save_locks(locks):
    tmp = STATE / 'locks.tmp'
    tmp.write_text(json.dumps(locks))
    os.replace(tmp, STATE / 'locks.json')


def binding(a):
    st = os.stat(a.pw_dir, follow_symlinks=False)
    return [a.pw_uid, st.st_dev, st.st_ino]


async def main():
    os.umask(0o077)
    STATE.mkdir(exist_ok=True)
    attempts = defaultdict(deque)
    mutation = asyncio.Lock()
    locks_path = STATE / 'locks.json'
    locks = json.loads(locks_path.read_text()) if locks_path.exists() else {}

    @web.middleware
    async def boundary(request, handler):
        peer = request.transport.get_extra_info('socket').getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        if struct.unpack('3i', peer)[1] != 0:
            raise web.HTTPForbidden()
        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except (ValueError, KeyError, OSError, TimeoutError) as e:
            return web.json_response({'error': str(e) if isinstance(e, ValueError) else 'Account operation unavailable'}, status=400)

    async def operate(request):
        b = await request.json()
        if not isinstance(b, dict):
            raise ValueError('Invalid request')
        actor = account(b.get('actor'))
        credential_version(actor.pw_name)
        op = b.get('operation')
        if op not in ('list', 'create', 'lock', 'unlock', 'reset', 'sudo.grant', 'sudo.revoke', 'password'):
            raise ValueError('Unknown account operation')
        if op != 'password' and not is_admin(actor.pw_name):
            raise web.HTTPForbidden()
        if op == 'list':
            users = []
            for a in pwd.getpwall():
                try:
                    a = account(a.pw_name)
                    f = shadow(a.pw_name)
                    try: credential_version(a.pw_name); available = True
                    except ValueError: available = False
                    sudo = grp.getgrnam('sudo')
                    users.append(dict(username=a.pw_name, uid=a.pw_uid, sudo=a.pw_gid == sudo.gr_gid or a.pw_name in sudo.gr_mem, available=available, lockedByNeon=locks.get(a.pw_name, {}).get('binding') == binding(a), self=a.pw_uid == actor.pw_uid))
                except (KeyError, ValueError, OSError):
                    continue
            return web.json_response({'users': users})
        target = actor.pw_name if op == 'password' else valid_name(b.get('username'))
        queue = attempts[actor.pw_uid]
        now = time.monotonic()
        while queue and queue[0] < now - 300: queue.popleft()
        if len(queue) >= 5:
            return web.json_response({'error': 'Too many authentication attempts; wait five minutes'}, status=429)
        queue.append(now)
        password = b.get('password')
        if not isinstance(password, str) or not 1 <= len(password.encode()) <= 1024 or any(c in password for c in '\n\r\x00'):
            raise ValueError('Current password is required')
        try:
            await run([str(ROOT / 'libexec/pam-auth')], (actor.pw_name+'\n'+password+'\n').encode(), timeout=18)
        except ValueError:
            return web.json_response({'error': 'Authentication failed'}, status=403)
        # Successful confirmations do not consume the failed-attempt quota.
        queue.pop()
        async with mutation:
            credential_version(actor.pw_name)
            if op != 'password' and not is_admin(actor.pw_name):
                raise web.HTTPForbidden()
            if op != 'create':
                a = account(target)
            if target == actor.pw_name and op in ('lock', 'reset', 'sudo.grant', 'sudo.revoke'):
                raise ValueError('Use My account for your password; you cannot lock or change your own administrator access')
            if op in ('create', 'password', 'reset'):
                fresh = new_password(b.get('newPassword'))
            if op == 'create':
                try: pwd.getpwnam(target)
                except KeyError: pass
                else: raise ValueError('Username already exists')
                if os.path.lexists('/home/'+target):
                    raise ValueError('HOME path already exists')
                await run(['/usr/sbin/useradd','-m','-U','-G','','-l','-K','UMASK=077','-s','/bin/bash','-d','/home/'+target,'--',target])
                a = account(target)
                os.chmod(a.pw_dir, 0o700)
                # useradd creates an unusable password until chpasswd succeeds.
                try: await run(['/usr/sbin/chpasswd'], (target+':'+fresh+'\n').encode())
                except ValueError:
                    locks[target] = {'binding': binding(a), 'expiry': '', 'locked': False}
                    save_locks(locks)
                    await run(['/usr/sbin/usermod','--lock','--expiredate','1','--',target])
                    raise ValueError('Account created but locked; reset its password, then unlock it')
            elif op in ('password', 'reset'):
                prior = shadow(target)
                was_locked = not prior[1] or prior[1].startswith(('!', '*'))
                if was_locked: await run(['/usr/sbin/usermod','--expiredate','1','--',target])
                try:
                    await run(['/usr/sbin/chpasswd'], (target+':'+fresh+'\n').encode())
                finally:
                    if was_locked: await run(['/usr/sbin/usermod','--lock','--expiredate',prior[7],'--',target])
            elif op == 'lock':
                if target not in locks:
                    f = shadow(target)
                    locks[target] = {'binding': binding(a), 'expiry': f[7], 'locked': not f[1] or f[1].startswith(('!', '*'))}
                    save_locks(locks)
                await run(['/usr/sbin/usermod','--lock','--expiredate','1','--',target])
            elif op == 'unlock':
                previous = locks.get(target)
                if not previous or previous['binding'] != binding(a):
                    raise ValueError('This account was not locked by Neon; review it through administrative SSH')
                args = ['/usr/sbin/usermod','--expiredate',previous['expiry']]
                if not previous['locked']: args += ['--unlock']
                await run(args + ['--',target])
                locks.pop(target); save_locks(locks)
            elif op == 'sudo.grant':
                await run(['/usr/sbin/usermod','--append','--groups','sudo','--',target])
            elif op == 'sudo.revoke':
                if a.pw_gid == grp.getgrnam('sudo').gr_gid:
                    raise ValueError('Primary sudo group requires administrative SSH review')
                await run(['/usr/bin/gpasswd','--delete',target,'sudo'])
            # No process termination. Existing SSH processes retain their Linux groups.
            return web.json_response({'ok': True, 'target': target, 'operation': op})

    app = web.Application(middlewares=[boundary], client_max_size=8192)
    app.add_routes([web.post('/operate', operate)])
    runner = web.AppRunner(app, access_log=None, auto_decompress=False)
    await runner.setup()
    path = RUNTIME / 'api.sock'; path.unlink(missing_ok=True)
    await web.UnixSite(runner, str(path)).start()
    os.chmod(path, 0o600)
    await asyncio.Event().wait()


if __name__ == '__main__':
    asyncio.run(main())
