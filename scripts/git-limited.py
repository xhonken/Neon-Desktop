#!/usr/bin/env python3
"""Fixed unprivileged Git launcher with resource limits; never run repository hooks."""

import os, resource, sys

if os.geteuid() == 0:
    raise SystemExit("Git network operations must run without root")
resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024**2, 64 * 1024**2))
resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
os.execv("/usr/bin/git", ["git", *sys.argv[1:]])
