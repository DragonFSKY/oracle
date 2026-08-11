# Dragon Relay MCP

`dragon-relay-mcp` is a small stdio MCP server for durable, human-operated expert consultations. It never starts Chrome or calls a model provider directly. The CLI and MCP share session storage under `~/.oracle/sessions` (or `ORACLE_HOME_DIR`).

## Tools

### `ask_expert`

Creates or resumes one durable Relay task, then keeps the MCP call blocked on an authenticated server-sent event stream until the operator returns an answer.

Required inputs:

- `requestId`: caller-known idempotency key with 3–5 lowercase hyphen-separated segments.
- `prompt`: the complete expert prompt.

Optional inputs include `files`, `model`, `bundleFiles`, `bundleFormat`, and Relay URL/token overrides.

Reusing the same `requestId` with identical inputs resumes the same local session and remote task. Reusing it with different inputs fails instead of creating an ambiguous duplicate. Cancelling the MCP request stops only the local waiter; the remote task remains available.

### `await_expert`

Reconnects to the original task for an existing session ID and blocks until its terminal event. It never submits a second prompt. Use it after an MCP transport interruption.

## Event and recovery model

- Relay task snapshots are persisted before SSE notifications are emitted.
- A healthy wait uses one `/v1/tasks/:id/events` connection; there is no periodic producer status GET.
- SSE heartbeat comments keep proxies from considering an idle connection dead.
- Network disconnects, Relay restarts, and proxy reloads reconnect with bounded exponential backoff. Permanent 4xx errors fail immediately.
- Reconnection receives the latest persisted snapshot, so a persistent event log is unnecessary for this state-based workflow.
- Local result finalization is serialized across processes, stores an atomic result record, uses unique attachment paths, and acknowledges remote deletion only after the complete result is committed.

## Installation

Build or install this modified Oracle package. The tools themselves wait without a deadline; configure the MCP host with a practically non-expiring tool allowance so it does not cancel the call first.

Codex example:

```toml
[mcp_servers.dragon_relay]
command = "dragon-relay-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 3153600000
```

Claude Code project example:

```json
{
  "mcpServers": {
    "dragon_relay": {
      "type": "stdio",
      "command": "dragon-relay-mcp",
      "args": []
    }
  }
}
```

Configure Relay credentials through `~/.oracle/config.json`:

```json
{
  "relay": {
    "url": "https://relay.example.com",
    "token": "<producer-token>",
    "timeoutMs": 0,
    "expiresInMs": 0
  }
}
```

The MCP path normalizes both Relay values to `0` (no deadline), including recovered sessions. The packaged MCP surface intentionally contains only `ask_expert` and `await_expert`; browser/API consultation tools are not exported.
