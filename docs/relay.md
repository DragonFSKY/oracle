# Human relay mode

Relay mode is Oracle's durable, human-in-the-loop execution engine. It is intended for a development machine running Codex/Oracle while a person uses ChatGPT, Claude, Gemini, or another official chat client on a separate device.

## Components

- **Producer:** `dragon-relay` CLI on the development machine. It assembles the prompt, resolves files, creates the remote task, and restores the answer into the local session.
- **Relay server:** Stores task metadata and temporary request/response attachments. It never signs into an AI provider.
- **Operator clients:** The server-hosted web client and native macOS, Windows, and Android clients under `apps/relay-operator-*`. All expose prompts and verified request files, keep active tasks alive, and can upload the final Markdown response and generated files from any device.

Both producer and operator initiate outbound HTTP(S) connections. The development machine does not need an inbound port.

## Start the service

```bash
dragon-relay serve \
  --host 0.0.0.0 \
  --port 9474 \
  --producer-token "$ORACLE_RELAY_TOKEN" \
  --operator-token "$ORACLE_OPERATOR_TOKEN"
```

If tokens are omitted, Oracle generates and prints separate producer and operator tokens. Tasks and files are stored under `~/.oracle/relay` by default; override this with `--data-dir` or `ORACLE_RELAY_DATA_DIR`.

Put the service behind an HTTPS reverse proxy when it is reachable beyond a trusted private network. The built-in server intentionally provides HTTP only and does not terminate TLS.

### Production Docker deployment

Build Oracle first, then deploy the prebuilt `dist/` tree with the hardened Compose definition in `deploy/relay/`:

```bash
pnpm build
sudo install -d -m 0755 /opt/oracle-relay/app /etc/oracle-relay
sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/oracle-relay
sudo install -m 0600 relay.env /etc/oracle-relay/relay.env
docker compose -f deploy/relay/compose.yaml up -d --build
```

If the container registry is temporarily unavailable but the last known-good service image is still local, an application-only update can reuse that image without pulling a new Node base:

```bash
docker tag relay-relay:latest oracle-relay-base:local
docker build -f deploy/relay/Dockerfile.cached -t relay-relay:latest .
docker compose -f deploy/relay/compose.yaml up -d --no-build
```

The private environment file contains separate server-side credentials:

```dotenv
ORACLE_RELAY_PRODUCER_TOKEN=<random producer token>
ORACLE_RELAY_OPERATOR_TOKEN=<different random operator token>
ORACLE_RELAY_HOST=0.0.0.0
ORACLE_RELAY_PORT=19476
ORACLE_RELAY_DATA_DIR=/data
ORACLE_RELAY_MAX_BODY_BYTES=268435456
ORACLE_RELAY_MAX_ATTACHMENT_BYTES=0
ORACLE_RELAY_MAX_TASK_BYTES=0
ORACLE_RELAY_TERMINAL_RETENTION_MS=86400000
```

The container runs on Node 24, drops Linux capabilities, uses a read-only root filesystem, stores tasks under `/var/lib/oracle-relay`, restarts automatically, and publishes only `127.0.0.1:19476`. Terminate HTTPS in the host reverse proxy and forward traffic to that loopback address. `GET /health` is the unauthenticated container health endpoint. Environment-provided credentials are never printed in server logs.

Request attachments use staged, retryable 4 MiB chunks rather than JSON/Base64 or one long upload request. Per-file and per-task attachment guards default to `0` (unlimited); positive values in the environment variables above opt into explicit guards. JSON control messages remain capped separately because attachment bytes do not travel in those messages. Actual capacity is bounded by available disk, filesystem limits, and any upstream provider restriction.

The reverse proxy must allow at least the per-file attachment limit. Use [`deploy/relay/nginx-location.conf.example`](../deploy/relay/nginx-location.conf.example) as the Nginx location template. Keep `proxy_request_buffering on` so Nginx receives each chunk completely before forwarding it to Node, and set a long `client_body_timeout` for slow cross-device links.

After the development machine has downloaded the complete answer and all response attachments and persisted the Oracle session, it acknowledges the task and the server removes that task directory immediately. Completed, cancelled, or expired tasks that never receive an acknowledgement are pruned after the terminal retention window (24 hours by default), with a cleanup sweep every 15 minutes.

Lifecycle logs are emitted as single-line JSON after the `[relay]` prefix. They cover server start/stop, task creation, claim, manual submission, completion, cancellation, expiry, released claims, attachment downloads, and failed requests. Records include task/session IDs, status, safe counts/byte sizes, and elapsed time, but never tokens, prompt text, answer text, or attachment contents. In Docker deployments, inspect them with:

```bash
docker logs --since 30m oracle-relay
docker logs -f oracle-relay
```

## Submit from the development machine

```bash
dragon-relay ask \
  --relay-url https://relay.example.com \
  --relay-token "$ORACLE_RELAY_TOKEN" \
  --model gpt-5.5-pro \
  --prompt "Review the release plan and return concrete risks" \
  --file docs/release-plan.md --file "src/**/*.ts"
```

Relay CLI submissions are asynchronous by default: the command uploads every request file, waits for the server to publish the task as `queued`, prints the durable session and Relay task IDs, and exits without starting a local worker. Upload or publication failures return nonzero instead of claiming the task was submitted. After an operator notification, run `dragon-relay wait <id>` once: pending tasks report their current state and exit immediately; completed tasks restore the answer and attachments. Add `--wait` to the original `ask` command only when a single foreground command is explicitly required to remain attached.

Useful settings:

- `--relay-operator-url`: alternate URL printed for the person handling the task.
- `--wait`: opt into synchronous response waiting; without it, relay returns after upload and durable server publication.
- `--relay-timeout`: maximum local wait for an explicit blocking `ask --wait`, default `24h`.
- `--relay-poll-interval`: polling interval only for an explicit blocking `ask --wait`, default `2s`.
- `--relay-expires-in`: server-side task lifetime, default `24h`.
- `--browser-bundle-files --browser-bundle-format zip`: reuse Oracle's byte-preserving attachment bundling for large or mixed file sets.

The default relay engine uses no detached worker. The queued task survives because it is stored on the Relay server, not because a local process remains alive. Use `dragon-relay wait <id>` after notification; each invocation makes one server query and never loops locally.

The default CLI flow needs no long connection: `ask` submits asynchronously and `wait` performs one query. `dragon-relay-mcp` additionally uses authenticated SSE at `/v1/tasks/:id/events`; keep response buffering disabled and `proxy_read_timeout` longer than the maximum MCP wait. Heartbeat comments keep an otherwise idle stream active. A reconnect after a network or proxy interruption receives the latest persisted task snapshot and is not periodic status polling.

## Codex session continuation

To carry the latest task context from an older Codex thread into a clean interactive thread:

```bash
dragon-relay-continue <codex-session-id>
```

The command opens a new interactive thread that appears in normal Codex history. Add `--print` to inspect the continuation prompt without starting Codex. Use `--check` to verify `pwd`, `dragon-relay`, and a minimal dry-run without continuing the old task or creating a live Relay task. Ask Pro tasks in the migrated thread prefer `dragon-relay-mcp` and use the CLI only as an asynchronous fallback.

## Operator workflow

1. Open the relay URL and enter the operator token and a device/operator label.
2. Open a queued or active task on any operator device. The task is shared: Mac, Windows, Android, and web clients may all operate it without per-device ownership.
3. Copy the prompt. Text/code attachments can be copied directly as clipboard text, and supported images can be copied directly as clipboard images without saving them first. Other binary formats such as PDF and ZIP still require downloading because browsers cannot reliably place arbitrary files on the system clipboard.
4. Manually submit them in the chosen official AI client.
5. Paste the complete Markdown answer into the operator page.
6. Add any generated files, images, patches, PDFs, or archives and submit. If clients submit concurrently, the first terminal response wins and later submissions cannot overwrite it.

If a long-running generation is stuck, any authenticated operator client can use **Abort task**. This marks the Relay task as `cancelled` and immediately releases the waiting Oracle session with a clear error. It does not remotely stop generation in the external AI client; stop that separately if it is still running.

Response files are downloaded into `~/.oracle/sessions/<id>/artifacts/` on the development machine and verified against their recorded SHA-256 digest.

### Native macOS operator

The optional native client keeps a small Relay window above other applications, expands automatically when a task needs manual action, and collapses while waiting for the external AI response. It downloads request attachments into `~/Library/Caches/OracleRelay/<task-id>/`, verifies each SHA-256 digest, exposes one-click native clipboard actions without displaying source paths or internal attachment names, and removes terminal-task caches automatically.

Build and install it on the operator Mac:

```bash
cd apps/relay-operator-macos
export ORACLE_RELAY_OPERATOR_URL="https://relay.example.com"
export ORACLE_RELAY_OPERATOR_TOKEN="<operator-token>"
./build-app.sh
./install-app.sh
```

The installer places `Oracle Relay.app` in `~/Applications` and registers a per-user launch agent. `build-app.sh` copies the URL and token from the environment into the local application bundle; neither value is stored in Git. The menu-bar settings only change the stable operator/device name. Relay requests use a dedicated no-proxy URL session, so a system HTTP, HTTPS, or SOCKS proxy cannot stall attachment uploads. In the response editor, ordinary text still pastes normally, while files copied in Finder and images copied from browsers, Preview, or screenshot tools can be attached directly with **⌘V**. The editor handles the key event itself instead of depending on a standard Edit menu, and also accepts a literal **Ctrl+V** for Windows-style keyboard setups; the visible **粘贴剪贴板附件** button invokes the same attachment path. Pasted image data is kept only in the active task's temporary cache, restored after an app restart or when returning to the task, and removed when the attachment list is cleared or the task completes. Response files are staged by size and SHA-256, uploaded in retryable chunks, and published only after server verification; identical retries reuse the same upload ID and already stored prefix instead of resetting progress. Public response uploads use 1 MiB chunks with a five-minute per-chunk allowance, while loopback delivery retains 512 KiB chunks. Polling cannot overwrite the stable upload status, and failures retain the draft plus files for retry. For a blocking MCP task, the MCP advertises a task-scoped receiver on a random loopback port with a one-time 256-bit capability and refreshes it whenever `ask_expert` or `await_expert` resumes an existing task. The native Mac operator accepts only literal `127.0.0.1` or `::1`, probes and verifies the task identity, then transfers return attachments directly into the originating session before using the public Relay only to complete the task state. Multiple MCP processes cannot cross-connect because every task has its own port and token; an absent, expired, interrupted, or mismatched local receiver automatically falls back to the normal public chunk path. Compact mode uses two rows: a `[status] title` task picker plus expand/hide controls, then prompt copy, conditional attachment copy, text-only **粘贴并提交**, and refresh. The picker switches tasks without expanding, but refuses to leave a task that has a response draft, return attachment, or active upload. Multiple request attachments are copied together as files; quick submit refuses clipboard files/images or an existing response attachment so those cases return to the reviewable expanded workflow. Both the compact and expanded native windows can be moved and resized, retain their last frame across launches, and expose standard macOS zoom controls plus menu-bar actions to zoom or restore the default size. Task refreshes never reposition an unchanged window mode, and real compact/expanded transitions keep the current window's top-left position whenever the larger frame fits on screen. Their visible **缩小** buttons, native yellow controls, and red close controls hide the floating window to the menu bar; new tasks and status refreshes respect that choice until **显示 Oracle Relay** is selected explicitly, without stopping Relay polling.

### Native Windows operator

The Windows client uses .NET 10 WinForms and provides the same shared-task heartbeat, prompt/attachment clipboard, abort, Markdown response, and response-file workflow. It remains available through the system tray, supports a DPI-aware resizable compact mode and maximize/restore actions, constrains restored frames to the active screen, and uses elastic headers plus vertically scroll-safe content at smaller sizes. It remembers its last window frame and caches verified attachments under `%LOCALAPPDATA%\\OracleRelay`. The runtime reads `ORACLE_RELAY_OPERATOR_URL` and `ORACLE_RELAY_OPERATOR_TOKEN` from the user's environment; keep them outside the repository.

Build and install it from PowerShell on Windows:

```powershell
cd apps/relay-operator-windows
$env:ORACLE_RELAY_OPERATOR_URL = "https://relay.example.com"
$env:ORACLE_RELAY_OPERATOR_TOKEN = "<operator-token>"
.\\build.ps1
.\\install.ps1
```

The installer publishes a self-contained `win-x64` executable, copies it to `%LOCALAPPDATA%\\Programs\\Oracle Relay`, creates a Start Menu shortcut, and registers the per-user `Oracle Relay Operator` interactive logon task. The scheduled task also makes SSH deployments reliable because Windows OpenSSH otherwise terminates directly launched child processes when the SSH session closes.

### Native Android operator

The Android client targets API 36 and runs a visible foreground queue service so new-task notifications and active-task renewal continue while the UI is closed. The app opens shared tasks, verifies downloaded attachments with SHA-256, copies text directly, shares binary/image content URIs with the selected AI client, accepts multiple response documents, and returns Markdown plus files. The locally built APK receives its Relay URL/token from build environment variables and derives a stable operator name from the device model and Android ID.

Build and install it with an Android SDK available:

```bash
cd apps/relay-operator-android
export ORACLE_RELAY_OPERATOR_URL="https://relay.example.com"
export ORACLE_RELAY_OPERATOR_TOKEN="<operator-token>"
./build.sh
./install.sh
```

The Gradle build copies those environment values into the local APK; neither value is stored in Git. The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. The app is intended for private sideloading; its persistent foreground service uses the Android `specialUse` declaration with an explicit Relay queue/lease purpose.

### Multi-platform builds and deployment

The root `.gitlab-ci.yml` verifies the Node service, packages the three Ask Pro Skills, pushes commit/branch Relay images to the GitLab Container Registry, and builds credential-free `oracle-relay-*` Windows and Android artifacts. The macOS application job is manual and requires a runner tagged `macos`. `main-relay` and tag pipelines expose a serialized manual production deploy using protected file-type SSH variables; production Relay tokens remain only in `/etc/oracle-relay/relay.env` on the host. For a local source build, run `scripts/build-private.sh`; it verifies the Node project and builds whichever client toolchains are installed.

## Security properties and limits

- Producer and operator credentials are separate; one cannot perform the other's mutating operations.
- File names are sanitized, identifiers are validated, request sizes are bounded, and downloads use stored descriptors rather than user-provided paths.
- Task files persist until the relay data directory is pruned or removed. Deployments handling sensitive repositories should add storage encryption and an external retention job.
- The relay server can see unencrypted prompts and files. Use a trusted host or private network. End-to-end encryption is not part of this first protocol version.
- Relay intentionally does not collect a provider/model self-report from the operator because it cannot verify that provenance. Treat every returned answer as manually supplied content.
- The web client stores the operator token in browser local storage for convenience. Use a dedicated device/profile for sensitive deployments and revoke tokens when a device is lost.
