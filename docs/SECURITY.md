# Security model and alpha limitations

This alpha is for a trusted local development network. It has not received an independent security review. Do not expose it directly to the public Internet or use it as a hostile multi-tenant hosting platform.

## Implemented controls

- Linux PAM authentication and account validation; root/service accounts rejected before session issuance. No stored Linux passwords, custom login password hashes or web-user database.
- Privilege separation: public-facing gateway has no root capabilities or HOME access; user work occurs under actual UID/GID.
- Secure, HttpOnly, SameSite=Strict, `__Host-` session cookie. Random token per login, 12-hour absolute lifetime, 30-minute idle expiry. Explicit logout and revoke-other-sessions. Sessions are not persisted in browser localStorage.
- Exact deployment Host and Origin validation for mutations and WebSockets. CSRF validation in broker for state-changing requests; stream CSRF plus session checks. No CORS grant to arbitrary origins. Access logs intentionally omit cookie/token-bearing request data.
- CSP, nosniff, no-referrer, frame-ancestor restrictions, HTTPS through Caddy. Dynamic geometry requires inline styles; scripts do not use unsafe-eval or inline handlers.
- Broker authenticates Unix peer credentials and binds every user operation to the session's Linux UID. Gateway cannot supply arbitrary executable, service name or UID. Session principals also bind the username and HOME device/inode, preventing a reused UID from inheriting a former account's sessions or grants.
- HOME filesystem opens use openat2 RESOLVE_BENEATH/NO_SYMLINKS/NO_MAGICLINKS/NO_XDEV. Operations are descriptor-relative. Old kernels fail closed. Single-link regular file restriction prevents hardlink aliases; FIFOs/device nodes are rejected without blocking. `.ssh` and `.gnupg` require dedicated tools/terminal.
- Atomic same-directory file replacement, no silent overwrite for upload/copy/move. Bounded uploads and ZIP extraction; ZIP names, types, counts and expanded size prevalidated. No shell extraction or request-concatenated shell commands.
- SSH is the system OpenSSH client in a real PTY, with interactive new-host confirmation and refusal of changed keys. Agent forwarding is off; passwords are not saved in profiles.
- Chromium runs with its normal sandbox, under the user UID, with CDP over anonymous pipes and no debugging TCP listener. Per-user cookies/profile; dedicated memory/CPU/task limits, idle shutdown when disconnected.
- Root-owned deployed code and manifests. Third-party frontend sandbox, explicit limited grants, backend enforcement and permission revocation; no third-party Python backend execution.

## Important boundaries

Linux users with shell access can perform whatever their Linux permissions permit. A HOME API boundary is not a prison around all terminal commands. Local same-UID processes can modify their own files, configuration and browser state. Directory-descriptor operations protect against request path/symlink attacks; the same UID already controls its HOME and may concurrently rename directories through SSH. Editor saves include an expected content revision and reject ordinary intervening changes. This check is not a transaction against an external same-UID writer racing the final replacement.

The root broker and PAM helper are trusted code. A memory/parser/code execution defect there is potentially privileged. Keep their interface small, review changes, and do not add arbitrary plugin execution to the broker. PAM passwords necessarily pass transiently through the gateway/broker and PAM process memory; they are never written to logs/state. Crash dumps and debug logging must not collect authentication bodies.

Third-party frontend grants currently support `user-files` and `notifications`. File permission is powerful: an app can modify user data and shell/project files. Other declared capabilities remain denied for third-party apps. No arbitrary network/backend plugin runtime is advertised. Browser profile secrets are managed by Chromium; encrypted application credential storage and an OS-keyring integration are not yet provided, so the platform has no API to save app/SSH passwords.

Login throttling is enforced within the broker (per source/name plus global rate and concurrency limits). It is memory-resident and resets on broker restart. Root login attempts have generic responses. Timing-hardening, distributed rate limits and fuller account-lock/password-change revocation require review before public exposure.

Workers have NoNewPrivileges and no capabilities. `RestrictSUIDSGID` is intentionally omitted from the filesystem worker because systemd blocks openat2 under that setting. This is not a fallback to unsafe path handling. Browser/worker resource limits are systemd cgroups, not advisory browser flags. Installer and broker require the memory controller; verify actual memory.max/memory.swap.max in the active service cgroup. A systemctl property alone is insufficient evidence.

## Sources used for design

- [Linux openat2](https://www.man7.org/linux/man-pages/man2/openat2.2.html)
- [systemd execution restrictions](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
- [Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)

## Reporting

Before public release, the owner must provide a real private security contact and disclosure policy. Do not publish secrets, passwords, session cookies or private file contents in issues. No fictitious contact address is supplied in this development repository.
