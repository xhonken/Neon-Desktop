# Neon Desktop Maintainer Guide

**Snapshot: 2026-10-04, source version 0.1.0-alpha.8.** This guide provides a starting
point for a new maintainer. [STATUS.md](STATUS.md) contains detailed scope and
acceptance evidence.

## Purpose and current scope

Neon Desktop is an independent Linux web desktop for Raspberry Pi 5 and Debian
ARM64. Users sign in with Linux accounts and work with real files in HOME.
The project uses the MIT license. Its canonical repository is
[xhonken/Neon-Desktop](https://github.com/xhonken/Neon-Desktop).

The working alpha includes windows and a shared cross-device layout, Files, Code, terminals,
SSH, background jobs, Chromium, Settings, App Center, Trash and account
administration. Optional Codex/Qwen Coder integrations support persistent
per-user CLI sessions and terminal-only use. Real model inference remains a
separate acceptance step.

## Architecture and code map

Requests flow from the browser through Caddy HTTPS to an unprivileged aiohttp
gateway, then through a local PAM/session broker to workers running as the
authenticated Linux UID. Chromium runs in a separate per-user service.

| Location | Responsibility |
| --- | --- |
| `frontend/desktop.js`, `frontend/wm.js`, `frontend/connection.js` | Desktop, windows and connection recovery |
| `frontend/apps/`, `apps/*/manifest.json` | Application interfaces and manifests |
| `neon/gateway.py`, `neon/broker.py`, `neon/pam_auth.c` | HTTP boundary, sessions, permissions and Linux authentication |
| `neon/worker.py`, `neon/fs.py`, `neon/file_operations.py`, `neon/workbench.py` | User files, PTYs, Trash, SSH, jobs and history |
| `neon/browser.mjs`, `neon/accounts.py` | Chromium control and fixed account operations |
| `scripts/`, `deploy/`, `tests/` | Installation, updates, service definitions and checks |

The client uses JavaScript modules, Bootstrap, xterm.js and CodeMirror.
Third-party apps use sandboxed iframes and revision-bound permissions. Read
[ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md) before changes.

## Development and verification

For a fresh checkout, follow [README.md](../README.md) and use `.venv/bin/python`
for Python checks. Use Node 24; the development Pi's default Node is too old.

On the existing development Pi, run from the repository root:

```sh
env PATH=/opt/neon-node/bin:$PATH npm test
env PATH=/opt/neon-node/bin:$PATH npm run build
/opt/neon-python-3.14.3/bin/python -m unittest discover -s tests -v
```

Source verification covers **71 Python tests, 21 JavaScript tests, the frontend
build and source packaging**. STATUS.md records installed HTTPS/PAM acceptance
on Debian ARM64 and x86-64 hosts, which remain on alpha.7. Some alpha.8 backend
fixes have unit coverage but have not yet received installed acceptance.
GitHub checks and releases are defined in `.github/workflows/checks.yml`;
see [VERSIONING.md](VERSIONING.md) for the public workflow.

## Deployment and operating rules

Installed releases are root-owned under `/opt/neon-desktop/releases`, selected
by `/opt/neon-desktop/current`. Deployment configuration lives in
`/etc/neon-desktop`, security state in `/var/lib/neon-broker`, and user settings
in `~/.config/neon-desktop`.

Use `scripts/update-release.py` for existing installations; follow
[UPDATES.md](UPDATES.md). Updates retain workers, terminals, jobs and Chromium,
so older workers may remain active. Closing windows or web logout detaches
access; reboot or process failure ends processes.

Preserve PAM authentication, per-UID execution, fixed privileged operations and
descriptor-relative HOME access through `openat2`. Administration uses SSH;
web terminals cannot elevate with sudo. Owner authorization is required to stop
active workers, browsers or jobs, or publish to GitHub. Credentials and site
configuration are provided separately. See [AGENTS.md](../AGENTS.md).

## Continuing the project

Agree the next feature with the owner, implement it, run checks and update
STATUS.md and CHANGELOG.md. Changes to authentication, files, processes or
persistence also need installed HTTPS/PAM acceptance proving actual UIDs,
files and process survival.

Before production release, fresh installation on a second OS image, broader
upgrade/rollback and multi-user tests, mobile/accessibility acceptance and
independent security review remain. Large-file transfers, richer browser
support and advanced editor features are also unfinished.
