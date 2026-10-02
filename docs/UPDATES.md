# Immutable updates and rollback

Build/test the checkout as its ordinary owner first. From a trusted administrative SSH session:

```sh
sudo python3 scripts/update-release.py --status
sudo python3 scripts/update-release.py --source /absolute/path/to/neon-desktop
```

The tool stages root-owned immutable code beneath `/opt/neon-desktop/releases`, compiles the two helpers, creates a generation-specific worker template, and atomically switches `/opt/neon-desktop/current`. It checks gateway/broker readiness and restores the previous pointer if activation fails. Only the gateway and broker restart; client streams briefly reconnect. User workers, PTYs, background-job cgroups and Chromium are not stopped. Existing workers continue using their original code and private socket. New sessions use the current generation; the registry routes older terminal IDs to their original worker.

The first upgrade captures the previous installation as a registered baseline. Site configuration, HOME files and security/session databases are not copied into release directories. Do not edit a staged release or point `current` at an unregistered directory. Old releases are retained because a worker/job/browser can still be executing them. Automatic removal is intentionally not provided.

To defer when any managed jobs/terminals remain, add `--wait-idle`. An unresponsive worker also defers, because the updater cannot prove it is idle. It exits without stopping work; retry after jobs finish. This is a one-shot maintenance command, not an automatic update scheduler. Browser processes are preserved even during an idle update.

```sh
sudo python3 scripts/update-release.py --rollback RELEASE_ID_FROM_STATUS
```

Rollback is conservative: it defers while any managed terminal/job is live or a worker is unresponsive, because an older API may not understand newer terminal IDs. It switches frontend/gateway/broker only and retains worker/browser processes. Gateway activation failure restores the prior pointer. Rolling back code does not roll back user files, job logs or configuration formats. Keep independent backups before future schema migrations. No destructive schema migration is part of alpha.3.

A process-preserving deployment and idle/rollback refusal can be verified while real work runs. Performing an actual rollback requires an idle opportunity; never terminate a user's jobs just to test it. Fresh installation and upgrade from this host's earlier alpha are distinct acceptance targets.
