# Application manifest and API v1

The dynamic registry combines root-owned built-in manifests, administrator-installed system packages and the authenticated user's personal packages. Categories come from manifests. Applications cannot automatically pin themselves; users explicitly pin and reorder them.

See [App Center and Git distribution](APP_CENTER.md) for package manifests, catalog setup and install/update/remove workflows. `examples/app-template` is a starting point for future Git-hosted packages; `examples/org.example.hello` remains an SDK development fixture. Neither is installed automatically. The old `scripts/app-install.py` is retired. Personal installation uses App Center; administrators manage global packages with `sudo neon-apps`. Application discovery changes in place without restarting user processes.

## Manifest

Required fields: `id`, `name`, `version`, `category`, `runtime`, `pinnable`, `window`, `permissions`. IDs use lowercase reverse-domain style. Reserved `org.neon.*` IDs are for shipped core modules. Third-party runtime must be `sandbox`; `frontend/index.html` is the entry point. No package lifecycle scripts or backend modules are executed by the installer. Symlinks, special files and overlarge packages are rejected. Only the manifest and frontend tree are installed.

The desktop owns the outer frame. Apps render their content only. The iframe has `sandbox="allow-scripts"` with no same-origin capability. CSP forbids direct network connections/forms. Do not use embedded arbitrary web pages for the Browser app; that core app streams actual Chromium.

## Bridge

Send to the parent:

```js
parent.postMessage({
  channel: 'neon-sdk-v1',
  id: crypto.randomUUID(),
  action: 'theme',
  args: {}
}, '*');
```

The parent verifies the sending frame's WindowProxy and opaque origin, assigns the installed app identity itself, and returns `{channel,id,result}` or `{channel,id,error}`. The wildcard target is necessary for an opaque-origin sandbox; messages are still source-bound. Replies never include session/CSRF tokens. Reserved app/action fields are assigned after app-supplied arguments so they cannot be overridden. Opaque frames load their own static assets through a scoped 10-minute capability URL issued by POST /api/v1/app-launch. This ticket is limited to that installed app revision's frontend files, is rechecked against the originating session and current installed revision, and does not grant API access. Do not log or share ticket URLs.

Initial actions:

- `theme`: accent/background/foreground values.
- `notify` with `{message}`: requires explicit `notifications` grant.
- `files.list/read/write/mkdir/rename/delete/copy/zip/extract`: requires `user-files` declared and granted. Backend rechecks the grant on every call. Paths are relative to HOME; binary content uses base64. Limits and exclusions are documented in SECURITY.md.

Other third-party actions fail closed. Third-party `network`, `terminal`, `ssh`, `audio`, `system-information` permissions are reserved and cannot currently be granted. Native backend app isolation is future work, not an implied capability of a manifest.

## HTTPS API

- `POST /api/v1/login`: PAM credentials, generic errors, secure session cookie.
- `GET /api/v1/me`: authenticated identity, CSRF token, installed manifests and grants.
- `POST /api/v1/logout`: revoke current session.
- `GET /api/v1/security`: own active sessions/recent events.
- `POST /api/v1/security`: revoke other sessions.
- `POST /api/v1/app-launch`: issue a scoped frontend asset ticket for an installed sandbox app.
- `POST /api/v1/permissions`: grant/revoke supported declared sandbox app permissions; requires the current `revision`. Grants belong to that installed revision and must be approved again after updates.
- `POST /api/v1/rpc`: `{app,action,...arguments}`, bound to session UID and app permissions.
- `GET /api/v1/stream/terminal/<id>`: authorized PTY WebSocket.
- `GET /api/v1/stream/browser/view`: authorized Chromium WebSocket.

Mutations require exact Origin, application/json and X-CSRF-Token. WebSockets require exact Origin, valid session and CSRF query value. Do not log stream query strings. These development interfaces are versioned but not declared stable until the first beta.

## Core workbench RPCs (alpha.3)

These extend the authenticated core API; they are not additional third-party grants.

| Action | Important arguments / result | Capability |
| --- | --- | --- |
| `ssh.list/save` | `hosts`: id, name, host, port, username, group, auth, key, persistent, session; no secret fields | ssh |
| `ssh.import` | name beginning `neon_`, data containing an encrypted OpenSSH private key | ssh |
| `ssh.keys/public` | key filenames/agent fingerprints or public key text | ssh |
| `ssh.unlock/lock` | key, transient passphrase, seconds60–28800; lock removes agent identities | ssh |
| `terminal.create` | kind shell/ssh/text; SSH profile stable id (legacy integer index accepted) | terminal |
| `terminal.list/claim/stop` | id; claim also requires per-view UUID client; list merges retained generations | terminal |
| `session.rename` | id, name | terminal |
| `jobs.create` | name, command, HOME-relative cwd, memoryMiB128–2048; returns id | terminal |
| `jobs.list/log/stop/delete` | own job id where applicable; delete only inactive jobs | terminal |
| `resources.info` | available memory/disk, warnings | system-information |
| `history.list/read/restore` | path, version id; restore requires expected revision and client | user-files |
| `history.settings` | optional value: enabled, exclude patterns, versions1–20 | user-files |
| `document.lease` | path, client UUID, device name; optional takeover/release | user-files |
| `config.get/save` | optional device UUID selects independent desktop config | core configuration |

Terminal streams add `view=<client UUID>`; older clients omitting this remain supported. Background polling sends `X-Neon-Background: 1` so it does not renew web idle expiry. User actions use the normal activity path. Client-selected UID/unit/executable fields never select privileged execution identity. The broker starts a fixed job runner after selecting the authenticated UID; the runner executes the command without root authority.

## Core App Center RPCs (alpha.4)

These actions require core identity `org.neon.applications`; they are not third-party SDK capabilities. Repository URL, commit, package path and scope come from the administrator's validated catalog, never a caller-selected source.

| Action | Arguments / behavior |
| --- | --- |
| `apps.catalog` | Current configured catalog and installed registry for this Linux user |
| `apps.prepare` | `target` (app ID); download/validate a personal candidate and return review metadata plus an expiring token |
| `apps.install` | `target` (app ID), `token`, `expected` (current revision, null for a new app); verify unchanged catalog/installed revision, then activate atomically |
| `apps.cancel` | `token`; discard a prepared candidate |
| `apps.remove` | `target` (app ID), `expected` (current revision); remove only the current user's personal installation |

The sandbox bridge fixes `appRevision` after app-provided arguments. File and notification calls revalidate current registry and grants server-side. Unsupported/removed revisions fail closed. Assets in personal HOME are opened by the UID worker, never directly by the gateway or root broker.
