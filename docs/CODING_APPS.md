# Codex and Qwen Coder

These optional administrator-installed applications open as separate Neon Desktop
windows. Each offers a HOME project folder picker, a new session and a saved
session picker. The interactive interface is the official CLI running in the
authenticated Linux user's persistent PTY. Coding takes place on the Neon host.

Codex also offers **Sign in to Codex** using device-code authentication. Complete
the printed link/code in your own browser; device authentication may need to be
enabled in your ChatGPT account or workspace. The terminal's HTTPS links are
clickable. Each user signs in separately; installing the software globally does
not share a subscription, identity, files, history or credentials.

Closing a window and web logout detach the view and retain its process. **Server
sessions**, quick-open and **Jobs & Sessions** reopen coding sessions in the
appropriate application. **Stop process** ends the selected session. A machine
reboot/process failure still ends it; saved CLI history can be resumed separately.

## Credential storage

The Codex launcher forces `cli_auth_credentials_store="keyring"`. The initial
terminal prompt creates an encrypted GNOME login keyring with a nonempty password
chosen by the user. Unlock it again after a host restart or when it is locked.
Forgotten keyring passwords cannot be recovered by Neon. Existing credential
files from independent CLI installations are not imported or copied.

The app uses a dedicated per-UID Secret Service bus/control directory beneath
`~/.cache/neon-codex-keyring` (0700) and encrypted keyrings beneath
`~/.local/share/neon-codex-keyring` (0700). The same user's coding sessions share
the unlocked service. User-chosen passwords are read with hidden terminal input,
passed over stdin and never stored by the launcher. No shared authentication key
or plaintext `auth.json` fallback is configured. Other processes belonging to
the same Linux UID can access its unlocked keyring; root remains an OS trust
boundary. This is not a general Neon credential API.

Qwen uses the administrator's model endpoint with a non-secret placeholder API
key for a loopback model connection. It stores sessions in the user's own
`~/.qwen`, with restrictive permissions. Automatic background memory/dream/skill
jobs, telemetry and CLI self-updates are disabled in the managed defaults to
preserve capacity on a shared local model. Normal project instructions and saved
sessions remain available. The default approval mode requires approval for
edits/commands. Codex defaults to workspace-write with on-request approval;
neither launcher enables unrestricted automatic approval.

## Host installation

These apps are hidden when `/etc/neon-desktop/coding-apps.json` is absent or the
corresponding `enabled` entry is false. A core upgrade alone does not install or
enable them on other hosts. App Center frontend-only packages cannot execute
these native programs; they are shipped trusted modules with fixed worker
launch actions. No arbitrary executable is accepted at the root broker boundary.

On an explicitly selected host, install the official packages to a versioned,
root-owned directory (example tested versions; review updates independently):

```sh
sudo apt install gnome-keyring dbus-bin libglib2.0-bin libsecret-1-0
sudo install -d -m 0755 /opt/neon-coding-tools/codex-0.160.0-qwen-0.24.7
sudo env PATH=/opt/neon-node/bin:/usr/bin:/bin npm install --ignore-scripts --no-fund --prefix /opt/neon-coding-tools/codex-0.160.0-qwen-0.24.7 @openai/codex@0.160.0 @qwen-code/qwen-code@0.24.7
```

Use umask 022 for this shared package installation. Verify package versions and
the native ARM64 executable before selecting the `current` symlink. Qwen's
bundled `vendor/ripgrep/arm64-linux/rg` needs mode0755 when npm scripts are
disabled. Other installed files should be root-owned, not user-writable.

Then configure a loopback endpoint provided by an authenticated model tunnel:

```sh
sudo python3 scripts/configure-coding-apps.py --qwen-base-url http://127.0.0.1:18080/v1 --qwen-model qwen3-coder-next
sudo python3 scripts/update-release.py --source "$PWD"
```

The helper enables both apps, writes non-secret host configuration and shared
Qwen defaults, and installs `neon-codex` / `neon-qwen-coder` launchers. All eligible
Neon users receive the apps. The standard immutable updater preserves occupied
workers and coding sessions. No reboot is required. Keep model addresses, tunnel
keys and deployment credentials outside the public source repository.

The Qwen app checks `/models` for the configured model and shows an unavailable
state if the server or tunnel is offline. Do not expose an unauthenticated model
port publicly. Provision a separate, tightly restricted forward-only SSH key
when connecting a remote loopback-only model. Model capacity and queueing are
shared, even though CLI accounts/projects remain separate.

## Validation and limits

Run the ordinary Python/JavaScript/build checks. The root-only
`tests/live_coding_keyring.py` uses disposable Linux users and synthetic secrets
to test actual encrypted keyring storage/lock/unlock, real Codex credential-store
integration without `auth.json`, and cross-user socket denial. It does not sign
in to a real OpenAI account or call a paid model. Real application acceptance must
use the installed HTTPS desktop and prove UID, selected directory, persistence,
actual terminal rendering and model access where available.

`tests/live_coding_apps.py HTTPS_ORIGIN CONTROLLER_USER` performs that installed
graphical acceptance with disposable PAM accounts. It checks the real Codex
welcome screen and encrypted-keyring setup without starting an account login,
project paths with spaces, process UID/cwd, reload/logout persistence, account
isolation and Qwen's current availability state. It removes only its own users
and processes.

Authenticating a personal ChatGPT account and executing a real Codex task require
that user's account access. Qwen inference requires a running configured model.
Neither a CLI version check nor mocked model traffic proves real model inference.

Sources: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli),
[Codex authentication](https://learn.chatgpt.com/docs/auth),
[Qwen model providers](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/model-providers.md).
