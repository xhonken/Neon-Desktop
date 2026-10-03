# Changelog

## 0.1.0-alpha.7 — unreleased

Adds optional administrator-installed Codex and Qwen Coder apps with project selection, persistent per-user CLI sessions, native desktop recovery, encrypted per-user Codex keyrings and a configured local Qwen model connection. Apps are enabled per host and remain absent on unconfigured deployments. See docs/CODING_APPS.md.

Adds private recoverable Trash, bounded recursive folder copy, shared Files clipboard, conflict prompts and server progress. Adds Administration for local account creation/lock/reset/sudo with PAM confirmation and a separate restricted root service. Settings Account now supports self-password changes and individual browser-login revocation. Web access revocation preserves running jobs; new accounts have no sudo by default. See docs/ACCOUNTS_AND_TRASH.md.

## 0.1.0-alpha.6 — unreleased

Adds host identity/accent, named terminal/taskbar titles, Ctrl+K search across apps/windows/SSH/sessions, desktop context menu, descriptor-based Open terminal here, actionable notification center, Swedish/English desktop chrome and responsive keyboard-focused polish. Hardens credential-state revocation, authentication core dumps and login request limits; pins patched aiohttp and provides TLS1.3-only dedicated-host configuration. See docs/DESKTOP_FOUNDATION.md and docs/SECURITY_REVIEW.md.

Sessions now shows only running terminal/SSH sessions, with a direct Stop button per row and automatic refresh while open. Ended terminals also disappear from Jobs & Sessions; ending a terminal session now closes its open windows and removes their taskbar/saved-layout entries, including views on other connected devices. Temporary disconnection still preserves windows and processes.

Adds a shared mint/cyan Bash prompt and compact N/ welcome mark for existing and future Linux users. A system Bash hook preserves personal dotfiles, aliases, history and running sessions. The first-install utility installs the theme; existing deployments can apply it independently with `scripts/install-shell-theme.py`. See docs/SHELL_THEME.md.

## 0.1.0-alpha.5 — unreleased

Confirms the Neon Desktop name and adds the Neon Glass default wallpaper. Appearance settings now support private personal raster uploads, preset selection, fill/fit, brightness and removal. Images use the existing authenticated HOME API and stay separate from desktop JSON. Existing user processes survive deployment.

## 0.1.0-alpha.4 — unreleased

Adds App Center with Git-backed catalogs, personal install/update/uninstall and administrator-managed global applications. Public HTTPS sources are pinned to full commits; packages are reviewed before atomic activation. Personal stores live in HOME, system stores outside immutable core releases. Global installation remains separate from per-user execution and permission grants.

Dynamic discovery updates the launcher without reloading the desktop. Package revisions bind grants and asset tickets; old versions lose access after update/removal. Downloads never execute repository build/install hooks. Adds an application template, catalog documentation, bounded Git fetching, package-security tests and installed two-user Git/PAM/GUI acceptance. Real repositories and optional applications will be provided later; nothing is published automatically.

## 0.1.0-alpha.3 — unreleased

Adds Jobs & Sessions with named retained terminals, independent resource-limited background jobs, bounded durable logs and completion status. Adds SSH Connections with named/grouped profiles, encrypted OpenSSH key import, temporary private-agent unlock and optional remote tmux reattachment. Passwords and passphrases are never saved in profiles.

Desktop layouts are device-specific, terminal input has explicit control transfer, Code has editing leases and per-view drafts, and bounded file history supports comparison, exclusions and revision-checked restoration. Immutable generation-based updates retain running worker/browser/job processes, expose inventory and defer unsafe rollback. See WORKBENCH.md and UPDATES.md for exact limits.

## 0.1.0-alpha.2 — unreleased

Browser disconnect and web logout now retain server sessions. Terminal and browser transports reconnect automatically with current authentication; expired login is renewed in place without discarding the desktop. A Server sessions picker reattaches existing/ended terminals even after their windows are closed. Chromium no longer has a disconnected idle termination timer. Stop process and End session remain explicit termination actions.

Editor recovery drafts are written to private HOME files, flushed before logout and restored with unsaved state/revisions. Pending layout/draft saves retry after reconnection. Recovery limits and the distinction between client disconnect, SSH transport loss and server restart are documented in SESSION_RECOVERY.md.

Verified with a disposable PAM account, loopback OpenSSH fixture, forced client transport loss, logout/login, session revocation, real background jobs, editor drafts and the same Chromium PID. Existing owner workers/browser were not restarted; a temporary PID-bound bridge keeps the pre-update browser alive until it is explicitly stopped.

## 0.1.0-alpha.1 — unreleased

Initial independently implemented desktop foundation: Linux PAM, privilege-separated broker/gateway, per-UID workers, constrained real HOME APIs, persistent PTYs and OpenSSH profiles, CodeMirror6, user-profile Chromium streaming, manifest registry, sandbox frontend SDK, window manager and personal settings. Installation units, source packaging and security tests added.

This is an early alpha with the explicit limitations in docs/STATUS.md, not completion of the entire project plan.
