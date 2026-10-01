# Changelog

## 0.1.0-alpha.2 — unreleased

Browser disconnect and web logout now retain server sessions. Terminal and browser transports reconnect automatically with current authentication; expired login is renewed in place without discarding the desktop. A Server sessions picker reattaches existing/ended terminals even after their windows are closed. Chromium no longer has a disconnected idle termination timer. Stop process and End session remain explicit termination actions.

Editor recovery drafts are written to private HOME files, flushed before logout and restored with unsaved state/revisions. Pending layout/draft saves retry after reconnection. Recovery limits and the distinction between client disconnect, SSH transport loss and server restart are documented in SESSION_RECOVERY.md.

Verified with a disposable PAM account, loopback OpenSSH fixture, forced client transport loss, logout/login, session revocation, real background jobs, editor drafts and the same Chromium PID. Existing owner workers/browser were not restarted; a temporary PID-bound bridge keeps the pre-update browser alive until it is explicitly stopped.

## 0.1.0-alpha.1 — unreleased

Initial independently implemented desktop foundation: Linux PAM, privilege-separated broker/gateway, per-UID workers, constrained real HOME APIs, persistent PTYs and OpenSSH profiles, CodeMirror6, user-profile Chromium streaming, manifest registry, sandbox frontend SDK, window manager and personal settings. Installation units, source packaging and security tests added.

This is an early alpha with the explicit limitations in docs/STATUS.md, not completion of the entire project plan.
