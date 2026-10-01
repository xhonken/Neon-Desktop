# Neon Desktop

New standalone project for Debian ARM64 / Raspberry Pi 5. Do not copy, fork, import or modify Pi-2000. Communicate with owner in Swedish; public docs in English.

Read docs/ARCHITECTURE.md, docs/SECURITY.md and docs/STATUS.md before substantive changes. Public repository must contain no site addresses, passwords, private keys, local credentials or private handovers. Deployment config belongs in /etc/neon-desktop, user config in ~/.config/neon-desktop, security state in root-private /var/lib/neon-broker.

PAM is the only login authority. Root web login forbidden. Gateway runs as neon-gateway without privilege; root broker accepts only fixed, authenticated operations. Workers run as Linux UID. Never accept arbitrary command/unit/UID/path selection at the privileged boundary. Use argument vectors; never shell-concatenate request data. Keep HOME APIs descriptor-relative and fail closed without openat2. No filesystem mirror database.

Tests/build: python3 -m unittest discover -s tests -v; npm test; npm run build. Browser acceptance must use the installed HTTPS URL, authenticate through PAM, and verify actual UID/files/PTYS. Never equate UI recovery with process survival. Do not restart active worker/browser services or terminate their jobs without authorization. Do not publish to GitHub until the user explicitly authorizes publication.
