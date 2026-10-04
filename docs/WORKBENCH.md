# Jobs, connections and safe maintenance

## Saved SSH connections

Open **Terminal → SSH connections** or launch **SSH Connections**. Choose **New connection**, then enter a friendly name, host/IP, port, remote Linux username and optional group. Choose an authentication method and **Save & connect**. Saving or deleting a profile does not terminate established sessions.

- **SSH key** selects a private key in your own `~/.ssh`. Use **Keys & unlock** to import a passphrase-encrypted OpenSSH private key, display its public key, or unlock it for 1, 4 or 8 hours. Install the public key on the remote account through your usual trusted administration process. A username is still required: a passphrase unlocks a key; it is not a username or private key.
- **Password** asks inside the SSH terminal on each new connection. Passwords are not saved.
- **Default SSH keys / interactive login** uses the system OpenSSH defaults, with no user SSH config execution. Advanced SSH config/ProxyJump workflows remain available through a normal terminal.

Profile JSON stores metadata and a key filename, never passwords, passphrases or private-key contents. Imported private keys must be encrypted OpenSSH keys and use a new `neon_…` name; they are stored as mode0600 beneath your mode0700 `.ssh`. Other pre-existing key formats can be selected, but GUI import only accepts the encrypted OpenSSH format.

Unlocking sends the passphrase over the authenticated HTTPS API and a short-lived private Unix askpass channel. It is never saved in a profile, temporary file, process argument or environment variable. The unencrypted key is held in your own SSH agent's memory until its TTL expires or **Lock all keys** is used. This permits automatic key authentication while unlocked. Signing out does not lock the agent, since background SSH connections must remain usable; lock explicitly when needed. Locking/expiry prevents future agent authentications and does not end existing SSH sessions. After worker restart/reboot/new runtime generation, unlock again. Same-Linux-UID processes share that user's security authority.

New SSH host keys require confirmation in the real terminal. Changed host keys are refused. Verify the new fingerprint through a trusted channel before changing `known_hosts`; the UI deliberately has no bypass button. Agent forwarding and SSH forwarding are disabled for saved profiles.

## Remote persistence with tmux

Enable **Keep remote session with tmux** and choose a session name. The remote computer must already have `tmux` installed; Neon does not install software remotely. Connection runs `tmux new-session -A -s NAME` under the selected remote account.

A client-browser disconnect or web logout leaves the Pi's SSH process running. If the SSH connection itself fails, reconnecting the profile reattaches the named remote tmux session. This protects remote jobs against that transport loss, provided the remote machine and tmux server remain running. Remote reboot/power loss is not process recovery. Local Pi reboot also ends local terminals, agents and local background jobs.

## Jobs & Sessions

The menu-bar **Jobs** button opens this application. It lists retained terminals from older and current runtimes, including friendly names, remote host, start time where available, process memory and running/ended state. A terminal being alive does not mean that its most recent shell command is still running. Terminal memory is the shell/SSH process RSS, not a sum of all descendants. Explicit **Stop process** requires confirmation.

**New job** starts a named program in a HOME-relative directory. Enter a program plus quoted arguments. There is no implicit shell expansion, redirection or pipe interpretation; save a script and run `bash script.sh` for those workflows. Do not put credentials into command arguments; the command is part of the private job record.

Jobs run as the authenticated Linux UID in separate systemd cgroups: selectable 128–2048MiB RAM, 128MiB swap, 150% CPU, 96 tasks, no new privileges and no capabilities. HOME and a private temporary directory are writable; protected system paths are read-only. The broker launches a fixed installed runner, never an arbitrary root command. Admission checks leave existing work alone when free RAM/disk is low; at most six active managed jobs globally reserve at most half physical RAM. These are admission/resource safeguards, not a complete hostile-user quota system. User terminal commands still have the worker's shared limits.

Job records and the last 4 MiB of each output log live in private HOME storage and survive web logout and server reboot. Up to 100 retained job records are allowed. Completed jobs retain exit status; a reboot/kill without a final runner result is reported as interrupted. Jobs are not automatically restarted after reboot. Remove completed jobs explicitly. Completion notifications appear while Jobs & Sessions is open; they are not external push/email alerts. Refresh log retrieves the latest retained output.

## Multiple devices and views

Open windows are saved in an account-wide workspace and restored on another device after sign-in. Terminal IDs, editor recovery state, geometry and minimized/maximized state follow the user; geometry adapts to the new screen. Device appearance/preferences remain separate. Existing layouts migrate once from the most recently saved device layout. Window changes merge by stable IDs so an unchanged older view cannot overwrite the whole workspace. Recovery remains optional; closing a terminal window still detaches its process.

Terminal sessions have one controlling view. Clicking inside a terminal window takes input/resize control and focuses it without reconnecting its output stream. Keyboard focus or typing in a view also requests control. Characters typed while the claim is completing are sent in order; disconnected input is discarded. Current workers notify other views when control changes. Retained older workers remain usable through their existing claim API; an update preserves their processes.

Code files have a short renewable editing lease. Another view opens read-only; **Take editing control** transfers editing. Revision checks still reject stale saves. Each editor view writes its own recovery draft so it cannot overwrite another view's unsaved draft. These are cooperative same-account safeguards, not a security boundary against that same Linux user's SSH/terminal processes.

## File history

The Code application's **History** button lists earlier saved versions, shows previous/current text side by side, and restores a chosen version. A restore checks the current revision and preserves the current saved file first. It replaces unsaved text in that editor only after confirmation.

History captures files overwritten through the file API; it is not a watcher for edits made through SSH or arbitrary terminal tools. Defaults: ten versions per file (configurable to 20 by API), 4 MiB per version, 64 MiB total, oldest versions pruned. Internal `.config`/`.local` state is excluded. `.env*`, private-key-like names and secret/credential patterns are excluded by default. Review **History preferences / exclusions** for your projects. Existing versions are not purged merely by adding an exclusion. Binary/non-UTF8 data is not shown as a text comparison. This same-disk history does not replace backups.

## Acceptance commands (development hosts only)

The installed tests create disposable Linux accounts and isolated loopback SSH fixtures. Run as root through administrative SSH, with an existing non-root account as the Chromium test controller:

```sh
python3 tests/live_workbench.py https://YOUR_SERVER_IP CONTROLLER_USER
python3 tests/live_workbench.py https://YOUR_SERVER_IP CONTROLLER_USER editor
python3 tests/live_persistence.py https://YOUR_SERVER_IP CONTROLLER_USER
python3 tests/live_isolation.py https://YOUR_SERVER_IP REFERENCE_USER
```

The workbench fixture requires `python3-cryptography` and `tmux` on the development host. Generated test passwords/passphrases are passed in memory/stdin and not saved. The fixture's temporary SSH daemon listens only on loopback and does not change the normal SSH policy. Cleanup stops only the disposable account's processes. Puppeteer accepts the test certificate; separately verify the installed HTTPS URL using the public deployment CA, as described in DEPLOYMENT.md.
