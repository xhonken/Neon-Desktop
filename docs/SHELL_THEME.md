# Shared Bash appearance

Neon provides a mint/cyan Bash prompt and an N/ welcome mark. Mint is the desktop accent `#65e6ad`; cyan, pale text and muted grey match the dark desktop. The theme uses Bash builtins and makes no network, Git or system-information calls at each prompt.

The first-install utility enables it. On an existing Debian installation, run from the trusted project checkout:

```sh
sudo python3 scripts/install-shell-theme.py
```

The helper installs root-owned `/etc/neon-desktop/bashrc` and one managed source block in `/etc/bash.bashrc`. It validates Bash syntax, writes files atomically and saves previous system files under `/root/neon-shell-backups/`. Repeating the installation is a no-op when files match. Personal `.bashrc` and `/etc/skel` files are not changed: Debian's system Bash startup already applies to both existing and future accounts.

Open a **new terminal** to see the result. Existing terminal processes, including detached jobs, are not restarted. Reconnecting to a running terminal replays its existing output; it does not create another banner. The theme also applies to interactive Bash over SSH on this host. Other remote hosts keep their own shell appearance.

Only interactive Bash with a terminal, a normal UID (at least 1000) and HOME beneath `/home` is themed. Root/service shells, scripts, non-interactive SSH commands and file transfers receive no extra output. Root keeps its normal `#` prompt. Other shells such as zsh/fish are unaffected.

The prompt shows the Linux username, hostname and current directory, followed by `N/ $` on the next line. Nonprinting color sequences are marked for Readline. True-color terminals use the desktop palette, with 256/16-color fallbacks. Narrow terminals use a one-line welcome mark. `NO_COLOR` disables theme colors; `TERM=dumb` also suppresses the banner. This does not change the terminal emulator's background or palette, nor the desktop's per-device accent setting.

The prompt hook runs after the personal startup file, so Debian's default prompt cannot overwrite the shared theme. Existing `PROMPT_COMMAND` hooks are retained and the previous command's exit status is preserved. A personal startup file that deliberately replaces `PROMPT_COMMAND` can replace the theme too.

Put either of these preferences in your own `~/.bashrc` before opening the next terminal:

```sh
NEON_SHELL_BANNER=0   # Keep the prompt, hide the welcome mark.
NEON_SHELL_THEME=0    # Keep your own prompt and hide the welcome mark.
```

No aliases, PATH, permissions, sudo policy or history settings are changed. The shared theme is a host configuration addition: core release rollback does not roll back `/etc`. Re-run the helper from the desired checkout when changing the theme on an existing installation, or remove only the marked source block to disable it system-wide. Do not overwrite a newer `/etc/bash.bashrc` wholesale from an old backup.
