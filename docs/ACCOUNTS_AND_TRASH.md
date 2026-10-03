# Accounts, browser logins and Trash — alpha.7

## Personal files

Files → Delete moves files or entire folders to the user's private Neon Trash. Open Trash from Files or Applications to restore, restore under another HOME-relative name, delete selected entries permanently, or empty it. Restoring never overwrites an existing path. If the original parent has disappeared, choose an existing alternative parent. Terminal `rm` and external programs do not use this trash automatically. This is Neon's own recovery store, not a claim of interoperability with every freedesktop desktop trash implementation.

Trash data and recovery records live in `~/.local/share/neon-desktop/trash`, owned by the user with private directory permissions. Files keep occupying disk until permanently deleted. No automatic expiration or quota is introduced. Recovery metadata is written before the atomic move; a failed partial purge retains the recovery record for remaining data. Empty interrupted records may require manual housekeeping. Backups remain separate from Trash.

Files Copy/Paste now handles complete folders and preserves regular-file execute permissions. The clipboard works between Files windows in the current desktop. Name conflicts offer a new name or skip; the server also enforces no-overwrite atomically. Destination directories remain private. Copy follows no symlinks or mount crossings and rejects hardlinks, special files and dedicated key directories. Each copied tree is bounded to 1 GiB, 20,000 entries and depth64; use the terminal for larger or unsupported trees. A failed copy cleans its staging directory and does not replace the destination.

The progress dialog shows completed selected items plus current-copy entries/bytes. Hide closes the dialog while the server operation continues. Completed earlier items in a multi-item batch remain completed if a later item fails. Operations are serialized per current user worker; they are not persistent jobs across worker death/reboot. A core version switch may make the old progress record unavailable while its retained worker finishes. Refresh the directory to inspect the result. File views and user processes are not terminated by browser sign-out.

## Administration

The core Administration app is visible to eligible local Linux users with active sudo-group membership. Its server API independently checks this on each request. Supported actions are list accounts, measure HOME disk usage, create standard users, lock/unlock accounts, reset passwords and explicitly add/remove sudo. It does not delete accounts or expose other users' file contents. Disk measurement runs inside the target user's unprivileged worker, uses one filesystem, and caches successful results for60seconds. Unreadable files or time limits produce an error rather than a fabricated total.

New accounts get a private HOME (0700), Bash, a private primary group and no supplementary sudo membership. A username cannot choose arbitrary UID, shell, HOME or command flags. Each sensitive action requires the acting administrator's current password through PAM. Root/system accounts and self-lock/self-sudo changes are rejected; the actor therefore cannot remove their own remaining administrative access through this API. Creation with an unsuccessful password assignment leaves a locked account for explicit reset/unlock. Administrative events are recorded without passwords in the broker audit and system journal.

Lock combines password locking and account expiry to deny new PAM logins, including SSH keys when PAM account checks apply. Unlock restores the recorded prior expiry/password-lock state, bound to the UID and HOME inode. Accounts locked outside Neon require administrative SSH review. Resetting a password keeps a locked account locked. Locking/revoking web access does not terminate existing terminals, SSH connections or jobs. Sudo removal affects new logins; existing Linux processes retain their supplementary groups. External SSH allowlists are a separate host policy and are not edited by the app.

## My account

Settings → Account (Mitt konto in Swedish) changes the user's own Linux password and lists active web logins with reported browser/OS, source address and last activity. Each web login can be revoked individually; another user's login cannot be revoked by supplying its ID. Browser information comes from User-Agent and is descriptive, not proof of device identity. Older logins may lack browser metadata.

Password changes require the current password and a new password entered twice. The server requires at least12characters, no control characters and at most1024UTF-8bytes, then uses the OS PAM-backed chpasswd operation. Passwords travel through HTTPS/private sockets/stdin, never command arguments, user preferences or logs. All old web cookies become invalid after a password change; sign in again to reattach existing work. No Linux process is killed. See [Debian chpasswd documentation](https://manpages.debian.org/trixie/passwd/chpasswd.8.en.html).

## Privileged boundary

The ordinary gateway and user terminal gain no extra privilege. `neon-accounts.service` is a separate root service with a root-only Unix socket and SO_PEERCRED check, a bounded JSON request, fixed operation/argument lists, PAM confirmation, rate limits, a mutation lock, disabled core dumps, a restricted capability set and no IP sockets. It may write `/etc`, `/home` and its private state because local account tools require atomic password/group updates and HOME creation. The broker remains read-only over HOME and system configuration and supplies the actor from its authenticated session, never from a client-selected UID. Third-party app capabilities do not grant account administration.

The updater installs/enables this service, restarts only authentication services and preserves worker/browser/job processes. Rollback to code without account support disables the account service; it does not undo Linux account changes, restored/deleted files or schema additions. Keep private system-state backups. Local shadow-backed Debian accounts are the supported identity model; other PAM/NSS setups need their own design and acceptance.

## Verification

Automated tests cover descriptor-relative copy/trash/restore, conflicts, unsafe nodes, partial-purge discoverability, reserved paths and account-input boundaries. `tests/live_accounts.py HTTPS_ORIGIN [CA_FILE]` is a root-only disposable-account acceptance suite covering actual PAM/admin/ordinary-user access, no default sudo, explicit grant/revoke, locks/reset/unlock, self-password change, individual browser revocation and installed file operations. Run only on an authorized test host. GUI acceptance additionally exercises the real credential dialogs and recovery views. These are bounded tests, not an independent security certification.
