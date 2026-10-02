# Desktop foundations (alpha.6)

The menu bar identifies the authenticated server with its hostname and a stable default accent color. A personal accent in Appearance overrides that default. The server name comes from the broker, not a editable URL label.

Terminal windows and taskbar entries show the session name and local/SSH host. Rename from the toolbar, double-click the title, or focus the title and press Enter/F2. The server stores the name for Sessions and future reattachments. Files windows show the current directory.

Use **Ctrl+K** (or the Quick open button) to search applications, open windows, saved SSH profiles and running sessions. Arrow keys move between results, Enter opens, Escape closes. Opening an existing window/session reuses it. Creating a new SSH connection still uses the existing OpenSSH verification and credential flow.

Right-click empty desktop space, press Shift+F10 while the desktop is focused, or click the server name for New terminal, Open home folder, Create shortcut, Change background and Arrange windows. Shortcut selection uses the installed application registry. Arrange tiles visible windows; existing minimum sizes still apply. Context menus and dialogs remain inside the viewport, and the desktop follows the actual menu bar height on narrow displays.

Files offers **Open terminal here** for the current folder and through the file/folder context menu. The worker opens the requested HOME-relative directory through the same descriptor-relative policy as Files, then starts the user shell in that directory. It does not paste a `cd` command, follow symlinks or interpolate filenames into shell code.

Notifications keeps the latest 100 messages in the current desktop document, with timestamps and unread count. Upload completion opens its folder; observed background-job completion/failure opens the job details; SSH end notices open Connections. Job status is observed every ten seconds without renewing authentication idle time. The center is not a durable audit log: reload/logout clears it, and events that occur entirely while the desktop is closed are not retroactively discovered. Persistent job records remain in Jobs & Sessions.

Settings → Language & Region selects English or Swedish for desktop menus, Settings navigation and shared dialogs. App-specific text, descriptions and Linux/SSH output may remain English; this is the initial translation boundary. User filenames and terminal output are never translated. Language and other desktop preferences remain private per user/device. Visible focus outlines, arrow navigation and responsive toolbars support keyboard and small-screen use; a full assistive-technology/mobile audit remains a release gate.
