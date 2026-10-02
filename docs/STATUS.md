# Implementation status — 0.1.0-alpha.3

This is a working first alpha, not completion of the full project plan. The working product name is Neon Desktop. It is independently implemented; no Pi-2000 source or migration layer is included.

## Installed and exercised

The following were verified on a Raspberry Pi 5, 8 GB, ARM64, Debian 13 / Raspberry Pi OS, using the installed Caddy HTTPS origin on 2026-10-02. Client browser automation used the actual login page and PAM; it did not bypass authentication with a test token.

| Area | Current implementation | Verification / boundary |
| --- | --- | --- |
| Authentication | Existing Linux account, PAM authentication and account checks; generic failures, login throttling, root denial | Real successful PAM login, failed/root login, throttling, logout revocation |
| Identity isolation | Unprivileged gateway, Unix-socket broker, per-UID worker/browser | Separate temporary Linux account, actual file ownership, rejected cross-HOME and supplied identity overrides, private worker socket |
| Sessions | Secure/HttpOnly/Strict cookie, CSRF, exact Origin, idle/absolute expiry, revoke other sessions | Live CSRF/Origin checks; unit tests for token hashing, expiry and UID/account reuse binding |
| Desktop | Persistent ES-module desktop, manifest categories, launcher, user pins/order, desktop shortcuts, clock and preferences | Installed graphical desktop; applications open without document reload |
| Windows | Movement, eight resize handles, focus/stacking, minimize/maximize/restore, left/right snapping, geometry recovery | Automated movement, edge/corner resize, minimize and maximize round-trips; geometry unit tests |
| Files | Real HOME listing, create/rename/move, file copy, upload/download, drag/drop, multi-selection, properties, ZIP creation/extraction | Actual on-disk content/UID; path, symlink, hardlink, special-file and archive security tests |
| Terminal | xterm and real PTY, user shell, resize, reconnect to running PTY, explicit stop; OpenSSH profiles; w3m mode | Actual shell UID and same PTY after browser reload; SSH requires interactive host-key verification |
| Editor | CodeMirror 6, tabs and reordering, tree, unsaved indicator, syntax, search/replace, undo, save/save-as | Real edit and Ctrl+S save; revision conflict and existing executable-mode tests |
| Graphical browser | Server-side Chromium, per-user persistent profile, screenshot/input stream, normal sandbox, pipe-only CDP, retained while disconnected | Actual navigation/stream; kernel cgroup files, UID, renderer seccomp, no --no-sandbox |
| Settings | Appearance/accent/scale, desktop recovery/snapping, pins, account metadata, session security, terminal/editor preferences, accessibility, clock, filesystem capacity | Opened through installed desktop; settings saved in user config |
| Applications | Nine core manifests, App Manager, root-only frontend package installer, sandbox SDK with explicit limited grants/revocation | Opaque-origin DOM/cookie isolation, notification grant, denied undeclared files and forged core app/action identity |
| Deployment | Caddy, systemd units, PAM policy, installer, source package tool and CI definition | Real host reboot, automatic gateway/broker startup, verified TLS from another LAN host |

Automated baseline: **22 Python tests and 6 JavaScript tests pass**. Both installed graphical suites and the disposable second-account isolation suite pass. The installed Node runtime is 24.21.0; Puppeteer is pinned to 25.12.0. npm audit reported zero known vulnerabilities at verification time; this is a time-specific dependency check, not a security certification. GitHub Actions has not run remotely because this repository has not been published.

On Raspberry Pi OS the memory cgroup controller had to be enabled in the boot command line and verified after a real reboot. The installer and broker now fail closed if it is unavailable. Actual browser limits: 1 GiB memory.high, 1.5 GiB memory.max, 256 MiB memory.swap.max, 150% CPU and 160 tasks. A live 13-process Chromium session ran as the intended UID with renderer seccomp and no OOM events during the recorded check.

## Incomplete areas and release gates

- File operations are deliberately bounded: 16 MiB individual file API limit, 64 MiB expanded ZIP limit. Recursive folder copy/delete, a durable clipboard workflow, Trash, large-file streaming/resumable upload and fuller archive UX remain. Empty directories can be deleted. ZIP creation currently accepts files, not arbitrary recursive trees.
- The editor checks an expected content revision before saving and preserves existing mode bits. This detects ordinary intervening saves; it is not a transaction against arbitrary external writers racing the final replacement. Unsaved editor documents now have bounded private recovery drafts; see SESSION_RECOVERY.md. Later LSP, Git, split editor and autocomplete are not implemented.
- OpenSSH uses the system host-key verification dialog inside the PTY and refuses changed keys. Named groups, encrypted-key import/unlock and optional remote tmux recovery are implemented in alpha.3. Graphical known_hosts/authorized_keys editing and SSH key generation remain. No SSH password storage is provided. Remote-host acceptance and w3m interaction have not received the same graphical coverage as the local PTY.
- Browser streaming is an initial single-page implementation. Rich tabs, audio/video optimization, clipboard/file dialogs/download integration, broader site/input compatibility, stress tests and aggregate multi-user admission remain. Minimizing or closing a desktop window does not intentionally end the browser process; only explicit stop ends it during ordinary operation. A crash, resource-limit kill or server restart still terminates processes.
- Settings is not the entire specified control panel. PAM password changing, secure keyring integration, HOME usage/largest directories/Trash controls, per-app notification preferences, full language/timezone/region controls, backgrounds and some appearance/editor controls remain. TOTP/WebAuthn are future work.
- Third-party apps support frontend isolation and two grant types: user-files and notifications. Other capabilities and third-party Python/Node backend execution are denied. The API/SDK is versioned but still alpha and not yet a stable compatibility promise. The example package is a development fixture, not installed in the normal nine-app core.
- No Administration app or optional Git/Arduino/database/media/etc. apps are built. System administration stays outside normal user Settings. The web terminal cannot elevate through sudo/setuid; use SSH for administration.
- Full mobile/touch and assistive-technology acceptance, aggregate multi-user load testing, independent security review, broader upgrade/rollback acceptance and an owner-provided security contact are required before a public production release.
- The public source package excludes private site configuration and test artifacts. A clean source build is checked on the development Pi. A fresh installation on a second pristine OS image remains unverified; do not infer cross-distribution support from one host.

Client devices must trust the deployment's local Caddy CA for private-IP HTTPS. Only the public certificate may be exported. Source packaging and a local Git history do not imply GitHub publication.

## Session retention verification (alpha.2)

The installed HTTPS UI was exercised with forced client offline/closed WebSockets, the same local PTY, an actual OpenSSH connection and background completion after logout, unsaved editor draft recovery, in-place reauthentication after cookie revocation, unchanged Chromium PID/URL across logout/login, and detached terminal discovery/reattachment. Tests use a disposable Linux account and separate loopback-only SSH/HTTP fixtures without changing the host SSH policy. The owner's existing worker and browser were not restarted.

## Workbench update (alpha.3)

See [WORKBENCH.md](WORKBENCH.md) for the six operational improvements and saved SSH profiles, and [UPDATES.md](UPDATES.md) for immutable deployment. Installed HTTPS acceptance on the development Pi passed: encrypted-key import and actual agent unlock/expiry, named/grouped profile UI, real OpenSSH and tmux transport-loss recovery with the same remote PID, changed-host-key refusal, terminal control transfer, separate managed-job UID/cgroup/log/exit/stop behavior across logout, bounded logs, file-history exclusions/revision conflicts, graphical comparison/restore, two live editor views with takeover and preserved drafts, and independent device configuration. The earlier full persistence suite and disposable second-account isolation suite also pass. No JavaScript page errors were observed.

Process-preserving release switches retained the owner's existing worker and Chromium PIDs. Idle-only update and rollback correctly deferred with live terminals. An actual rollback switch remains unperformed on this occupied host; its guard was tested without terminating work. A fresh installation on a second OS and broader upgrade compatibility remain release gates. These results do not imply completion of the full project plan or production readiness.
