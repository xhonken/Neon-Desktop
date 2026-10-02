# Implementation status — 0.1.0-alpha.5

This is a working first alpha, not completion of the full project plan. The confirmed product name is Neon Desktop. It is independently implemented; no Pi-2000 source or migration layer is included.

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
| Applications | Nine core apps including App Center; Git catalog, personal and global stores, sandbox SDK and revision-bound grants | Actual HTTPS Git/PAM/GUI install, update, uninstall; two-user visibility/ownership, stale asset/grant rejection; real catalog intentionally empty |
| Deployment | Caddy, systemd units, PAM policy, installer, source package tool and CI definition | Real host reboot, automatic gateway/broker startup, verified TLS from another LAN host |

Automated baseline: **28 Python tests and 6 JavaScript tests pass**. Both installed graphical suites and the disposable second-account isolation suite pass. The installed Node runtime is 24.21.0; Puppeteer is pinned to 25.12.0. npm audit reported zero known vulnerabilities at verification time; this is a time-specific dependency check, not a security certification. GitHub Actions has not run remotely because this repository has not been published.

On Raspberry Pi OS the memory cgroup controller had to be enabled in the boot command line and verified after a real reboot. The installer and broker now fail closed if it is unavailable. Actual browser limits: 1 GiB memory.high, 1.5 GiB memory.max, 256 MiB memory.swap.max, 150% CPU and 160 tasks. A live 13-process Chromium session ran as the intended UID with renderer seccomp and no OOM events during the recorded check.

## Incomplete areas and release gates

- File operations are deliberately bounded: 16 MiB individual file API limit, 64 MiB expanded ZIP limit. Recursive folder copy/delete, a durable clipboard workflow, Trash, large-file streaming/resumable upload and fuller archive UX remain. Empty directories can be deleted. ZIP creation currently accepts files, not arbitrary recursive trees.
- The editor checks an expected content revision before saving and preserves existing mode bits. This detects ordinary intervening saves; it is not a transaction against arbitrary external writers racing the final replacement. Unsaved editor documents now have bounded private recovery drafts; see SESSION_RECOVERY.md. Later LSP, Git, split editor and autocomplete are not implemented.
- OpenSSH uses the system host-key verification dialog inside the PTY and refuses changed keys. Named groups, encrypted-key import/unlock and optional remote tmux recovery are implemented in alpha.3. Graphical known_hosts/authorized_keys editing and SSH key generation remain. No SSH password storage is provided. Remote-host acceptance and w3m interaction have not received the same graphical coverage as the local PTY.
- Browser streaming is an initial single-page implementation. Rich tabs, audio/video optimization, clipboard/file dialogs/download integration, broader site/input compatibility, stress tests and aggregate multi-user admission remain. Minimizing or closing a desktop window does not intentionally end the browser process; only explicit stop ends it during ordinary operation. A crash, resource-limit kill or server restart still terminates processes.
- Settings is not the entire specified control panel. PAM password changing, secure keyring integration, HOME usage/largest directories/Trash controls, per-app notification preferences, full language/timezone/region controls and some appearance/editor controls remain. TOTP/WebAuthn are future work.
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

## App Center update (alpha.4)

The installed HTTPS desktop passed the complete Git lifecycle with a loopback smart HTTPS Git repository and two disposable PAM users: administrator catalog sync, global CLI installation, personal graphical installation/update/uninstall, same-document launcher refresh, personal visibility isolation, explicit sandbox permission review, stale prepared-version rejection, old asset/grant invalidation, global app file operations under each user's UID, and document preservation after uninstall. Test catalog, CA and accounts were cleaned up. Persistence and account-isolation regressions pass. Existing owner workers/browser were not restarted.

No public application repository/catalog has been created or published. The normal catalog stays empty until an administrator configures reviewed repositories/commits. A package template and catalog instructions are provided in APP_CENTER.md. Native app backends, broader capabilities, automatic catalog updates and publisher signatures remain future work. This implements the distribution foundation, not the optional application collection or a general system package manager.

## Wallpaper and identity (alpha.5)

Neon Desktop is the confirmed project name. Neon Glass is the default wallpaper, with a cyan/mint glass N mark and quiet graphite backdrop. Settings > Appearance offers the bundled image, classic grid, plain graphite or a personal PNG/JPEG/WebP upload, fill/fit and brightness. Personal images are normalized to JPEG in the client (maximum edge2560px); input limit10MiB/40MP, output limit5MiB. Original files are not modified. SVG/remote image URLs are not accepted.

The existing UID-bound HOME API stores the personal image mode0600 under `.config/neon-desktop/wallpaper-<device UUID>.jpg`. Per-device desktop configuration stores only selection/revision/fit/brightness, not image content. The gateway gains no HOME access and no public personal-image endpoint. The bundled image requires authentication. Missing/invalid personal images fall back to Neon Glass with a notification. Choosing another preset preserves the personal image until explicitly removed.

Installed HTTPS/PAM acceptance with two disposable accounts passed: authenticated-only bundled asset, default artwork, personal upload and reload, retained fit/brightness, account isolation, SVG rejection, remove/reset, narrow viewport and no JavaScript page errors. Real desktop and Appearance screenshots were visually inspected. Existing owner workers, four live terminals and Chromium process were retained.

## Shared Bash theme (post-alpha.5 host integration)

The development Pi now installs the shared mint/cyan N/ Bash appearance through a root-owned system startup file. Existing accounts and newly created standard `/home` Bash accounts inherit it; personal startup files and sudo membership remain unchanged. Fresh installation enables the theme, while existing installations use the separate helper described in [SHELL_THEME.md](SHELL_THEME.md). This is host configuration outside immutable core releases; the installed desktop version stays alpha.5.

Installed HTTPS/PAM acceptance passed for the owner and a newly created unprivileged account: actual UID, automatic logo/prompt, exact mint/cyan colors, last command exit status and long-line Home-key editing. Fresh interactive SSH login passed; non-interactive SSH remained silent except for its requested output, and root retained its normal shell. Real PTY checks also covered banner/theme opt-out, existing prompt hooks, narrow terminals, NO_COLOR and TERM=dumb. The installer passed syntax and repeat-install checks. All 28 Python and 6 JavaScript tests and the frontend build passed. Existing owner worker/terminal and gateway/broker PIDs were preserved; no services were restarted. The disposable test account was removed.

## Active session picker (post-alpha.5)

Sessions now lists only running terminal/SSH sessions and offers a direct Stop button per row. Successful stops remove the row immediately; a background refresh every two seconds catches natural exits and stops from another view. Closing or cancelling the picker ends polling. Failed stop requests leave the session visible for retry. Jobs & Sessions also filters ended terminal entries. The subsequent window-lifecycle update below closes views when a session ends.

Installed HTTPS/PAM acceptance passed with the owner and a disposable account: previously ended entries hidden, direct stop of only the selected session, failed-stop retry, natural shell exit disappearing while the picker remains open, empty state, reopening, Escape/close cleanup and no JavaScript errors. Stopped test processes were confirmed absent in /proc; original owner terminal PIDs were preserved across the immutable release update. All 28 Python and 6 JavaScript tests and the frontend build passed.


## Terminal window lifecycle (post-alpha.5)

Stopping a terminal session through Sessions, Jobs & Sessions or the terminal toolbar now closes its desktop views, including minimized windows, and removes taskbar/saved-layout entries. Server end notifications also close views on other connected devices and on natural shell exit. Reconnection to a known ended session closes its stale view; a transport failure alone preserves the window, and missing-worker diagnostics remain explicit. Closing a window with X still only detaches its live session.

Installed HTTPS/PAM acceptance with a disposable account passed: visible and minimized views across two device layouts, Sessions Stop, toolbar Stop, taskbar/layout removal, X detach and same-session reattach, natural exit, offline preservation followed by stop from another device and reconnect cleanup, and reload without ended-window recovery. Actual UID and terminated process absence in /proc were verified; no JavaScript errors. All 28 Python and 6 JavaScript tests and the frontend build passed. The process-preserving updater retained the owner's running worker and terminal.
