# Architecture

## Trust boundaries

```text
Browser (HTTPS)
   |
Caddy (TLS, local CA for private-IP deployments)
   |
Gateway (neon-gateway UID, loopback only, no HOME/root access)
   |
Unix socket + SO_PEERCRED
   |
Broker (small privileged authentication and lifecycle component)
   |-- PAM helper (authenticate + account validation; credentials via stdin)
   |-- root-private opaque session capabilities and security events
   |-- fixed systemd user-worker activation
   |
   +-- worker@UID (files, preferences, PTYs, SSH client)
   +-- browser@UID (Chromium sandbox, private profile, separate cgroup)
```

The gateway cannot select a target UID or executable. The broker derives identity from a cryptographically random capability issued only after PAM succeeds. Only fixed unit templates and integer UIDs derived from the Linux account database reach systemctl. The broker has no network address families except AF_UNIX. A gateway compromise can steal sessions/credentials passing through it; it does not provide an arbitrary root command or filesystem API. Broker/parser/PAM vulnerabilities remain part of the trusted computing base.

Workers are system services under each Linux UID. Their processes do not depend on a browser window. Closing a window disconnects a stream; it does not kill a shell. Explicit process termination is separate. Web logout revokes access but does not stop worker or browser processes. Chromium has no disconnected idle termination timer. Worker failure/reboot kills its processes; UI recovery must report a missing process instead of presenting a fake continuation.

NoNewPrivileges and an empty capability bounding set are intentional: the web terminal cannot elevate via sudo/setuid. Use SSH for privileged administration. Linux filesystem permissions still govern ordinary terminal operations. The File Manager/Editor APIs have a stricter HOME-only policy.

## State

- `/etc/neon-desktop/environment`: deployment origin, no passwords.
- `/var/lib/neon-broker/sessions.sqlite3`: root-private sessions, grants and audit metadata. Session tokens are stored only as SHA-256 digests. CSRF tokens are not login credentials.
- `~/.config/neon-desktop/workspace.json`: shared window identities, geometry, app recovery state and terminal IDs.
- `~/.config/neon-desktop/desktop-<device UUID>.json`: device preferences; `desktop.json` retains legacy/default preferences.
- `~/.config/neon-desktop/editor-<uuid>.json`: bounded private editor recovery snapshots, separate from explicit document saves.
- `~/.config/neon-desktop/ssh-hosts.json`: nonsecret host metadata only.
- `~/.local/share/neon-desktop/browser`: per-user Chromium profile.
- `/run/neon-{worker,browser}-UID/api.sock`: private socket accessible only to its Linux user/root.

There is no file metadata index. File names, file contents and ownership come from actual filesystem calls.

## Client

The unauthenticated bootstrap contains only a login form and minimal styling. Authenticated desktop modules are served only after session validation. The desktop persists while apps lazy-load into window content areas. The window manager owns frames, focus, stacking and geometry. Manifests drive category and registry presentation; the core import map identifies only shipped trusted modules.

Third-party modules are not imported into the desktop origin. A sandboxed iframe communicates through a source-checked, versioned postMessage bridge, without receiving the desktop cookie or CSRF token. See APPLICATIONS.md.

## Dependencies

Python is provided by Debian; aiohttp runs in the separately pinned environment described in UPDATES.md. Node/npm are development/build tooling and run the isolated Chromium controller. Bootstrap CSS loads once; CodeMirror/xterm code is lazily bundled. No Java service is required by this architecture.

## Alpha.3 runtime generations

Current code is selected by a root-owned immutable release symlink. Each new worker uses a generation-specific unit/socket and terminal ID; the broker discovers retained workers for the authenticated UID. Browser units retain their running process across code switches. Background jobs have separate transient systemd units and fixed unprivileged runners pinned to their release. Job commands are read only after Linux identity isolation.

Device preferences use `desktop-<device UUID>.json`; the shared window list uses `workspace.json`. Stable window IDs and per-view change sets merge independent device edits. SSH profiles remain nonsecret JSON. Imported encrypted keys live in `.ssh`; an agent in the private worker runtime holds temporarily unlocked identities. History and job output live beneath `~/.local/share/neon-desktop/`. These are explicit snapshots/job records, not a mirror of the filesystem.

Window change sets explicitly identify new opens. Updating an absent window cannot recreate it. The private workspace also retains the latest 2,000 closed window IDs for older clients and whole-layout saves; close records survive worker restarts without growing indefinitely. Closing wins over an update in the same change set.

## Alpha.4 application distribution

App Center combines an administrator-controlled `/etc/neon-desktop/catalog.json`, root-owned `/var/lib/neon-apps/system` and per-UID `~/.local/share/neon-desktop/apps` stores. Global packages survive immutable core updates and are available to all eligible Linux accounts. Personal packages are discovered only for their owner. Core/global identities cannot be overridden by personal packages.

Preparation fetches a pinned public HTTPS Git commit without checkout/hooks/build scripts. A validated frontend-only package is reviewed, staged and activated by atomic registry replacement. New manifests refresh the desktop launcher in place. System package management uses the root-only `neon-apps` CLI, with network fetching dropped to the gateway UID. It never executes app code as root.

The broker combines manifests and enforces revision-bound permissions. Scoped static asset tickets are bound to the authenticated session, app ID and current package revision. Personal asset reads pass through the UID worker's HomeFS; the gateway has no HOME access. No filesystem mirror or additional identity database is introduced. The existing SQLite grant table uses revision-qualified app keys without a schema migration.

## Alpha.7 account authority

A separate root-only Unix account service exposes fixed local account operations, rechecks sudo membership and authenticates each sensitive action through PAM. The broker derives the actor from the current session; gateway and user worker privileges are unchanged. Per-user disk scans run inside that user's worker. See ACCOUNTS_AND_TRASH.md for write boundaries and process-retention semantics.
