#!/usr/bin/env python3
"""Install the reviewed Python runtime separately from Debian's system Python."""
import os
from pathlib import Path
import subprocess

if os.geteuid() != 0:
    raise SystemExit('Run with sudo')
root=Path('/opt/neon-python-3.14.3')
if root.exists() and (root.is_symlink() or root.stat().st_uid != 0 or root.stat().st_mode & 0o022):
    raise SystemExit('Unsafe runtime directory')
subprocess.run(['/usr/bin/python3','-m','venv',str(root)],check=True)
subprocess.run([str(root/'bin/python'),'-m','pip','install','--index-url','https://pypi.org/simple','--disable-pip-version-check','--only-binary=:all:','--requirement',str(Path(__file__).resolve().parents[1]/'deploy/python-runtime.txt')],check=True,env={**os.environ,'PIP_CONFIG_FILE':os.devnull,'PIP_EXTRA_INDEX_URL':''})
subprocess.run([str(root/'bin/python'),'-m','pip','check'],check=True)
print('Installed pinned aiohttp runtime:',root)
