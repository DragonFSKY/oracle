# Dragon Relay MCP smoke tests

Use these checks before shipping the packaged `dragon-relay-mcp` surface.

## Automated gate

```bash
pnpm build
pnpm vitest run \
  tests/mcp.schema.test.ts \
  tests/mcp.integration.test.ts \
  tests/mcp.stdout.test.ts \
  tests/mcp.relay.integration.test.ts \
  tests/relay.test.ts
```

The build removes the legacy browser/API MCP modules from `dist`. Schema discovery must return exactly `ask_expert` and `await_expert`.

## Installed-package gate

Pack the current worktree, install that tarball, and verify the configured command is `dragon-relay-mcp`. Do not install an upstream npm version when validating a fork.

```bash
npm pack --ignore-scripts
npm install -g ./steipete-oracle-*.tgz
codex mcp add dragon_relay -- "$(command -v dragon-relay-mcp)"
claude mcp add --scope user dragon_relay -- "$(command -v dragon-relay-mcp)"
```

Configure the MCP host with a practically non-expiring tool allowance. Codex example:

```toml
[mcp_servers.dragon_relay]
command = "dragon-relay-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 3153600000
```

## Real Relay gate

1. Start a fresh Codex/Claude session and confirm tool discovery lists only the two Relay tools.
2. Call `ask_expert` once with a new stable request ID. While it is pending, do not run `wait`, `status`, a background terminal, or a polling loop.
3. Leave it pending for at least 65 seconds, then complete it from the operator client. The original tool call must return automatically.
4. For recovery, interrupt the MCP transport without cancelling the remote task. In a new session call `await_expert` once with the same request ID. The operator must still see only one task.
5. Verify one local result commit, one answer log marker, correct attachment hashes, and eventual remote acknowledgement cleanup.

The test must not start Chrome or send a provider API request.
