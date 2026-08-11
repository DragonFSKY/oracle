import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { RunOracleOptions } from "../oracle.js";
import type { SessionArtifact, SessionMetadata } from "../sessionManager.js";
import { withSessionFileLock } from "../sessionManager.js";
import { readSessionRelayToken, sessionStore } from "../sessionStore.js";
import { acknowledgeRelayTask, getRelayTask, RelayRequestError } from "../relay/client.js";
import { collectRelayTaskResult, relayMetadata, submitRelayTask } from "../relay/engine.js";
import type {
  RelayMetadata,
  RelayLocalReceiver,
  RelaySessionConfig,
  RelayTask,
  RelayTaskStatus,
} from "../relay/types.js";

const PENDING_RELAY_STATUSES = new Set<RelayTaskStatus>([
  "uploading",
  "queued",
  "claimed",
  "awaiting-response",
]);

export interface RelayRefreshResult {
  metadata: SessionMetadata;
  state: "pending" | "completed" | "failed";
}

export interface RelayCommittedResult {
  taskId: string;
  digest: string;
  output: string;
  artifacts?: SessionArtifact[];
  committedAt: string;
}

export function isRelayBackedSession(metadata: SessionMetadata): boolean {
  return (
    metadata.mode === "relay" ||
    metadata.options?.mode === "relay" ||
    metadata.browser?.config?.transport === "relay" ||
    metadata.options?.browserConfig?.transport === "relay"
  );
}

export async function submitRelaySession({
  sessionMeta,
  runOptions,
  relayConfig,
  cwd,
  localReceiver,
  log = () => {},
}: {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  relayConfig: RelaySessionConfig;
  cwd: string;
  localReceiver?: RelayLocalReceiver;
  log?: (message: string) => void;
}): Promise<SessionMetadata> {
  const startedAt = new Date().toISOString();
  const model = runOptions.model ?? sessionMeta.model;
  await sessionStore.updateSession(sessionMeta.id, {
    status: "running",
    startedAt,
    mode: sessionMeta.mode,
  });
  if (model) {
    await sessionStore.updateModelRun(sessionMeta.id, model, {
      status: "running",
      startedAt,
    });
  }

  try {
    const submission = await submitRelayTask(
      { ...runOptions, sessionId: runOptions.sessionId ?? sessionMeta.id },
      relayConfig,
      { cwd, sessionId: sessionMeta.id, localReceiver },
      {
        log,
        onTask: async (task) => {
          await bindRelayTaskToSession(sessionMeta.id, task, relayConfig);
        },
      },
    );
    const bound = await sessionStore.readSession(sessionMeta.id);
    return await sessionStore.updateSession(sessionMeta.id, {
      status: "running",
      relay: {
        ...submission.relay,
        inputFingerprint: bound?.relay?.inputFingerprint,
      },
      errorMessage: undefined,
      response: { status: submission.task.status },
      transport: undefined,
      error: undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = new Date().toISOString();
    if (model) {
      await sessionStore.updateModelRun(sessionMeta.id, model, {
        status: "error",
        completedAt,
      });
    }
    await sessionStore.updateSession(sessionMeta.id, {
      status: "error",
      completedAt,
      errorMessage: message,
      response: { status: "error", incompleteReason: "incomplete-capture" },
      error: { category: "internal", message },
    });
    throw error;
  }
}

export async function bindRelayTaskToSession(
  sessionId: string,
  task: RelayTask,
  config: RelaySessionConfig,
): Promise<SessionMetadata> {
  const current = await sessionStore.readSession(sessionId);
  if (!current) throw new Error(`No session found with ID ${sessionId}`);
  if (task.requestId && task.requestId !== sessionId) {
    throw new Error(
      `Relay task ${task.id} belongs to request ${task.requestId}, not ${sessionId}.`,
    );
  }
  const operatorUrl =
    config.operatorUrl ?? `${config.url.replace(/\/+$/, "")}/?task=${encodeURIComponent(task.id)}`;
  return sessionStore.updateSession(sessionId, {
    relay: {
      ...relayMetadata(config, task, operatorUrl),
      inputFingerprint: current.relay?.inputFingerprint,
      resultTaskId: current.relay?.resultTaskId,
      resultDigest: current.relay?.resultDigest,
      resultCommittedAt: current.relay?.resultCommittedAt,
      ackStatus: current.relay?.ackStatus,
    },
    response: { status: task.status },
  });
}

export async function refreshRelaySessionOnce(sessionId: string): Promise<RelayRefreshResult> {
  const metadata = await sessionStore.readSession(sessionId);
  if (!metadata) {
    throw new Error(`No session found with ID ${sessionId}`);
  }
  if (!isRelayBackedSession(metadata) || !metadata.relay?.taskId) {
    return { metadata, state: metadata.status === "completed" ? "completed" : "failed" };
  }
  if (metadata.relay?.resultTaskId && ["completed", "partial"].includes(metadata.status)) {
    const updated = await settleRelayAcknowledgement(metadata);
    return { metadata: updated, state: "completed" };
  }

  const config = await relayConfigFromMetadata(metadata);
  const task = await getRelayTask(config, metadata.relay.taskId);
  return refreshRelaySessionFromTask(sessionId, task, config);
}

export async function refreshRelaySessionFromTask(
  sessionId: string,
  task: RelayTask,
  providedConfig?: RelaySessionConfig,
): Promise<RelayRefreshResult> {
  const lockTimeoutMs = Math.max(providedConfig?.timeoutMs ?? 0, 24 * 60 * 60 * 1000);
  return withSessionFileLock(
    sessionId,
    "relay-finalize",
    async () => {
      const metadata = await sessionStore.readSession(sessionId);
      if (!metadata) throw new Error(`No session found with ID ${sessionId}`);
      if (!metadata.relay?.taskId || metadata.relay.taskId !== task.id) {
        throw new Error(`Session ${sessionId} is not bound to Relay task ${task.id}.`);
      }
      const config = providedConfig ?? (await relayConfigFromMetadata(metadata));
      const digest = relayTaskResultDigest(task);
      const committed = await readRelayCommittedResult(sessionId);
      if (
        committed?.taskId === task.id &&
        committed.digest === digest &&
        metadata.relay.resultTaskId === task.id
      ) {
        const updated = await settleRelayAcknowledgement(metadata, config);
        return { metadata: updated, state: "completed" };
      }
      const relay = mergeRelayObservation(metadata.relay, task.status, task.completedAt);

      if (PENDING_RELAY_STATUSES.has(task.status)) {
        const updated = await sessionStore.updateSession(sessionId, {
          status: "running",
          relay,
          response: { status: task.status },
        });
        return { metadata: updated, state: "pending" };
      }

      if (task.status !== "completed") {
        const message = `Relay task ${task.id} ended with status ${task.status}.`;
        const completedAt = new Date().toISOString();
        if (metadata.model) {
          await sessionStore.updateModelRun(sessionId, metadata.model, {
            status: "error",
            completedAt,
          });
        }
        const updated = await sessionStore.updateSession(sessionId, {
          status: "error",
          completedAt,
          errorMessage: message,
          relay,
          response: { status: task.status, incompleteReason: "incomplete-capture" },
          error: { category: "internal", message },
        });
        return { metadata: updated, state: "failed" };
      }

      const { dir, log: logPath } = await sessionStore.getPaths(sessionId);
      const startedAt = Date.parse(metadata.startedAt ?? metadata.createdAt);
      const result = await collectRelayTaskResult(
        task,
        config,
        path.join(dir, "artifacts"),
        Number.isFinite(startedAt) ? startedAt : Date.now(),
        Date.now(),
      );
      const completedAt = new Date().toISOString();
      const committedResult: RelayCommittedResult = {
        taskId: task.id,
        digest,
        output: result.answerText,
        artifacts: result.artifacts,
        committedAt: completedAt,
      };
      await writeJsonAtomic(path.join(dir, "relay-result.json"), committedResult);
      const marker = `[relay-result:${task.id}:${digest}]`;
      const log = await fs.readFile(logPath, "utf8").catch(() => "");
      if (!log.includes(marker)) {
        const answer = result.answerText.endsWith("\n")
          ? result.answerText
          : `${result.answerText}\n`;
        await fs.appendFile(logPath, `${marker}\nAnswer:\n${answer}`, "utf8");
      }
      if (metadata.model) {
        await sessionStore.updateModelRun(sessionId, metadata.model, {
          status: "completed",
          completedAt,
          usage: result.usage,
        });
      }
      const updated = await sessionStore.updateSession(sessionId, {
        status: "completed",
        completedAt,
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        errorMessage: undefined,
        relay: {
          ...result.relay,
          inputFingerprint: metadata.relay.inputFingerprint,
          resultTaskId: task.id,
          resultDigest: digest,
          resultCommittedAt: completedAt,
          ackStatus: "pending",
        },
        artifacts: mergeArtifacts(metadata.artifacts, result.artifacts),
        response: { status: "completed" },
        transport: undefined,
        error: undefined,
      });
      return {
        metadata: await settleRelayAcknowledgement(updated, config),
        state: "completed",
      };
    },
    { timeoutMs: lockTimeoutMs },
  );
}

export async function readRelayCommittedResult(
  sessionId: string,
): Promise<RelayCommittedResult | null> {
  try {
    const { dir } = await sessionStore.getPaths(sessionId);
    return JSON.parse(
      await fs.readFile(path.join(dir, "relay-result.json"), "utf8"),
    ) as RelayCommittedResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function settleRelayAcknowledgement(
  metadata: SessionMetadata,
  providedConfig?: RelaySessionConfig,
): Promise<SessionMetadata> {
  if (!metadata.relay?.taskId || !metadata.relay.resultTaskId) return metadata;
  if (metadata.relay.ackStatus === "succeeded") return metadata;
  const config = providedConfig ?? (await relayConfigFromMetadata(metadata));
  try {
    await acknowledgeRelayTask(config, metadata.relay.taskId);
  } catch (error) {
    if (!(error instanceof RelayRequestError && error.status === 404)) return metadata;
  }
  return sessionStore.updateSession(metadata.id, {
    relay: { ...metadata.relay, ackStatus: "succeeded" },
  });
}

function relayTaskResultDigest(task: RelayTask): string {
  return createHash("sha256")
    .update(JSON.stringify({ id: task.id, completedAt: task.completedAt, response: task.response }))
    .digest("hex");
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function relayConfigFromMetadata(
  metadata: SessionMetadata,
): Promise<RelaySessionConfig> {
  const stored = metadata.options?.relayConfig;
  const token = await readSessionRelayToken(metadata.id);
  if (!stored || !token) {
    throw new Error(`Session ${metadata.id} is missing Relay configuration or token.`);
  }
  return { ...stored, token };
}

function mergeRelayObservation(
  relay: RelayMetadata,
  status: RelayTaskStatus,
  completedAt?: string,
): RelayMetadata {
  return {
    ...relay,
    status,
    lastObservedAt: new Date().toISOString(),
    completedAt,
  };
}

function mergeArtifacts(
  existing: SessionArtifact[] | undefined,
  additions: SessionArtifact[] | undefined,
): SessionArtifact[] | undefined {
  const merged = new Map<string, SessionArtifact>();
  for (const artifact of existing ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  for (const artifact of additions ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}
