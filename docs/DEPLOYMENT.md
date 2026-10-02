# Deployment, packaging and recovery

Primary target: Raspberry Pi 5 / Debian 13 ARM64. Other Debian platforms require their own acceptance run. Source packaging does not imply that a clean installation has been verified on every supported platform.

Build as an ordinary development user with `npm ci && npm run build`. Run automated tests before installation. Public release source must include the lockfile, tests, deployment units and documentation; exclude generated private state.

The installer targets `/opt/neon-desktop`, creates a locked service account `neon-gateway`, installs four unit definitions and a PAM service, and configures a dedicated Caddy origin. Installed code is root-owned. Site origin is not embedded into the source repository. Install the pinned, root-owned Python runtime first with `sudo python3 scripts/install-python-runtime.py`. It uses `deploy/python-runtime.txt` in an isolated environment; system Python remains distribution-managed. Third-party JavaScript dependencies and their licenses are retained in the release installation.

## Services

- `neon-broker.service`: privileged authentication/lifecycle boundary, Unix socket only.
- `neon-gateway.service`: unprivileged loopback API, TCP8780.
- `neon-worker@UID.service`: started after successful login when needed, filesystem/config/PTY worker.
- `neon-browser@UID.service`: on-demand Chromium, own cgroup and profile.
- `caddy.service`: HTTPS and HTTP-to-HTTPS redirect.

Browser limit: MemoryHigh1GiB, MemoryMax1536MiB, MemorySwapMax256MiB, CPUQuota150%, TasksMax160. Worker limit: MemoryHigh1GiB, MemoryMax2GiB, MemorySwapMax256MiB, CPUQuota200%, TasksMax128. These limits are per user, not global admission control. On an 8 GiB Pi, aggregate multi-user admission still needs implementation before wider deployment.

## HTTPS

Private-IP installation uses `tls internal`. Public certificate: `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`. Install this CA on client devices through their trusted certificate store after checking its fingerprint via the administrator. Never export root.key or the Caddy data directory. Browser acceptance tools may explicitly accept this private test CA; command-line TLS verification should use `curl --cacert` without `-k`.

The installer does not overwrite the firewall. Add LAN-scoped TCP 443, optionally TCP 80 for redirects. Never expose 8780 or internal Unix sockets. SSH/firewall/router administration remains outside user Settings.

## Checks

```sh
systemctl status neon-broker neon-gateway caddy
systemctl --failed
/opt/neon-python-3.14.3/bin/python -m unittest discover -s tests -v
npm test
```

`scripts/acceptance.mjs` performs graphical login and actual files/PTY/browser checks. It reads the password from stdin; disable terminal echo before entering it, and restore afterward. Artifacts are private and gitignored. `tests/live_isolation.py` requires root and uses a temporary Linux account, removed in finally. Run only on a development host.

## Updating

The first installer intentionally refuses an existing installation. Use the immutable updater described in [UPDATES.md](UPDATES.md); review changes before deployment. Preserve `/etc/neon-desktop`, user configs/profiles, and `/var/lib/neon-broker`; do not copy these into release archives. Gateway/broker restarts disconnect streams but do not kill worker PTYs. Worker/browser restarts terminate their processes; obtain authorization for active jobs first.

## Removal / rollback

Stop and disable gateway/broker before removing application files. Enumerate active worker/browser units and terminate them only during an approved maintenance window. Restore the reviewed Caddy backup and remove only this project's firewall rules/PAM file/units. Do not delete user HOME/config/browser data by default. Never use a blanket recursive deletion of `/home` or unrelated services. Original host OS/storage security remains separate from this app.

## Raspberry Pi memory controller and runtime

Before installation, confirm that `/sys/fs/cgroup/cgroup.controllers` includes `memory`. Some Raspberry Pi OS images disable it through firmware defaults. If absent, back up the existing `/boot/firmware/cmdline.txt`, append `cgroup_enable=memory` on its existing single line without replacing root/boot parameters, reboot during a maintenance window, and check again. The installer and broker refuse operation without the controller. After starting a browser, inspect the actual service cgroup memory.high, memory.max, memory.swap.max and memory.events files.

Node must be a supported LTS runtime >=22.12; the development deployment uses an official Node 24 distribution. If installed outside APT, its security updates require explicit maintenance. Chromium remains APT-managed. The pinned aiohttp runtime now requires reviewed dependency updates and a new runtime path when its version changes; occupied processes retain their old code until retired. Never disable the Chromium sandbox to work around deployment problems.

The current installer is a first-install utility, not an upgrade manager. A clean source unpack/build was checked on the development host; installation on a second pristine OS is still a release gate.
