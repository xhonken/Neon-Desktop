"""Optional, administrator-installed coding tools; all execution is per UID."""

import json
import os
from pathlib import Path

CONFIG = Path('/etc/neon-desktop/coding-apps.json')
TOOLS = {
    'codex': ('org.neon.codex', '/usr/local/bin/neon-codex', 'Codex'),
    'qwen': ('org.neon.qwen-coder', '/usr/local/bin/neon-qwen-coder', 'Qwen Coder'),
}


def settings():
    try:
        data = json.loads(CONFIG.read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError('Invalid coding app configuration')
    return data


def enabled(kind):
    entry = settings().get(kind, {})
    return kind in TOOLS and isinstance(entry, dict) and entry.get('enabled') is True


def available_apps():
    return {info[0] for kind, info in TOOLS.items()
            if enabled(kind) and settings()[kind].get('desktop_enabled', True)}


def command(kind, mode='start'):
    if not isinstance(kind, str) or kind not in TOOLS or not enabled(kind):
        raise ValueError('This coding application is not installed on this host')
    allowed = {'start', 'resume', 'login'} if kind == 'codex' else {'start', 'resume'}
    if not isinstance(mode, str) or mode not in allowed:
        raise ValueError('Invalid coding application action')
    path = TOOLS[kind][1]
    if not os.access(path, os.X_OK):
        raise ValueError('Coding tool installation is incomplete')
    return [path, mode]
