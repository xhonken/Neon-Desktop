# Application manifest and API v1

The registry reads root-owned `apps/<id>/manifest.json`. Categories come from manifests. Applications cannot automatically pin themselves; users explicitly pin and reorder them.

See `examples/org.example.hello` for a frontend-only sandbox package. It is a development fixture, not a bundled optional application. Install on a test instance using:

```sh
sudo python3 scripts/app-install.py examples/org.example.hello
sudo systemctl restart neon-broker
```

Broker restart disconnects streams, while worker processes continue. Schedule it when appropriate. Reload the desktop to discover new manifests. Uninstallation/update UI belongs to the later Administration application; normal user Settings does not acquire OS privileges.

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

The parent verifies the sending frame's WindowProxy and opaque origin, assigns the installed app identity itself, and returns `{channel,id,result}` or `{channel,id,error}`. The wildcard target is necessary for an opaque-origin sandbox; messages are still source-bound. Replies never include session/CSRF tokens. Reserved app/action fields are assigned after app-supplied arguments so they cannot be overridden. Opaque frames load their own static assets through a scoped 10-minute capability URL issued by POST /api/v1/app-launch. This ticket is limited to that installed app's frontend files, is rechecked against the originating session, and does not grant API access. Do not log or share ticket URLs.

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
- `POST /api/v1/permissions`: grant/revoke supported declared sandbox app permissions.
- `POST /api/v1/rpc`: `{app,action,...arguments}`, bound to session UID and app permissions.
- `GET /api/v1/stream/terminal/<id>`: authorized PTY WebSocket.
- `GET /api/v1/stream/browser/view`: authorized Chromium WebSocket.

Mutations require exact Origin, application/json and X-CSRF-Token. WebSockets require exact Origin, valid session and CSRF query value. Do not log stream query strings. These development interfaces are versioned but not declared stable until the first beta.
