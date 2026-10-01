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

Workers are system services under each Linux UID. Their processes do not depend on a browser window. Closing a window disconnects a stream; it does not kill a shell. Explicit process termination is separate. Worker failure/reboot kills its processes; UI recovery must report a missing process instead of presenting a fake continuation.

NoNewPrivileges and an empty capability bounding set are intentional: the web terminal cannot elevate via sudo/setuid. Use SSH for privileged administration. Linux filesystem permissions still govern ordinary terminal operations. The File Manager/Editor APIs have a stricter HOME-only policy.

## State

- `/etc/neon-desktop/environment`: deployment origin, no passwords.
- `/var/lib/neon-broker/sessions.sqlite3`: root-private sessions, grants and audit metadata. Session tokens are stored only as SHA-256 digests. CSRF tokens are not login credentials.
- `~/.config/neon-desktop/desktop.json`: geometry, pins, settings, document paths and terminal IDs.
- `~/.config/neon-desktop/ssh-hosts.json`: nonsecret host metadata only.
- `~/.local/share/neon-desktop/browser`: per-user Chromium profile.
- `/run/neon-{worker,browser}-UID/api.sock`: private socket accessible only to its Linux user/root.

There is no file metadata index. File names, file contents and ownership come from actual filesystem calls.

## Client

The unauthenticated bootstrap contains only a login form and minimal styling. Authenticated desktop modules are served only after session validation. The desktop persists while apps lazy-load into window content areas. The window manager owns frames, focus, stacking and geometry. Manifests drive category and registry presentation; the core import map identifies only shipped trusted modules.

Third-party modules are not imported into the desktop origin. A sandboxed iframe communicates through a source-checked, versioned postMessage bridge, without receiving the desktop cookie or CSRF token. See APPLICATIONS.md.

## Dependencies

Python/aiohttp is provided by Debian. Node/npm are development/build tooling and run the isolated Chromium controller. Bootstrap CSS loads once; CodeMirror/xterm code is lazily bundled. No Java service is required by this architecture.
