#!/usr/bin/env python3
"""Launch managed coding CLIs as the current user, never from the root broker."""

import fcntl
import getpass
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from neon.coding_apps import settings, TOOLS

BIN = Path('/opt/neon-coding-tools/current/node_modules/.bin')
NODE = '/opt/neon-node/bin'


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise RuntimeError('Private credential directory has an invalid owner or type')
    path.chmod(0o700)
    return path


def dbus(env, object_path, method, *args, destination='org.freedesktop.secrets'):
    return subprocess.run(
        ['/usr/bin/gdbus', 'call', '--session', '--dest', destination,
         '--object-path', object_path, '--method', method, *args],
        env=env, text=True, capture_output=True, timeout=5,
    )


def keyring(home, env):
    """A shared private per-UID Secret Service; disk keyrings require a password."""
    runtime = private_dir(home / '.cache/neon-codex-keyring')
    data = private_dir(home / '.local/share/neon-codex-keyring')
    env = dict(env, DBUS_SESSION_BUS_ADDRESS='unix:path=' + str(runtime / 'bus'))
    daemon_env = dict(env, XDG_DATA_HOME=str(data))
    control = private_dir(runtime / 'control')
    daemon_env['GNOME_KEYRING_CONTROL'] = str(control)
    # The lock serializes initial creation/unlock across multiple project windows.
    with (runtime / 'setup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        probe = dbus(env, '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames', destination='org.freedesktop.DBus')
        if probe.returncode:
            (runtime / 'bus').unlink(missing_ok=True)
            subprocess.run(
                ['/usr/bin/dbus-daemon', '--session', '--fork', '--address=' + env['DBUS_SESSION_BUS_ADDRESS']],
                env=daemon_env, check=True, timeout=10, stdout=subprocess.DEVNULL,
            )
        subprocess.run(
            ['/usr/bin/gnome-keyring-daemon', '--start', '--components=pkcs11,secrets', '--control-directory=' + str(control)],
            env=daemon_env, check=True, timeout=10, capture_output=True,
        )

        def unlocked():
            reply = dbus(env, '/org/freedesktop/secrets/collection/login',
                         'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Locked')
            return reply.returncode == 0 and 'false' in reply.stdout

        if not unlocked():
            first = not (data / 'keyrings/login.keyring').exists()
            print('Codex uses your own encrypted OS keyring. No login is shared with other Neon users.')
            if first:
                print('Choose a keyring password. You will need it again after the server restarts.')
            for _ in range(3):
                password = getpass.getpass('New keyring password: ' if first else 'Unlock Codex keyring: ')
                if not password:
                    print('An empty password is not allowed.'); continue
                if first and getpass.getpass('Repeat keyring password: ') != password:
                    print('Passwords do not match.'); continue
                subprocess.run(
                    ['/usr/bin/gnome-keyring-daemon', '--replace', '--unlock', '--daemonize', '--components=pkcs11,secrets', '--control-directory=' + str(control)],
                    input=password.encode(), env=daemon_env, capture_output=True, timeout=10,
                )
                password = None
                for wait in range(10):
                    if unlocked(): break
                    time.sleep(0.1)
                if unlocked(): break
                print('Could not unlock the keyring. Check the password.')
            else:
                raise RuntimeError('Keyring remains locked. No Codex credentials were saved to a plaintext file.')
        return env


def main():
    if os.getuid() < 1000:
        raise RuntimeError('Run this application as your own Linux user, not root')
    os.umask(0o077)
    kind = sys.argv[1] if len(sys.argv) > 1 else ''
    mode = sys.argv[2] if len(sys.argv) > 2 else 'start'
    cli = mode == '--cli'
    extra = sys.argv[3:] if cli else []
    info_only = cli and any(arg in ('--help', '-h', '--version', '-V') for arg in extra)
    if kind not in TOOLS or (not cli and mode not in ({'start', 'resume', 'login'} if kind == 'codex' else {'start', 'resume'})):
        raise RuntimeError('Invalid application or action')
    config = settings().get(kind, {})
    if config.get('enabled') is not True:
        raise RuntimeError('Application not enabled on this host')
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    env = dict(os.environ, HOME=str(home), PATH=NODE + ':/usr/local/bin:/usr/bin:/bin', TERM='xterm-256color', COLORTERM='truecolor')
    if kind == 'codex':
        private_dir(home / '.codex')
        env['CODEX_HOME'] = str(home / '.codex')
        if not info_only:
            env = keyring(home, env)
        argv = [str(BIN / 'codex'), '-c', 'cli_auth_credentials_store="keyring"', '-c', 'check_for_update_on_startup=false']
        if mode == 'login':
            argv += ['login', '--device-auth']
        else:
            argv += ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
            if mode == 'resume': argv += ['resume']
        if cli: argv += extra
    else:
        private_dir(home / '.qwen')
        base = config.get('base_url', '')
        model = config.get('model', '')
        if not info_only:
            try:
                with urllib.request.urlopen(base.rstrip('/') + '/models', timeout=5) as response:
                    models = json.load(response)
                if model not in [item.get('id') for item in models.get('data', [])]:
                    raise RuntimeError('The configured model is not available')
            except Exception as e:
                raise RuntimeError('Qwen server unavailable. Ask the administrator to check the model connection.') from e
        env.update(OPENAI_API_KEY='local-not-a-secret', OPENAI_BASE_URL=base, OPENAI_MODEL=model,
                   QWEN_CODE_SYSTEM_DEFAULTS_PATH='/etc/neon-desktop/qwen-defaults.json',
                   DISABLE_AUTOUPDATER='1', DISABLE_TELEMETRY='1')
        argv = [str(BIN / 'qwen'), '--auth-type', 'openai', '--openai-base-url', base, '--model', model]
        # Qwen's parser treats repeated approval options as an array.
        if not any(arg == '--approval-mode' or arg.startswith('--approval-mode=') for arg in extra):
            argv += ['--approval-mode', 'default']
        if mode == 'resume': argv += ['--resume']
        if cli: argv += extra
    os.execvpe(argv[0], argv, env)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
        print('Could not start coding app: ' + str(exc), file=sys.stderr)
        sys.exit(1)
