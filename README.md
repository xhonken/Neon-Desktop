# Neon Desktop

An independent Linux web desktop for Raspberry Pi 5 and Debian ARM64. Sign in with a Linux account and work in your actual HOME directory through a persistent, dark desktop.

**Early development alpha — not a production release.** The first installed alpha has passed real PAM, filesystem, terminal, browser and user-isolation acceptance on Raspberry Pi 5. See [implementation status](docs/STATUS.md) for scope and remaining work. This project is independently implemented; it is not a Pi-2000 fork, redesign or compatibility layer.

## Design

- Caddy HTTPS → unprivileged aiohttp gateway → local PAM/session broker → workers running as the authenticated Linux UID.
- Linux accounts and files are authoritative. No duplicate user-password store or filesystem database.
- Plain JavaScript modules, Bootstrap 5.3.8, CSS variables, xterm.js and CodeMirror 6. Node.js builds client assets and hosts the Chromium controller; there is no React/Vue runtime.
- Manifest-driven applications, movable/resizable windows, per-user desktop recovery and preferences.
- Third-party frontend apps run in opaque-origin iframes with a versioned capability bridge. Backend plugins are not enabled.

## Develop on Debian ARM64

Use a dedicated development system. System dependencies:

```sh
sudo apt-get install caddy python3-aiohttp python3-venv libpam0g-dev gcc nodejs npm chromium w3m git
node --version # Supported Node LTS >=22.12, recommended 24
npm ci
npm run build
python3 -m unittest discover -s tests -v
npm test
```

The lockfile pins the dependency graph. Dependencies are served locally; the desktop has no runtime CDN requirement. CodeMirror and terminal modules are lazy-loaded.

## Install

Read [deployment](docs/DEPLOYMENT.md) and [security](docs/SECURITY.md) first. Installation modifies PAM/service/Caddy configuration and requires root. Do not use a development checkout writable by an untrusted account as installation input.

```sh
sudo python3 scripts/install.py --origin https://YOUR_SERVER_IP --replace-caddy
```

On Debian installations with an older Node runtime, install an official Node 24 LTS distribution and pass `--node /absolute/path/to/node` to the installer. Verify the archive against the official SHASUMS256.txt.

`--replace-caddy` is appropriate only on a dedicated host after reviewing/backing up its existing Caddyfile. The installer backs it up. It deliberately refuses to overwrite an existing Neon installation or restart user workers automatically.

Allow TCP443 from the intended client network in the host firewall. TCP80 may be allowed for HTTPS redirects. Caddy's private CA must be trusted on each client when using an IP address; do not publish the CA private key. A domain/publicly trusted certificate can be configured separately.

Open `https://YOUR_SERVER_IP/` and sign in with an existing eligible Linux account (UID≥1000, HOME below `/home`, interactive shell in `/etc/shells`). Root and service accounts are rejected. Accounts remain managed by Linux, not by the web application.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security and threat boundaries](docs/SECURITY.md)
- [API and application SDK](docs/APPLICATIONS.md)
- [Deployment and recovery](docs/DEPLOYMENT.md)
- [Disconnect, logout and session recovery](docs/SESSION_RECOVERY.md)
- [Status and release gates](docs/STATUS.md)
- [Changelog](CHANGELOG.md)

Public release artifacts must exclude credentials, site configuration, HOME data, browser profiles, session databases, logs and local acceptance screenshots. A source release can be built with `python3 scripts/package.py` after tests/build. GitHub publication is a separate owner decision.
