import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ProgressNotificationSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadUserConfig } from "../config.js";
import type { ModelName, RunOracleOptions } from "../oracle.js";
import {
  bindRelayTaskToSession,
  readRelayCommittedResult,
  refreshRelaySessionFromTask,
  relayConfigFromMetadata,
  settleRelayAcknowledgement,
  submitRelaySession,
} from "../cli/relaySession.js";
import { buildSessionLifecycle } from "../cli/sessionLifecycle.js";
import { readFiles } from "../oracle/files.js";
import {
  getRelayTaskByRequestId,
  updateRelayTaskLocalReceiver,
  waitForRelayTaskEvents,
} from "../relay/client.js";
import { startLocalResponseReceiver } from "../relay/localReceiver.js";
import type { RelaySessionConfig, RelayTask } from "../relay/types.js";
import type { SessionArtifact, SessionMetadata } from "../sessionManager.js";
import {
  initializeSession,
  removeIncompleteSession,
  withSessionFileLock,
  writeSessionRelayToken,
} from "../sessionManager.js";
import { sessionStore } from "../sessionStore.js";

const SESSION_LOCK_TIMEOUT_MS = 30_000;

const relayOverridesShape = {
  relayUrl: z.string().url().optional().describe("Override the configured Relay server URL."),
  relayToken: z
    .string()
    .min(1)
    .optional()
    .describe("Override the configured Relay producer token."),
  relayOperatorUrl: z.string().url().optional().describe("Override the operator UI URL."),
};

const askExpertInputShape = {
  requestId: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+){2,4}$/)
    .describe(
      "Stable caller-known recovery id with 3-5 lowercase hyphen-separated segments. Reusing it with identical input resumes the same task; different input is rejected.",
    ),
  prompt: z.string().min(1).describe("Chinese expert-review prompt to send through Dragon Relay."),
  files: z
    .array(z.string())
    .default([])
    .describe("File paths or glob patterns, resolved from the MCP server working directory."),
  model: z.string().optional().describe("Optional model hint shown to the human operator."),
  bundleFiles: z
    .boolean()
    .optional()
    .describe("Bundle multiple inputs into one attachment before upload."),
  bundleFormat: z
    .enum(["auto", "text", "zip"])
    .optional()
    .describe("Bundle format when bundleFiles is enabled."),
  ...relayOverridesShape,
} satisfies z.ZodRawShape;

const awaitExpertInputShape = {
  id: z.string().min(1).describe("Existing Dragon Relay session id returned by ask_expert."),
} satisfies z.ZodRawShape;

const artifactShape = z.object({
  path: z.string(),
  label: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
});

const relayExpertOutputShape = {
  sessionId: z.string(),
  taskId: z.string().optional(),
  status: z.string(),
  output: z.string(),
  artifacts: z.array(artifactShape).optional(),
} satisfies z.ZodRawShape;

interface RelayProgressContext {
  signal?: AbortSignal;
  onStatus?: (status: string) => Promise<void>;
}

function textResult(text: string, isError = false): CallToolResult {
  return { isError: isError || undefined, content: [{ type: "text", text }] };
}

function summarizeArtifacts(artifacts?: SessionArtifact[]):
  | Array<{
      path: string;
      label?: string;
      mimeType?: string;
      sizeBytes?: number;
    }>
  | undefined {
  if (!artifacts?.length) return undefined;
  return artifacts.map(({ path, label, mimeType, sizeBytes }) => ({
    path,
    label,
    mimeType,
    sizeBytes,
  }));
}

function relayConfigFromInput(
  input: {
    relayUrl?: string;
    relayToken?: string;
    relayOperatorUrl?: string;
  },
  configured: Awaited<ReturnType<typeof loadUserConfig>>["config"],
): RelaySessionConfig {
  const url = input.relayUrl ?? process.env.ORACLE_RELAY_URL ?? configured.relay?.url;
  const token = input.relayToken ?? process.env.ORACLE_RELAY_TOKEN ?? configured.relay?.token;
  if (!url || !token) {
    throw new Error(
      "Dragon Relay requires relay.url/relay.token or ORACLE_RELAY_URL/ORACLE_RELAY_TOKEN.",
    );
  }
  return {
    url,
    token,
    operatorUrl:
      input.relayOperatorUrl ??
      process.env.ORACLE_RELAY_OPERATOR_URL ??
      configured.relay?.operatorUrl,
    // MCP expert calls deliberately have no business timeout. Zero is the
    // shared Relay sentinel for an indefinitely blocking wait and durable task.
    timeoutMs: 0,
    expiresInMs: 0,
  };
}

async function expertRequestFingerprint(options: RunOracleOptions, cwd: string): Promise<string> {
  const files = await readFiles(options.file ?? [], {
    cwd,
    maxFileSizeBytes: options.maxFileSizeBytes,
    readContents: false,
  });
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      prompt: options.prompt,
      model: options.model,
      cwd: path.resolve(cwd),
      bundleFiles: options.browserBundleFiles,
      bundleFormat: options.browserBundleFormat,
      files: files.map((file) => path.resolve(file.path)).sort(),
    }),
  );
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(path.resolve(file.path));
    for await (const chunk of createReadStream(file.path)) hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function persistExpertRequestBinding(
  metadata: SessionMetadata,
  config: RelaySessionConfig,
  inputFingerprint: string,
): Promise<SessionMetadata> {
  await writeSessionRelayToken(metadata.id, config.token);
  return sessionStore.updateSession(metadata.id, {
    relay: {
      config: {
        url: config.url,
        operatorUrl: config.operatorUrl,
        pollIntervalMs: config.pollIntervalMs,
        timeoutMs: config.timeoutMs,
        expiresInMs: config.expiresInMs,
        tokenConfigured: true,
      },
      ...metadata.relay,
      inputFingerprint,
      operatorUrl: metadata.relay?.operatorUrl ?? config.operatorUrl,
    },
  });
}

async function initializeExactExpertSession(
  id: string,
  options: RunOracleOptions,
  config: RelaySessionConfig,
  cwd: string,
): Promise<SessionMetadata> {
  try {
    return await initializeSession(
      { ...options, mode: "relay", relayConfig: config, waitPreference: true },
      cwd,
      undefined,
      id,
      true,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await waitForCreatedSession(id).catch(() => null);
    if (existing) return existing;
    if (!(await removeIncompleteSession(id))) {
      const recovered = await sessionStore.readSession(id);
      if (recovered) return recovered;
      throw error;
    }
    return initializeSession(
      { ...options, mode: "relay", relayConfig: config, waitPreference: true },
      cwd,
      undefined,
      id,
      true,
    );
  }
}

async function observeTask(
  sessionId: string,
  task: RelayTask,
  lastStatus: { value?: string },
  progress?: RelayProgressContext,
): Promise<void> {
  await withSessionFileLock(
    sessionId,
    "relay-finalize",
    async () => {
      const latest = await sessionStore.readSession(sessionId);
      if (!latest || latest.relay?.resultTaskId) return;
      await sessionStore.updateSession(sessionId, {
        status: "running",
        relay: {
          ...latest.relay!,
          status: task.status,
          lastObservedAt: new Date().toISOString(),
          completedAt: task.completedAt,
        },
        response: { status: task.status },
      });
    },
    { timeoutMs: SESSION_LOCK_TIMEOUT_MS, signal: progress?.signal },
  );
  if (task.status !== lastStatus.value) {
    lastStatus.value = task.status;
    await progress?.onStatus?.(task.status).catch(() => undefined);
  }
}

async function finishTask(
  metadata: SessionMetadata,
  config: RelaySessionConfig,
  task: RelayTask,
): Promise<CallToolResult> {
  const refreshed = await refreshRelaySessionFromTask(metadata.id, task, config);
  const finalMetadata = refreshed.metadata;
  const output =
    task.response?.markdown ?? (await sessionStore.readLog(metadata.id).catch(() => ""));
  const summary = `Dragon Relay session ${metadata.id} finished with status ${finalMetadata.status}.`;
  const result: CallToolResult = {
    isError: refreshed.state === "failed" || undefined,
    content: [{ type: "text", text: `${summary}\n\n${output}`.trim() }],
    structuredContent: {
      sessionId: metadata.id,
      taskId: task.id,
      status: finalMetadata.status,
      output,
      artifacts: summarizeArtifacts(finalMetadata.artifacts),
    },
  };
  return result;
}

export async function runAskExpert(
  rawInput: unknown,
  progress?: RelayProgressContext,
): Promise<CallToolResult> {
  let recoveryId: string | undefined;
  try {
    const input = z.object(askExpertInputShape).strict().parse(rawInput);
    recoveryId = input.requestId;
    const { config: userConfig } = await loadUserConfig();
    const relayConfig = relayConfigFromInput(input, userConfig);
    const runOptions: RunOracleOptions = {
      prompt: input.prompt,
      model: (input.model ?? userConfig.model ?? "gpt-5.6") as ModelName,
      file: input.files,
      slug: input.requestId,
      sessionId: input.requestId,
      maxFileSizeBytes: 0,
      browserAttachments: "always",
      browserBundleFiles: input.bundleFiles,
      browserBundleFormat: input.bundleFormat,
    };
    const cwd = process.cwd();
    const inputFingerprint = await expertRequestFingerprint(runOptions, cwd);
    let session = await sessionStore.readSession(input.requestId);
    if (session) {
      assertMatchingExpertRequest(session, runOptions);
      if (session.relay?.inputFingerprint && session.relay.inputFingerprint !== inputFingerprint) {
        throw new Error(
          `Recovery id ${session.id} is already bound to different file contents or working directory.`,
        );
      }
      session = await persistExpertRequestBinding(session, relayConfig, inputFingerprint);
      const committed = await readRelayCommittedResult(session.id);
      if (committed && session.relay?.resultTaskId === committed.taskId) {
        return committedResultAfterAck(session, committed);
      }
    } else {
      session = await initializeExactExpertSession(input.requestId, runOptions, relayConfig, cwd);
      assertMatchingExpertRequest(session, runOptions);
      session = await persistExpertRequestBinding(session, relayConfig, inputFingerprint);
    }
    await sessionStore.updateSession(session.id, {
      lifecycle: buildSessionLifecycle({
        engine: "relay",
        detached: false,
        waitingRemote: true,
        reattachCommand: `dragon-relay wait ${session.id}`,
      }),
    });
    const localReceiver = await startLocalResponseReceiver({
      requestId: session.id,
      artifactsDir: path.join((await sessionStore.getPaths(session.id)).dir, "artifacts"),
      lifetimeMs: relayConfig.timeoutMs,
    });
    try {
      if (session.relay?.taskId) {
        await updateRelayTaskLocalReceiver(
          relayConfig,
          session.relay.taskId,
          localReceiver.capability,
        );
      }
      const submitted = session.relay?.taskId
        ? session
        : await submitRelaySession({
            sessionMeta: session,
            runOptions,
            relayConfig,
            cwd,
            localReceiver: localReceiver?.capability,
          });
      const taskId = submitted.relay?.taskId;
      if (!taskId) throw new Error(`Relay session ${session.id} was created without a task id.`);
      await progress?.onStatus?.(`queued:${session.id}`).catch(() => undefined);
      return await waitForExpertResult(submitted, relayConfig, progress);
    } finally {
      await localReceiver?.close().catch(() => undefined);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return textResult(recoveryId ? `${detail}\nRecovery id: ${recoveryId}` : detail, true);
  }
}

export async function runAwaitExpert(
  rawInput: unknown,
  progress?: RelayProgressContext,
): Promise<CallToolResult> {
  try {
    const input = z.object(awaitExpertInputShape).strict().parse(rawInput);
    const { config: userConfig } = await loadUserConfig();
    let metadata = await sessionStore.readSession(input.id);
    let relayConfig: RelaySessionConfig;
    if (metadata) {
      try {
        relayConfig = await relayConfigFromMetadata(metadata);
      } catch {
        relayConfig = relayConfigFromInput({}, userConfig);
        await writeSessionRelayToken(metadata.id, relayConfig.token);
      }
    } else {
      relayConfig = relayConfigFromInput({}, userConfig);
      const remote = await getRelayTaskByRequestId(relayConfig, input.id);
      const recoveredOptions: RunOracleOptions = {
        prompt: remote.prompt,
        model: (remote.modelHint ?? userConfig.model ?? "gpt-5.6") as ModelName,
        file: [],
        slug: input.id,
        sessionId: input.id,
      };
      metadata = await initializeExactExpertSession(
        input.id,
        recoveredOptions,
        relayConfig,
        remote.source ?? process.cwd(),
      );
      metadata = await bindRelayTaskToSession(metadata.id, remote, relayConfig);
    }
    relayConfig.timeoutMs = 0;
    relayConfig.expiresInMs = 0;
    const committed = await readRelayCommittedResult(metadata.id);
    if (committed && metadata.relay?.resultTaskId === committed.taskId) {
      return committedResultAfterAck(metadata, committed);
    }
    if (!metadata.relay?.taskId) {
      const remote = await getRelayTaskByRequestId(relayConfig, input.id);
      metadata = await bindRelayTaskToSession(metadata.id, remote, relayConfig);
    }
    const localReceiver = await startLocalResponseReceiver({
      requestId: metadata.id,
      artifactsDir: path.join((await sessionStore.getPaths(metadata.id)).dir, "artifacts"),
      lifetimeMs: relayConfig.timeoutMs,
    });
    try {
      if (metadata.relay?.taskId) {
        await updateRelayTaskLocalReceiver(
          relayConfig,
          metadata.relay.taskId,
          localReceiver.capability,
        );
      }
      if (metadata.relay?.status === "uploading") {
        const stored = metadata.options;
        metadata = await submitRelaySession({
          sessionMeta: metadata,
          runOptions: {
            ...stored,
            prompt: stored.prompt ?? metadata.promptPreview ?? "Resume Dragon Relay upload",
            model: (stored.model ?? metadata.model ?? "gpt-5.6") as ModelName,
            sessionId: metadata.id,
          },
          relayConfig,
          cwd: metadata.cwd ?? process.cwd(),
          localReceiver: localReceiver.capability,
        });
      }
      return await waitForExpertResult(metadata, relayConfig, progress);
    } finally {
      await localReceiver.close().catch(() => undefined);
    }
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

async function waitForExpertResult(
  metadata: SessionMetadata,
  relayConfig: RelaySessionConfig,
  progress?: RelayProgressContext,
): Promise<CallToolResult> {
  return withSessionFileLock(
    metadata.id,
    "relay-wait",
    async () => {
      const latest = (await sessionStore.readSession(metadata.id)) ?? metadata;
      const committedBeforeWait = await readRelayCommittedResult(metadata.id);
      if (committedBeforeWait && latest.relay?.resultTaskId === committedBeforeWait.taskId) {
        return committedResultAfterAck(latest, committedBeforeWait);
      }
      const taskId = latest.relay?.taskId;
      if (!taskId) return textResult(`Session ${metadata.id} has no Relay task id.`, true);
      const lastStatus = { value: latest.relay?.status };
      try {
        const task = await waitForRelayTaskEvents(relayConfig, taskId, {
          signal: progress?.signal,
          timeoutMs: 0,
          onTask: (observed) => observeTask(metadata.id, observed, lastStatus, progress),
        });
        return finishTask(latest, relayConfig, task);
      } catch (error) {
        const committed = await withSessionFileLock(
          metadata.id,
          "relay-finalize",
          () => readRelayCommittedResult(metadata.id),
          { timeoutMs: SESSION_LOCK_TIMEOUT_MS, signal: progress?.signal },
        );
        const refreshed = await sessionStore.readSession(metadata.id);
        if (committed && refreshed?.relay?.resultTaskId === committed.taskId) {
          return committedResultAfterAck(refreshed, committed);
        }
        throw error;
      }
    },
    { timeoutMs: SESSION_LOCK_TIMEOUT_MS, signal: progress?.signal },
  );
}

function progressContext(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): RelayProgressContext {
  const progressToken = extra?._meta?.progressToken;
  let progress = 0;
  return {
    signal: extra?.signal,
    onStatus:
      progressToken === undefined
        ? undefined
        : async (status) => {
            progress += 1;
            await extra
              .sendNotification(
                ProgressNotificationSchema.parse({
                  method: "notifications/progress",
                  params: { progressToken, progress, message: `Dragon Relay: ${status}` },
                }),
              )
              .catch(() => undefined);
          },
  };
}

function assertMatchingExpertRequest(metadata: SessionMetadata, options: RunOracleOptions): void {
  const storedFiles = metadata.options.file ?? [];
  const requestedFiles = options.file ?? [];
  if (
    metadata.options.prompt !== options.prompt ||
    metadata.options.model !== options.model ||
    JSON.stringify(storedFiles) !== JSON.stringify(requestedFiles) ||
    metadata.options.browserBundleFiles !== options.browserBundleFiles ||
    metadata.options.browserBundleFormat !== options.browserBundleFormat
  ) {
    throw new Error(`Recovery id ${metadata.id} is already bound to a different expert request.`);
  }
}

async function waitForCreatedSession(id: string): Promise<SessionMetadata> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const metadata = await sessionStore.readSession(id);
    if (metadata) return metadata;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Session ${id} exists but its metadata is not ready.`);
}

async function committedResultAfterAck(
  metadata: SessionMetadata,
  committed: Awaited<ReturnType<typeof readRelayCommittedResult>> & {},
): Promise<CallToolResult> {
  const acknowledged = await settleRelayAcknowledgement(metadata).catch(() => metadata);
  const latestCommitted = (await readRelayCommittedResult(metadata.id)) ?? committed;
  return committedResult(acknowledged, latestCommitted);
}

function committedResult(
  metadata: SessionMetadata,
  committed: Awaited<ReturnType<typeof readRelayCommittedResult>> & {},
): CallToolResult {
  return {
    content: [{ type: "text", text: committed.output || `Session ${metadata.id} is completed.` }],
    structuredContent: {
      sessionId: metadata.id,
      taskId: committed.taskId,
      status: metadata.status,
      output: committed.output,
      artifacts: summarizeArtifacts(committed.artifacts),
    },
  };
}

export function registerRelayExpertTools(server: McpServer): void {
  server.registerTool(
    "ask_expert",
    {
      title: "Ask an expert through Dragon Relay",
      description:
        "Submit one durable human-operated expert task and keep this MCP call blocked on a server-sent event stream until the answer is returned. Do not poll, resubmit, or ask the user to say continue while this call is pending. If the MCP transport is interrupted, recover the same session with await_expert; the remote task is not cancelled.",
      inputSchema: askExpertInputShape,
      outputSchema: relayExpertOutputShape,
    },
    (input, extra) => runAskExpert(input, progressContext(extra)),
  );
  server.registerTool(
    "await_expert",
    {
      title: "Resume waiting for a Dragon Relay expert task",
      description:
        "Reconnect to the event stream for an existing Dragon Relay session and block until its original task reaches a terminal state. This never creates a second task and does not poll task status.",
      inputSchema: awaitExpertInputShape,
      outputSchema: relayExpertOutputShape,
    },
    (input, extra) => runAwaitExpert(input, progressContext(extra)),
  );
}
