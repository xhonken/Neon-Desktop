# App Center and Git package distribution

Alpha.4 provides the installation system for future apps. No public catalog/repository or optional app is invented or published by the core installer. An unconfigured installation shows an honest empty Catalog; built-in apps remain visible under System apps / All installed.

## Two installation scopes

- **Personal (`user`)**: select Install for me in App Center. Files are installed beneath your HOME; only you discover/launch this installation. You can update or uninstall it. No sudo is used.
- **System (`system`)**: an administrator installs the app once with `sudo neon-apps install APP_ID`. It becomes available to every eligible Linux user, including new accounts. Users cannot update/remove its shared code through the web interface. App API actions still execute as the signed-in Linux account, and each user separately approves permissions. Root installation does not mean root execution.

The first package runtime is the existing opaque-origin frontend sandbox. Supported grants are `notifications` and `user-files`. User-files grants permit powerful read/write access within that user's HOME; only approve trusted apps. Native Python/Node backends, arbitrary shell/SSH/hardware grants, repository install scripts and automatic system service creation by packages remain unsupported. Those capabilities require separate reviewed runtime work; the App Center is not an arbitrary Linux package manager.

## Repository layout

```text
app-repository/
├── README.md
├── LICENSE
├── source/                 # optional developer sources, not installed
└── neon-app/
    ├── manifest.json
    └── frontend/
        ├── index.html
        ├── app.js
        └── app.css
```

Use `examples/app-template/` as the starting point. Put the prebuilt frontend in `neon-app/`; build/dependency installation happens before publication. Only manifest.json and frontend files are accepted from that package directory. No npm/pip/shell/Git hooks are run. Symlinks, Git submodules, hidden/traversing paths and backend/install files are rejected. Package limits: 1000 frontend files, 2MiB per file, 16MiB total; up to100 installed personal apps. Git subprocesses have time, address-space, CPU and per-file limits. Git LFS and private/authenticated repositories are not supported in this first format. Use public HTTPS repositories; SSH/file/ext Git transports and redirects are disabled.

Manifest additions:

```json
{
  "id": "org.example.myapp",
  "name": "My application",
  "description": "What the application does",
  "version": "1.0.0",
  "runtime": "sandbox",
  "installation": "user",
  "systemDependencies": [],
  "category": "utilities",
  "permissions": ["notifications"],
  "pinnable": true,
  "icon": "◇",
  "window": {"width":800,"height":600,"minWidth":350,"minHeight":250,"resizable":true}
}
```

`org.neon.*` is reserved. Keep app IDs and installation scope stable between releases. System/core apps take precedence if a personal registry tries to shadow them. Installing an app never automatically pins it.

For a system app use `installation: "system"`. `systemDependencies` may list validated Debian package names. The administrator CLI checks that those packages are already installed and reports missing names; it does not run apt or arbitrary repository scripts. The app's supported runtime/permissions remain the same as a personal app.

## Catalog repository

Maintain `catalog.json` in a separate Git repository:

```json
{
  "schema": 1,
  "name": "Our Neon apps",
  "apps": [{
    "id": "org.example.myapp",
    "name": "My application",
    "description": "What the application does",
    "version": "1.0.0",
    "installation": "user",
    "category": "utilities",
    "repository": "https://github.com/YOUR_ORGANIZATION/YOUR_APP.git",
    "commit": "REPLACE_WITH_FULL_40_CHARACTER_APP_COMMIT",
    "path": "neon-app"
  }]
}
```

Replace both repository placeholders and the commit before use. The app commit comes from `git rev-parse HEAD` after preparing/committing the package. A branch or movable tag is not accepted as the installed identity. App ID, version and scope must match the manifest fetched at that exact commit. A SHA256 package digest is also computed and shown during review. This pins content through Git's object validation; it is not a publisher-signature system.

An administrator connects/refreshes the catalog with a pinned catalog commit:

```sh
sudo neon-apps catalog sync https://github.com/YOUR_ORGANIZATION/YOUR_CATALOG.git --commit FULL_CATALOG_COMMIT
```

For a local reviewed catalog file:

```sh
sudo neon-apps catalog import /absolute/path/catalog.json
```

Catalog state is `/etc/neon-desktop/catalog.json`, root-controlled. Ordinary users select entries from that configured catalog; the web API does not accept arbitrary repository URLs or an installation scope override. Git network operations from the administrator CLI run under the unprivileged gateway account, never as root. For a private CA, an administrator may configure `/etc/neon-desktop/git-ca.pem`; TLS verification remains enabled.

Publishing a new app version means updating its manifest, committing/publishing the package, updating the catalog's version/commit and activating that reviewed catalog revision on the server. **Refresh catalog** in the UI rereads the administrator-activated catalog; it does not automatically pull a new catalog branch from GitHub. Users then see the available app update. Automatic trusted-catalog update policy and publisher signatures are future work.

## Install, update and remove

Personal installation downloads/checks a candidate first, then shows name, version, permissions, repository, exact commit and size. Confirmation atomically activates the prepared package. Preparation expires after five minutes, and a changed catalog/installed revision requires a fresh review. Failed downloads/validation leave the installed version active. Up to three prepared candidates are held per worker.

App Center refreshes the launcher in place after installation; there is no full desktop reload or worker restart. Updates close that app's frontend windows after confirmation, invalidate old asset tickets/API version bindings and require permissions to be approved again. Other apps and terminal/jobs remain running. Browser assets use short-lived, session-bound bearer tickets so opaque sandbox frames can load their own package; do not share ticket URLs.

Administrator commands:

```sh
sudo neon-apps list
sudo neon-apps install org.example.systemapp  # installs or updates from the active catalog
sudo neon-apps remove org.example.systemapp
```

System packages/registry live under `/var/lib/neon-apps/system`, outside immutable Neon releases. Personal packages/registry live under `~/.local/share/neon-desktop/apps`. Global changes are discovered dynamically; users refresh App Center or sign in. Uninstallation removes package code and active registration; documents/app data elsewhere in HOME remain. Old pinned desktop shortcuts may remain until the user removes them, but unavailable apps cannot launch.

The previous unversioned `scripts/app-install.py` is retired and prints migration guidance. Existing legacy packages bundled with a Neon release remain readable; new distribution uses the stable app store and catalog.

## Verification

`tests/test_app_packages.py` covers package/catalog boundaries, atomic version checks, old asset invalidation, ownership modes, symlink swaps and uninstall preservation. Root-only `tests/live_app_center.py HTTPS_ORIGIN CONTROLLER_USER` creates two disposable Linux users and a loopback smart HTTPS Git server, checks actual Git catalog sync, global CLI installation and graphical personal install/update/uninstall, then restores the previous catalog/CA and removes only its test users/app. Test credentials are generated in memory and passed over stdin.
