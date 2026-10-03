#!/usr/bin/env python3
"""Opt this host into managed coding apps after installing the pinned CLIs."""
import argparse
import json
import os
from pathlib import Path
import shutil
from urllib.parse import urlsplit

p = argparse.ArgumentParser()
p.add_argument('--qwen-base-url', required=True, help='OpenAI-compatible model URL; use a loopback SSH tunnel for remote models')
p.add_argument('--qwen-model', default='qwen3-coder-next')
p.add_argument('--terminal-only', action='store_true', help='Expose shell commands without separate desktop apps')
a = p.parse_args()
if os.geteuid() != 0:
    raise SystemExit('Run through administrative SSH/sudo')
url = urlsplit(a.qwen_base_url)
if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
    raise SystemExit('Expected a model URL without credentials, query or fragment')
if url.scheme == 'http' and url.hostname not in ('127.0.0.1', 'localhost', '::1'):
    raise SystemExit('Use HTTPS or an authenticated SSH tunnel to loopback')
for executable in ('dbus-daemon', 'gnome-keyring-daemon', 'gdbus'):
    if not shutil.which(executable): raise SystemExit('Missing OS dependency: ' + executable)
root = Path('/opt/neon-coding-tools/current/node_modules')
versions = {}
for kind, package in [('codex', '@openai/codex'), ('qwen', '@qwen-code/qwen-code')]:
    versions[kind] = json.loads((root/package/'package.json').read_text())['version']
    command = 'neon-codex' if kind == 'codex' else 'neon-qwen-coder'
    launcher = Path('/usr/local/bin') / command
    launcher.write_text('#!/bin/sh\nexec /opt/neon-python-3.14.3/bin/python /opt/neon-desktop/current/scripts/coding-launch.py ' + kind + ' "$@"\n')
    launcher.chmod(0o755)
    for alias in (['codex'] if kind == 'codex' else ['qwen', 'qwen-coder']):
        launcher = Path('/usr/local/bin') / alias
        launcher.write_text('#!/bin/sh\nexec /opt/neon-python-3.14.3/bin/python /opt/neon-desktop/current/scripts/coding-launch.py ' + kind + ' --cli "$@"\n')
        launcher.chmod(0o755)
config = {'codex': {'enabled': True, 'version': versions['codex']},
          'qwen': {'enabled': True, 'version': versions['qwen'], 'base_url': a.qwen_base_url.rstrip('/'), 'model': a.qwen_model}}
for entry in config.values(): entry['desktop_enabled'] = not a.terminal_only
defaults = {'$version': 4,
    'general': {'disableAutoUpdate': True, 'disableUpdateNag': True},
    'privacy': {'usageStatisticsEnabled': False}, 'telemetry': {'enabled': False},
    'memory': {'enableManagedAutoMemory': False, 'enableManagedAutoDream': False, 'enableAutoSkill': False},
    'modelProviders': {'openai': [{'id': a.qwen_model, 'name': 'Qwen3-Coder-Next (local server)',
        'baseUrl': a.qwen_base_url.rstrip('/'), 'envKey': 'OPENAI_API_KEY',
        'generationConfig': {'contextWindowSize': 32768, 'timeout': 300000, 'streamIdleTimeoutMs': 300000,
            'maxRetries': 1, 'max_tokens': 8192, 'temperature': 1.0, 'top_p': 0.95, 'top_k': 40, 'min_p': 0}}]}}
for name, data in [('coding-apps.json', config), ('qwen-defaults.json', defaults)]:
    file = Path('/etc/neon-desktop')/name
    if file.exists() and not file.with_suffix('.json.before-coding-apps').exists():
        shutil.copy2(file, file.with_suffix('.json.before-coding-apps'))
    file.write_text(json.dumps(data, indent=2) + '\n')
    file.chmod(0o644)
print('Host coding applications configured. Activate the corresponding Neon release with update-release.py.')
