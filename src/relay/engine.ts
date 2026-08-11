import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assembleBrowserPrompt } from "../browser/prompt.js";
import type { RunOracleOptions, UsageSummary } from "../oracle.js";
import type { SessionArtifact } from "../sessionManager.js";
import { createRelayTaskFromFiles, downloadRelayAttachment, getRelayTask } from "./client.js";
import { readLocalResponseReceipt } from "./localReceiver.js";
import type { RelayLocalReceiver, RelayMetadata, RelaySessionConfig, RelayTask } from "./types.js";

export interface RelayRunResult {
  answerText: string;
  elapsedMs: number;
  usage: UsageSummary;
  artifacts: SessionArtifact[];
  relay: RelayMetadata;
}

export interface RelaySubmissionResult {
  task: RelayTask;
  relay: RelayMetadata;
  startedAt: number;
}

export interface RelayRunDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onTask?: (task: RelayTask) => void | Promise<void>;
  log?: (message: string) => void;
}

function wait(ms: number): Promise<void> {
  // The timer intentionally stays referenced: in detached relay workers it is the only
  // active handle while a human is processing the task on another device.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function submitRelayTask(
  runOptions: RunOracleOptions,
  config: RelaySessionConfig,
  options: { cwd: string; sessionId: string; localReceiver?: RelayLocalReceiver },
  deps: RelayRunDeps = {},
): Promise<RelaySubmissionResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const promptArtifacts = await assembleBrowserPrompt(
    {
      ...runOptions,
      browserAttachments: "always",
      browserInlineFiles: false,
      browserBundleFiles: runOptions.browserBundleFiles,
      browserBundleFormat: runOptions.browserBundleFormat,
    },
    { cwd: options.cwd },
  );
  const attachments = promptArtifacts.attachments.map((attachment) => ({
    path: attachment.path,
    filename: path.basename(attachment.path),
    displayPath: attachment.displayPath,
  }));
  const task = await createRelayTaskFromFiles(
    config,
    {
      requestId: runOptions.sessionId ?? options.sessionId,
      title: runOptions.slug || options.sessionId,
      prompt: promptArtifacts.composerText,
      modelHint: runOptions.model,
      source: options.cwd,
      sessionId: options.sessionId,
      localReceiver: options.localReceiver,
      expiresInMs: config.expiresInMs,
    },
    attachments,
    { onTask: deps.onTask },
  );
  const operatorUrl =
    config.operatorUrl ?? `${config.url.replace(/\/+$/, "")}/?task=${encodeURIComponent(task.id)}`;
  deps.log?.(`Relay task ${task.id} queued for human processing.`);
  deps.log?.(`Operator: ${operatorUrl}`);

  return {
    task,
    startedAt,
    relay: relayMetadata(config, task, operatorUrl),
  };
}

export async function runRelayEngine(
  runOptions: RunOracleOptions,
  config: RelaySessionConfig,
  options: { cwd: string; sessionId: string; artifactsDir: string },
  deps: RelayRunDeps = {},
): Promise<RelayRunResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? wait;
  const submission = await submitRelayTask(runOptions, config, options, deps);
  const { task, startedAt } = submission;

  const timeoutMs = config.timeoutMs ?? 24 * 60 * 60 * 1000;
  const pollIntervalMs = config.pollIntervalMs ?? 2_000;
  let current = task;
  let lastLoggedStatus = current.status;
  let lastProgressLogAt = startedAt;
  while (current.status !== "completed") {
    if (["cancelled", "expired"].includes(current.status)) {
      throw new Error(`Relay task ${task.id} ended with status ${current.status}.`);
    }
    if (timeoutMs > 0 && now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for human response to relay task ${task.id}.`);
    }
    await sleep(pollIntervalMs);
    current = await getRelayTask(config, task.id);
    await deps.onTask?.(current);
    if (current.status !== lastLoggedStatus || now() - lastProgressLogAt >= 30_000) {
      const elapsedSeconds = Math.max(0, Math.round((now() - startedAt) / 1000));
      deps.log?.(
        `[relay] Waiting for human response (status=${current.status}, elapsed=${elapsedSeconds}s).`,
      );
      lastLoggedStatus = current.status;
      lastProgressLogAt = now();
    }
  }
  return collectRelayTaskResult(current, config, options.artifactsDir, startedAt, now());
}

export async function collectRelayTaskResult(
  task: RelayTask,
  config: RelaySessionConfig,
  artifactsDir: string,
  startedAt = Date.now(),
  completedAt = Date.now(),
): Promise<RelayRunResult> {
  if (task.status !== "completed") {
    throw new Error(`Relay task ${task.id} is ${task.status}, not completed.`);
  }
  const response = task.response;
  if (!response) throw new Error(`Relay task ${task.id} completed without a response.`);

  const artifacts: SessionArtifact[] = [];
  const localReceipt = await readLocalResponseReceipt(artifactsDir);
  if (localReceipt) {
    const markdownSha256 = createHash("sha256").update(response.markdown).digest("hex");
    if (localReceipt.taskId !== task.id || localReceipt.markdownSha256 !== markdownSha256) {
      throw new Error(`Local response receipt does not match Relay task ${task.id}.`);
    }
    for (const attachment of localReceipt.artifacts) {
      const stat = await fs.stat(attachment.path);
      if (
        stat.size !== attachment.sizeBytes ||
        (await sha256File(attachment.path)) !== attachment.sha256
      ) {
        throw new Error(`Local response attachment failed verification: ${attachment.label}`);
      }
      artifacts.push({
        kind: "file",
        path: attachment.path,
        label: attachment.label,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
        transfer: { status: "completed", bytes: attachment.sizeBytes },
        origin: { mode: "bridge", host: "127.0.0.1" },
      });
    }
  }
  for (const attachment of response.attachments) {
    const localPath = await downloadRelayAttachment(config, task.id, attachment, artifactsDir);
    artifacts.push({
      kind: "file",
      path: localPath,
      label: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      transfer: { status: "completed", bytes: attachment.sizeBytes },
      origin: { mode: "bridge", host: config.url },
    });
  }
  return {
    answerText: response.markdown,
    elapsedMs: Math.max(0, completedAt - startedAt),
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 },
    artifacts,
    relay: relayMetadata(
      config,
      task,
      config.operatorUrl ??
        `${config.url.replace(/\/+$/, "")}/?task=${encodeURIComponent(task.id)}`,
    ),
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function relayMetadata(
  config: RelaySessionConfig,
  task: RelayTask,
  operatorUrl: string,
): RelayMetadata {
  return {
    config: {
      url: config.url,
      operatorUrl: config.operatorUrl,
      pollIntervalMs: config.pollIntervalMs,
      timeoutMs: config.timeoutMs,
      expiresInMs: config.expiresInMs,
      tokenConfigured: Boolean(config.token),
    },
    taskId: task.id,
    status: task.status,
    submittedAt: task.createdAt,
    lastObservedAt: new Date().toISOString(),
    completedAt: task.completedAt,
    operatorUrl,
  };
}
