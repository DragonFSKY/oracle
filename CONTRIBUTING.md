# Contributing to oracle-relay

Thanks for helping improve the manual Relay workflow. Changes should target the `main-relay` branch and preserve the core boundary: Relay transports human-reviewed tasks; it does not automate an official model website.

## Development setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build
pnpm run docs:check
```

Node 24+ and pnpm 10 are required. Native client changes also need the platform toolchain documented in [docs/relay.md](docs/relay.md).

## Pull/merge requests

- Describe the user-visible problem, the chosen mechanism, and any compatibility impact.
- Keep unrelated refactors separate.
- Add or update tests for protocol, persistence, authentication, upload, and recovery behavior.
- Update the top changelog section for user-visible changes.
- Update both README files when installation, deployment, security, or operator behavior changes.
- Never commit real tokens, cookies, credentials, private prompts, Relay data, generated application bundles, or session files.

The CI pipeline runs the secret check, formatting, type checking, lint, the full test suite, documentation drift checks, the Node build, client builds, Skill packaging, and container packaging. macOS builds require a runner tagged `macos`.

## Commit style

Use focused imperative commits, for example:

```text
feat(relay): add resumable response uploads
fix(operator): preserve drafts after upload failure
docs(skills): explain Ask Pro recovery
ci(relay): publish immutable service images
```

## Security-sensitive changes

Authentication, path handling, attachment integrity, operator permissions, persistence, and deployment defaults require focused negative tests. Do not weaken token separation, safe path resolution, checksum verification, idempotency, or first-terminal-response-wins behavior without an explicit protocol migration.
