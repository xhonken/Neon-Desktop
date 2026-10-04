# Implementation status — 0.1.0-alpha.8

This is a working first alpha, not completion of the full project plan. The confirmed product name is Neon Desktop. It is independently implemented; no Pi-2000 source or migration layer is included.

## Installed and exercised

The following were verified on a Raspberry Pi 5, 8 GB, ARM64, Debian 13 / Raspberry Pi OS, using the installed Caddy HTTPS origin through 2026-10-04. Client browser automation used the actual login page and PAM; it did not bypass authentication with a test token.

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
| Applications | Eleven core apps including App Center, Trash and administrator-only Administration; Git catalog, personal and global stores, sandbox SDK and revision-bound grants | Actual HTTPS Git/PAM/GUI install, update, uninstall; two-user visibility/ownership, stale asset/grant rejection; real catalog intentionally empty |
| Deployment | Caddy, systemd units, PAM policy, installer, source package tool and CI definition | Real host reboot, automatic gateway/broker startup, verified TLS from another LAN host |

Historical installed baseline: **52 Python tests and 11 JavaScript tests pass**. Both installed graphical suites and the disposable second-account isolation suite pass. The installed Node runtime is 24.21.0; Puppeteer is pinned to 25.12.0. npm audit reported zero known vulnerabilities at verification time; this is a time-specific dependency check, not a security certification. Current source checks cover **71 Python tests and 21 JavaScript tests**; installed acceptance and source publication are recorded separately below.

On Raspberry Pi OS the memory cgroup controller had to be enabled in the boot command line and verified after a real reboot. The installer and broker now fail closed if it is unavailable. Actual browser limits: 1 GiB memory.high, 1.5 GiB memory.max, 256 MiB memory.swap.max, 150% CPU and 160 tasks. A live 13-process Chromium session ran as the intended UID with renderer seccomp and no OOM events during the recorded check.

## Optional coding applications

Terminal-only installation provides ordinary `codex`, `qwen-coder` and `qwen`
commands while hiding separate desktop entries.

Codex and Qwen Coder can be enabled by an administrator on selected hosts; see
[CODING_APPS.md](CODING_APPS.md). They add two optional apps to the eleven-app
baseline. Installed HTTPS/PAM acceptance passed for the actual Codex interface,
encrypted per-user keyring, project directories containing spaces, real process
UID/cwd, reload/logout persistence and second-account isolation. The real Codex
credential-store roundtrip passed with a synthetic test value and no plaintext
auth.json. Qwen's unavailable-model state was verified graphically. Personal
OpenAI authentication/inference and real Qwen model inference remain separate
acceptance steps; the configured model server was unreachable during this check.

## Incomplete areas and release gates

- File operations are deliberately bounded: 16 MiB individual file API limit, 64 MiB expanded ZIP limit. Bounded recursive copy, private Trash/restore/purge and an in-document clipboard are implemented in alpha.7; large-file streaming/resumable uploads and fuller archive UX remain. ZIP creation currently accepts files, not arbitrary recursive trees.
- The editor checks an expected content revision before saving and preserves existing mode bits. This detects ordinary intervening saves; it is not a transaction against arbitrary external writers racing the final replacement. Unsaved editor documents now have bounded private recovery drafts; see SESSION_RECOVERY.md. Later LSP, Git, split editor and autocomplete are not implemented.
- OpenSSH uses the system host-key verification dialog inside the PTY and refuses changed keys. Named groups, encrypted-key import/unlock and optional remote tmux recovery are implemented in alpha.3. Graphical known_hosts/authorized_keys editing and SSH key generation remain. No SSH password storage is provided. Remote-host acceptance and w3m interaction have not received the same graphical coverage as the local PTY.
- Browser streaming is an initial single-page implementation. Rich tabs, audio/video optimization, clipboard/file dialogs/download integration, broader site/input compatibility, stress tests and aggregate multi-user admission remain. Minimizing or closing a desktop window does not intentionally end the browser process; only explicit stop ends it during ordinary operation. A crash, resource-limit kill or server restart still terminates processes.
- Settings is not the entire specified control panel. Secure keyring integration, detailed HOME usage/largest-directory controls, per-app notification preferences, full language/timezone/region controls and some appearance/editor controls remain. TOTP/WebAuthn are future work.
- Third-party apps support frontend isolation and two grant types: user-files and notifications. Other capabilities and third-party Python/Node backend execution are denied. The API/SDK is versioned but still alpha and not yet a stable compatibility promise. The example package is a development fixture, not installed in the normal eleven-app core.
- Administration supports fixed local account operations with explicit PAM confirmation; see ACCOUNTS_AND_TRASH.md. Optional Git/Arduino/database/media/etc. apps are not built. The web terminal cannot elevate through sudo/setuid; use SSH for administration.
- Full mobile/touch and assistive-technology acceptance, aggregate multi-user load testing, independent security review, broader upgrade/rollback acceptance and an owner-provided security contact are required before a public production release.
- The public source package excludes private site configuration and test artifacts. A clean source build is checked on the development Pi. A fresh installation on a second pristine OS image remains unverified; do not infer cross-distribution support from one host.

Client devices must trust the deployment's local Caddy CA for private-IP HTTPS. Only the public certificate may be exported. Source packaging and a local Git history do not imply GitHub publication.

## Source regression fixes — 2026-10-03

App permission revocation now removes the correct revision-bound grants atomically, including legacy entries. Repeated approvals work, revoked file/notification calls fail, and other users/apps remain unaffected. Stale window updates cannot recreate closed windows; bounded close records also protect older clients. Terminal shutdown reaches slow views even with a full output queue.

Checkout verification passes **71 Python tests, 12 JavaScript tests and the frontend build**, including eight HTTP permission tests, cross-device close/reconnect/restart cases and real PTY EOF with a full queue. These fixes have not yet been deployed or rechecked through installed HTTPS/PAM acceptance.

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


## Desktop foundations and login hardening (alpha.6)

Six desktop improvements are implemented: host identity/default accent, named terminal/taskbar titles, keyboard quick-open across apps/windows/SSH/sessions, desktop context menu and terminal-in-directory, actionable bounded notification center, and responsive/focus/language polish. See DESKTOP_FOUNDATION.md for exact scope, including the initial Swedish/English chrome boundary. Installed disposable-account GUI checks cover hostname, Ctrl+K, renaming, shortcuts/context menus, real directory PTY with spaces, language switch, upload notification and small-screen menu bounds. Browser inspection identified and fixed menu-height overlap on small screens.

The security review reproduced and fixed stale web access after Linux lock/password change, disabled authentication core dumps, bounded unauthenticated login bodies and deployed a patched pinned aiohttp runtime. TLS1.3-only behavior was verified with and without SNI; the Caddy catch-all policy closes the IP/no-SNI gap. Installed tests verify account revocation, request limits and all earlier two-account isolation/CSRF/Origin/socket/permission controls. See SECURITY_REVIEW.md for evidence, dependency advisories and remaining limits. Existing active user worker/terminal/browser processes are preserved except for any separately approved browser restart. This is not an independent security certification.

## Alpha.7 personal files and accounts

See [ACCOUNTS_AND_TRASH.md](ACCOUNTS_AND_TRASH.md) for implemented file recovery, copy limits, explicit sudo administration, self-password changes and browser-login management. Existing workers/browser/jobs are preserved; revoking web access is separate from stopping Linux processes.

## Shared workspace and terminal activation (post-alpha.7)

Clicking inside a terminal takes writing/resize control without replacing its
WebSocket or replaying its output. Keyboard focus and typing can also claim
control. Input typed during a connected claim is sent in order; disconnected
input is discarded. Current workers notify other views when ownership changes,
and retained workers continue using their existing claim API.

Open windows now follow the Linux account between devices through private
`workspace.json` state. Stable window IDs and change sets merge independent
client changes while keeping device preferences separate. The first read
migrates the latest old device layout. Window geometry, minimized/maximized
state and editor recovery travel with the window; geometry fits the new screen.
Recovery is bounded to 50 windows and still respects the recovery preference.

Installed HTTPS/PAM acceptance on 2026-10-03 passed with a disposable Linux
account and two isolated browser profiles at different viewport sizes: four
automatically restored windows, unsaved Code text, minimized/maximized state,
unchanged terminal IDs/PIDs, immediate typing after click-based control transfer,
offline/reconnect without input replay, reload, and a stale view not restoring
an explicitly closed window. Actual PTY UID, file content, ownership and private
workspace permissions were checked; no JavaScript page errors occurred. The
cross-device screenshot was visually inspected. The original five owner
workers and Chromium retained their process IDs across deployment. Run
`tests/live_desktop_continuity.py CONTROLLER_LINUX_USER` as root on a development
host for this acceptance; it stops and removes only its own disposable account.

The installed disposable second-account regression also passed real PAM,
file ownership, cross-HOME denial, identity-override rejection, Origin/CSRF/app
permissions, private worker sockets, logout revocation, root denial and login
throttling.

## In-place session recovery — 2026-10-04

Trusted input on the visible desktop now renews idle access. Background polling
and streamed output do not renew it. Idle or absolute expiry opens an opaque PAM
sign-in dialog over the same document; windows, unsaved text and running
terminals resume after authentication. Protected app imports wait for valid
access, and requests rejected with HTTP401 can retry once with fresh CSRF.
Initial configuration-read failures retain the login form for another attempt.
See [SESSION_RECOVERY.md](SESSION_RECOVERY.md) for policy and recovery details.

Checkout verification passes **71 Python tests, 21 JavaScript tests and the
frontend build**. Installed HTTPS/PAM acceptance passed startup-failure retry,
idle expiry without streams, real input renewal, loading a new app after expiry,
absolute expiry and offline recovery without document replacement. The same
editor DOM and terminal ID/PID survived; kernel UID and an actual PTY-written
file confirmed the process identity. The existing persistence suite also passed
local/OpenSSH process retention, unsaved drafts, in-place reauthentication,
Chromium retention and terminal reattachment, with no JavaScript page errors.

The deployment contains only this frontend change over the previously installed
release; the pending backend regression fixes above remain undeployed. All eight
existing owner worker/browser services retained their original process IDs.
Disposable acceptance accounts and their processes were removed. An already
open client needs one reload to receive the updated frontend; subsequent session
expiry is recovered within the same page.

The same immutable release was subsequently installed on a second Debian 13
x86-64 host. Its installed content fingerprint matches the development release;
native helpers were compiled for x86-64 and runtime dependency pins match.
Both HTTPS/PAM session-recovery and persistence suites passed there, including
actual terminal UID/PID, OpenSSH and Chromium retention. All four pre-existing
workers and three terminal processes retained their IDs. Site configuration was
unchanged, HTTPS certificate verification passed, and disposable accounts and
staging files were removed. This verifies an update of an existing installation;
a fresh installation on a pristine second OS remains a separate release gate.

## Public source version (alpha.8)

The first public source version includes the shared workspace, terminal input
activation, session recovery and source regression fixes described above.
Package and lockfile versions agree at `0.1.0-alpha.8`. GitHub is the canonical
repository; [VERSIONING.md](VERSIONING.md) describes checks, tags and releases.
Site configuration, credentials, user state and acceptance artifacts are excluded.

The two installed hosts remain on their verified alpha.7 immutable release.
Publication does not deploy alpha.8 or imply installed acceptance of the
previously pending backend fixes. Fresh-installation, broader load and
independent security review gates remain open.
