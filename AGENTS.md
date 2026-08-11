# AGENTS.MD

Oracle-specific notes:

- Ask Pro consultations prefer `mcp__dragon_relay__ask_expert` and recover interrupted waits with `mcp__dragon_relay__await_expert`. If the MCP tools are not exposed or fail before accepting a task, first run a matching `dragon-relay ask ... --dry-run json`, then make exactly one asynchronous `dragon-relay ask` submission with the same stable request ID. Later continuations run exactly one `dragon-relay wait <id>` and stop if pending. Never create a second task after either transport has accepted the original request.
- ChatGPT project URLs must be supplied by the user or machine-local configuration; never commit personal workspace URLs or account identifiers.
- Pro browser runs: allow up to 10 minutes; never click "Answer now"; keep at least 1–2 Pro live tests (reattach must stay Pro); move other tests to faster models where safe.
- Live smoke tests: OpenAI live tests are opt-in. Run `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/openai-live.test.ts` with a real `OPENAI_API_KEY` when you need the background path; gpt-5-pro can take ~10 minutes.
- Wait defaults: gpt-5-pro API runs detach by default; use `--wait` to stay attached. gpt-5.1 and browser runs block by default; every run prints `oracle session <id>` for reattach.
- Session storage: Oracle stores session data under `~/.oracle`; delete it if you need a clean slate.
- CLI output: the first line of any top-level CLI start banner should use the oracle emoji, e.g. `🧿 oracle (<version>) ...`; keep it only for the initial command headline. Exception: the TUI exit message also keeps the emoji.
- Model access note (2025-11-23): gpt-5.1-pro and grok-4.1 are not yet available on Peter’s keys; live tests that require them will fail until access is granted.
- Oracle CLI on Node 25: if `pnpm dlx @steipete/oracle --help` fails with a missing `node_sqlite3.node`, rebuild sqlite3 in the pnpm dlx cache using system Python and `npx node-gyp rebuild` from the sqlite3 package directory printed in the error, then rerun the command.
- Before a release, skim manual smokes in `docs/manual-tests.md` and rerun any that cover your change surface (especially browser/serve paths).
- If browser smokes echo the prompt (Instant), rerun with `--browser-keep-browser --verbose` in tmux, then inspect DOM with `pnpm tsx scripts/browser-tools.ts eval ...` to confirm assistant turns exist; we fixed a case by refreshing assistant snapshots post-send.
- Browser “Pro thinking” gate: never click/auto-click ChatGPT’s “Answer now” button. Treat it as a placeholder and wait 10m–1h for the real assistant response (auto-clicking skips long thinking and changes behavior).
- Browser smokes should preserve Markdown (lists, fences); if output looks flattened or echoed, inspect the captured assistant turn via `browser-tools.ts eval` before shipping.
- Working on Windows? Read and update `docs/windows-work.md` before you start.
- Keep the Sparkle signing key outside the repository and set `SPARKLE_PRIVATE_KEY_FILE` to its machine-local path when notarizing the notifier.
- Browser cookie sync + Node 25: if browser runs fail with “Failed to load keytar… Cannot find module '../build/Release/keytar.node'” and no cookies are applied, rebuild keytar in the pnpm dlx cache with system Python and `npx node-gyp rebuild` inside the keytar directory printed in the error, then rerun the Oracle command.
- npm publish OTP: prepare/tag/release first, then run `npm publish ...` and stop at `Enter OTP:`; ask user for the OTP and continue (ok to handle OTP in chat).

Browser-mode debug notes (ChatGPT URL override)

- When a ChatGPT folder/workspace URL is set, Cloudflare can block automation even after cookie sync. Use `--browser-keep-browser` to leave Chrome open, solve the interstitial manually, then rerun.
- If a run stalls/looks finished but CLI didn’t stream output, check the latest session (`oracle status`) and open it (`oracle session <id> --render`) to confirm completion.
- Active Chrome port/pid live in session metadata (`~/.oracle/sessions/<id>/meta.json`). Connect with `npx tsx scripts/browser-tools.ts eval --port <port> "({ href: window.location.href, ready: document.readyState })"` to inspect the page.
- To debug with agent-tools, launch Chrome via an Oracle browser run (cookies copied) and keep it open (`--browser-keep-browser`). Then use `~/Projects/agent-scripts/bin/browser-tools ... --port <port>` with the port from `~/.oracle/sessions/<id>/meta.json`. Avoid starting a fresh browser-tools Chrome when you need the synced cookies.
- Double-hop nav is implemented (root then target URL), but Cloudflare may still need manual clearance or inline cookies.
- After finishing a feature, ask whether it matters to end users; if yes, update the changelog. Read the top ~100 lines first and group related edits into one entry instead of scattering multiple bullets.
- Beta publishing: when asked to ship a beta to npm, bump the version with a beta suffix (e.g., `0.4.4-beta.1`) before publishing; npm will not let you overwrite an existing beta tag without a new version.
