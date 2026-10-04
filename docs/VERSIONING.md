# Contributing and versioned releases

The canonical repository is [xhonken/Neon-Desktop](https://github.com/xhonken/Neon-Desktop).
`main` holds current development; tags identify published source versions.

## Make a change

Create a focused branch, update the relevant documentation and add regression
coverage for changed authentication, filesystem or process behavior. Before
opening a pull request, run:

```sh
npm test
.venv/bin/python -m unittest discover -s tests -v
npm run build
git diff --check
```

Use short imperative commit subjects. Explain the problem, resulting behavior
and validation in the pull request; include redacted screenshots for UI changes.
Installed HTTPS/PAM acceptance is separate from CI and must prove actual Linux
UIDs, files and process survival when those boundaries change.

## Publish a version

1. Update `version` in `package.json`, the top-level version in `package-lock.json`
   and `packages[""].version` in the lockfile together. Use consecutive development
   versions such as `0.1.0-alpha.8` and `0.1.0-alpha.9`.
2. Add a dated section to `CHANGELOG.md`, update `docs/STATUS.md` and run the checks.
3. Merge or push the reviewed change to `main`.
4. GitHub runs checks, then creates `v<VERSION>` and a release containing the
   source archive and `SHA256SUMS`. Versions containing a hyphen are prereleases.
   Existing releases are left unchanged; use a new version for new release content.

The workflow uses GitHub's temporary token; no personal token belongs in source.
Keep deployment configuration, credentials, HOME data and acceptance artifacts
outside Git. Publishing source does not update servers. Follow
[UPDATES.md](UPDATES.md) for an explicitly requested deployment, preserving live
workers, terminals, jobs and Chromium.
