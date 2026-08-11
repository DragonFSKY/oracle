# Security policy

## Supported version

Security fixes are applied to the current `main-relay` branch. Older commits, local client builds, and self-hosted deployments must be upgraded by their operators.

## Reporting a vulnerability

Do not open a public issue containing credentials, cookies, private prompts, attachments, internal hostnames, or an exploitable proof of concept. Use GitHub's private vulnerability reporting/security advisory flow or another private channel configured by the repository owner. Include the affected commit, component, impact, minimum reproduction, and whether any token or data may already be exposed.

If a credential may have leaked, rotate it immediately; do not wait for a code fix. Producer and operator tokens must be rotated separately. Also rotate the deployment SSH key when runner or host access may be affected.

## Deployment responsibilities

- Use separate high-entropy producer and operator tokens.
- Store secrets in protected CI variables or machine-local secret files, never in Git.
- Put Relay behind HTTPS and keep its Node port bound to loopback.
- Protect `/var/lib/oracle-relay`, use disk encryption when appropriate, and define retention/backup rules.
- Treat the Relay host as trusted: protocol payloads are not end-to-end encrypted.
- Do not publicly distribute locally built clients that embed operator credentials.
- Keep reverse-proxy upload and SSE settings aligned with [docs/relay.md](docs/relay.md).
- Review operator devices and revoke credentials after loss or compromise.

The repository's deterministic secret check catches common key formats and tracked sensitive-file names, but it is not proof that a tree is secret-free. Review every staged diff before publishing.
