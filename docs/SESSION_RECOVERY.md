# Disconnect, logout and session recovery

## Expected behavior

| Event | Server-side behavior | Returning to the desktop |
| --- | --- | --- |
| Client internet loss or broken WebSocket | Local shells, their jobs, SSH clients and Chromium continue | Terminal/browser views retry automatically with bounded backoff |
| Browser tab/window closed | Server processes continue | Sign in/open the desktop again; saved windows reattach |
| Sign out or web-session expiry/revocation | Access is revoked; processes are not stopped | Authenticate again; expired access can be renewed in place without replacing the current document |
| Terminal app window closed | Detach only; do not send hangup | Use Sessions in the menu bar to select a running terminal |
| Stop process / shell exit | That terminal ends | All views of that terminal close, including taskbar and saved layout entries; recovery never substitutes a new shell for the old ID |
| Browser End session | Chromium closes | Opening a browser again creates a new process |
| Pi reboot, power loss, worker/browser crash or resource-limit kill | Affected processes terminate | Recovery restores UI, not dead processes; missing terminals and changed browser instances are reported |

There is no automatic disconnected idle shutdown for Chromium. Existing CPU/memory/task limits still apply. Closed app windows do not release server resources until the user explicitly ends their processes. Retention does not disable authentication, expiration, CSRF, Origin checks or UID isolation.

The SSH connection originates on the Pi. Losing the connection between the client device and Neon does not close that SSH connection. If the Pi itself loses its connection to the remote SSH host, normal SSH transport limitations still apply. Long-running remote jobs that must also survive that failure need a session supervisor on the remote host, such as tmux, or an appropriate remote job service. Neon does not silently install or alter remote-host software.

## Terminal history and discovery

Sessions lists only running terminal/SSH sessions, with a direct Stop button per row. Successfully stopped sessions disappear immediately; the open list refreshes every two seconds to remove sessions that ended elsewhere. Jobs & Sessions also hides ended terminals. Closing the picker stops its refresh timer. Stopping a session also closes its open desktop windows, including minimized views. Connected views on other devices close on the server end notification; disconnected views reconcile when they reconnect. Natural shell exit has the same effect. A temporary connection failure alone does not close a window. Reattaching uses the existing ID and does not launch another shell. Terminal input is not buffered/replayed automatically while disconnected, avoiding duplicate commands. The worker retains the most recent 256 KiB of terminal output per session, not an unlimited durable job log. Up to eight live terminals and a bounded recent-ended history are retained per worker. Write long job logs to a file when the complete output matters.

Disabling saved window layout recovery does not stop or hide the server session registry. A foreground job finishing can return to its existing shell; the session will still be listed as running because its shell remains alive. Read its output or job log to determine job completion.

## Editor drafts and desktop state

The editor writes recovery snapshots in `~/.config/neon-desktop/editor-<uuid>.json` using the existing secure HOME API. These are private mode0600 files. Dirty/untitled text, document paths, original revision and selected document are retained. Clean documents are reread from their real files. Recovery does not overwrite project files; Ctrl+S remains explicit. Existing content-revision checks still protect ordinary conflicting saves.

Drafts are debounced by about700ms and limited to14MiB per editor window. Sign out flushes draft and layout writes before revoking the cookie. If a draft cannot be saved, sign out displays an error and keeps the document open; save large documents before retrying. Failed writes retry when connectivity/authentication returns. Pending unsent changes trigger the normal browser leave-page warning.

No server can receive edits made while the client is disconnected. Keep that page open until connectivity returns. Closing it, crashing the client, or losing power before a draft reaches the server can lose the latest unsent changes. The server recovers the last successful snapshot. Explicitly discarding an editor window removes that window's recovery snapshot.

Most frontend app windows are reconstructed from saved state after a browser document closes. This does not mean third-party frontend JavaScript keeps executing without a client. Apps with independent background jobs need a supported server-side runtime and their own recovery contract; arbitrary third-party backend execution is not enabled in this alpha.

## Updating an already running alpha.1 browser

The new browser controller has no idle termination timer. Do not restart a live older browser just to load the change. `scripts/retain-browser.py ORIGINAL_NODE_PID`, run as the browser's Linux user, is a one-time migration bridge: it sends browser.info through that user's private Unix socket once per minute and exits when the original socket peer/PID disappears or changes. It cannot start a browser, select another user or keep a replacement process alive. Fresh installations do not need this bridge.

## Verification

`tests/live_persistence.py HTTPS_ORIGIN CONTROLLER_LINUX_USER` runs as root on a development host. It creates/removes a disposable PAM account and loopback-only SSH/HTTP fixtures, without changing the installed SSH daemon's policy. The controller user needs access to the checkout and its dependencies. A generated password is supplied only through subprocess stdin, never an argument or file.

The installed graphical test checks forced client network loss, stable local PTY, actual OpenSSH job completion after logout, unsaved editor recovery, in-place login after revocation, identical Chromium PID/URL, detached-session reattachment and honest ended-session status. It terminates only its own disposable-account processes during cleanup. Unit tests additionally cover reconnect authentication rotation, missing-process refusal and closing a window during attachment.
