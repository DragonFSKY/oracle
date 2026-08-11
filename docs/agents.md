---
title: Coding Agents
description: "Use Oracle from Claude Code, Codex, Cursor, and any other coding agent — as a CLI, as an MCP server, or as a one-shot skill."
---

Oracle is built to be called _by_ coding agents as much as by humans. The flow is always the same: the agent gathers context, hands the bundle to a stronger Pro model, gets a second opinion back.

## The 30-second wiring

Drop this into the project's `AGENTS.md` or `CLAUDE.md`:

```
- Oracle bundles a prompt plus the right files so a Pro model (GPT-5.5 Pro,
  Gemini 3 Pro, Claude Opus) can answer with real repo context. Use when stuck,
  debugging hard bugs, doing architecture review, or cross-validating a plan.
- Run `npx -y @steipete/oracle --help` once per session before first use.
```

That's enough for most agents to discover and use Oracle correctly. The patterns below cover the deeper integrations.

## Claude Code

### As an MCP server (recommended)

```bash
codex mcp add dragon_relay -- "$(command -v dragon-relay-mcp)"
```

The packaged MCP exposes only the blocking `ask_expert` and `await_expert` Relay tools. Configure the producer URL/token through the process environment or machine-local Oracle config; the MCP does not automate a browser or call a model provider.

See [MCP](mcp.md) for connection details and other clients.

### As a skill

Copy the bundled skill into `~/.claude/skills/`:

```bash
mkdir -p ~/.claude/skills
cp -R skills/oracle ~/.claude/skills/oracle
```

Then reference `oracle` in `CLAUDE.md`. Claude Code will load `SKILL.md` whenever the trigger conditions match (debugging, refactor, design check).

### As a slash command

Many users alias Oracle behind a custom `/consult` slash command that wraps `npx -y @steipete/oracle --engine browser …`. Pair with `--browser-tab current` to keep all consults in one ChatGPT conversation.

## Codex

Copy the same skill into the Codex skills folder:

```bash
mkdir -p ~/.codex/skills
cp -R skills/oracle ~/.codex/skills/oracle
```

Then reference it in `AGENTS.md`. Codex will pick it up automatically.

For Codex slash prompts, drop a wrapper in `~/.codex/prompts/oracle.md` that calls Oracle with your preferred defaults (engine, model, follow-up flags).

## Cursor

Cursor speaks MCP. Drop a `.cursor/mcp.json` like:

```json
{
  "dragon_relay": {
    "command": "dragon-relay-mcp",
    "args": []
  }
}
```

The server exposes only `ask_expert` and `await_expert`; configure the Relay URL/token in `~/.oracle/config.json` or the MCP environment.

## Generic CLI usage from any agent

When the agent has shell access, the simplest hand-off is the bundle-on-clipboard fallback:

```bash
oracle --render --copy -p "$TASK" --file "$RELEVANT_FILES"
```

…then the agent (or a human) pastes into whichever Pro model they have access to. No keys, no MCP, works everywhere.

For autonomous dry-runs, use the JSON preview to inspect the resolved bundle before spending model time:

```bash
oracle --dry-run json --model gpt-5.5-pro -p "$TASK" --file "$RELEVANT_FILES"
```

Completed runs persist answers, usage, cost, session ids, model choices, and lineage under `~/.oracle/sessions/<id>/`. Exit code is non-zero on failure.

## Multi-agent shared profile (browser mode)

When multiple agents share one signed-in Chrome profile (the manual-login workflow), Oracle coordinates browser tab slots so parallel runs queue instead of crashing. Tune with:

- `--browser-max-concurrent-tabs` — default 3 simultaneous tabs.
- `--browser-profile-lock-timeout` — wait for the profile lock before sending.
- `--browser-reuse-wait` — wait for a shared Chrome profile before launching.

For the most reliable shared setup: run one signed-in Chrome with remote debugging, point all callers at it via `--remote-chrome <host:port>`. See [Browser Mode](browser-mode.md).

## Cost / safety hygiene

- **Always preview Pro runs.** `--dry-run summary --files-report` before a Pro API call on a large bundle. Token counts are a close-enough proxy for dollars.
- **Optional file-size guard.** `~/.oracle/config.json` → `maxFileSizeBytes`, or `ORACLE_MAX_FILE_SIZE_BYTES`. The default and `0` are unlimited; use a positive byte count only when a guard is desired.
- **Excludes are your friend.** `--file "src/**" --file "!**/*.test.ts" --file "!**/*.snap"` cuts most fixtures.
- **API mode runs cost real money.** If your agent runs Oracle autonomously, scope it: pin `--model`, set `--timeout`, and review the session log. Many users gate API mode behind explicit user consent and let browser mode run free.

## Patterns that work

- **Stuck → Oracle.** When the agent has been spinning on the same bug for 3+ turns, hand the failing test plus the involved files to GPT-5.5 Pro. It often spots the issue in one round.
- **Plan → Oracle → execute.** Draft the plan, ask Claude Opus or Gemini 3 Pro to challenge it, then implement.
- **Refactor → cross-check.** After a non-trivial refactor, send the diff plus the spec to a different provider than the one that wrote the diff. Catches drift fast.
- **Followup chain.** Use `--followup <id>` to keep one Pro session alive across iterations rather than re-bundling the whole repo every time. See [Followup](followup.md).
