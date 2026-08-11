import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  RelayAttachmentDescriptor,
  RelayCreateTaskRequest,
  RelayCreateUploadTaskRequest,
  RelayLocalReceiver,
  RelaySessionConfig,
  RelayTask,
} from "./types.js";

const RELAY_UPLOAD_ATTEMPTS = 3;
const RELAY_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const TERMINAL_RELAY_STATUSES = new Set(["completed", "cancelled", "expired"]);

export class RelayRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = status === undefined || status === 408 || status === 429 || status >= 500,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RelayRequestError";
  }
}

function baseUrl(config: RelaySessionConfig): string {
  return config.url.replace(/\/+$/, "");
}

async function relayFetch(
  config: RelaySessionConfig,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(`${baseUrl(config)}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RelayRequestError(`Relay ${method} ${pathname} failed: ${detail}`, undefined, true, {
      cause: error,
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new RelayRequestError(
      `Relay ${method} ${pathname} failed (${response.status}): ${body || response.statusText}`,
      response.status,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  return response;
}

export interface RelayFileUpload {
  path: string;
  filename: string;
  displayPath?: string;
  mimeType?: string;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function uploadRelayFile(
  config: RelaySessionConfig,
  task: RelayTask,
  attachment: RelayAttachmentDescriptor,
  file: RelayFileUpload,
): Promise<void> {
  const advertisedChunkBytes = task.uploadChunkBytes;
  if (!advertisedChunkBytes || advertisedChunkBytes <= 0 || attachment.sizeBytes === 0) {
    const uploadInit = {
      method: "PUT",
      headers: {
        "Content-Type": file.mimeType || "application/octet-stream",
        "Content-Length": String(attachment.sizeBytes),
      },
      body:
        attachment.sizeBytes === 0
          ? Buffer.alloc(0)
          : (createReadStream(file.path) as unknown as BodyInit),
      duplex: "half",
      signal: AbortSignal.timeout(RELAY_UPLOAD_TIMEOUT_MS),
    } satisfies RequestInit & { duplex: "half" };
    await relayFetch(
      config,
      `/v1/tasks/${encodeURIComponent(task.id)}/attachments/${encodeURIComponent(attachment.id)}`,
      uploadInit,
    );
    return;
  }

  const chunkBytes = Math.max(1, Math.floor(advertisedChunkBytes));
  for (let start = 0; start < attachment.sizeBytes; start += chunkBytes) {
    const end = Math.min(attachment.sizeBytes - 1, start + chunkBytes - 1);
    const pathname = `/v1/tasks/${encodeURIComponent(task.id)}/attachments/${encodeURIComponent(attachment.id)}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= RELAY_UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        const uploadInit = {
          method: "PUT",
          headers: {
            "Content-Type": file.mimeType || "application/octet-stream",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${attachment.sizeBytes}`,
          },
          body: createReadStream(file.path, { start, end }) as unknown as BodyInit,
          duplex: "half",
          signal: AbortSignal.timeout(RELAY_UPLOAD_TIMEOUT_MS),
        } satisfies RequestInit & { duplex: "half" };
        await relayFetch(config, pathname, uploadInit);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof RelayRequestError) || error.retryable;
        if (!retryable || attempt === RELAY_UPLOAD_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    if (lastError) throw lastError;
  }
}

export async function createRelayTaskFromFiles(
  config: RelaySessionConfig,
  request: Omit<RelayCreateTaskRequest, "attachments">,
  files: RelayFileUpload[],
  options: { onTask?: (task: RelayTask) => void | Promise<void> } = {},
): Promise<RelayTask> {
  const attachments = await Promise.all(
    files.map(async (file) => {
      const stat = await fs.stat(file.path);
      return {
        filename: file.filename,
        displayPath: file.displayPath,
        mimeType: file.mimeType,
        sizeBytes: stat.size,
        sha256: await sha256File(file.path),
      };
    }),
  );
  const stagedRequest: RelayCreateUploadTaskRequest = { ...request, attachments };
  const stagedResponse = await relayFetch(config, "/v1/tasks/uploads", {
    method: "POST",
    body: JSON.stringify(stagedRequest),
  });
  const staged = (await stagedResponse.json()) as RelayTask;
  await options.onTask?.(staged);
  if (staged.status !== "uploading") return staged;
  // Keep the staged task durable if an upload or publish request fails. Retrying the
  // same requestId resumes the upload and also recovers a lost publish response.
  for (const [index, attachment] of staged.attachments.entries()) {
    const file = files[index];
    if (!file) throw new Error("Relay upload descriptor mismatch.");
    await uploadRelayFile(config, staged, attachment, file);
  }
  const published = await relayFetch(config, `/v1/tasks/${encodeURIComponent(staged.id)}/publish`, {
    method: "POST",
    body: "{}",
  });
  const task = (await published.json()) as RelayTask;
  await options.onTask?.(task);
  return task;
}

export async function createRelayTask(
  config: RelaySessionConfig,
  request: RelayCreateTaskRequest,
): Promise<RelayTask> {
  const response = await relayFetch(config, "/v1/tasks", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return (await response.json()) as RelayTask;
}

export async function getRelayTask(config: RelaySessionConfig, taskId: string): Promise<RelayTask> {
  const response = await relayFetch(config, `/v1/tasks/${encodeURIComponent(taskId)}`);
  return (await response.json()) as RelayTask;
}

export async function updateRelayTaskLocalReceiver(
  config: RelaySessionConfig,
  taskId: string,
  localReceiver: RelayLocalReceiver,
): Promise<RelayTask> {
  const response = await relayFetch(
    config,
    `/v1/tasks/${encodeURIComponent(taskId)}/local-receiver`,
    {
      method: "POST",
      body: JSON.stringify(localReceiver),
    },
  );
  return (await response.json()) as RelayTask;
}

export async function getRelayTaskByRequestId(
  config: RelaySessionConfig,
  requestId: string,
): Promise<RelayTask> {
  const response = await relayFetch(
    config,
    `/v1/tasks/by-request/${encodeURIComponent(requestId)}`,
  );
  return (await response.json()) as RelayTask;
}

export interface WaitForRelayTaskEventsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onTask?: (task: RelayTask) => void | Promise<void>;
  reconnectDelayMs?: number;
}

export async function waitForRelayTaskEvents(
  config: RelaySessionConfig,
  taskId: string,
  options: WaitForRelayTaskEventsOptions = {},
): Promise<RelayTask> {
  const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 24 * 60 * 60 * 1000;
  const hasDeadline = timeoutMs > 0;
  const deadline = hasDeadline ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  let reconnectDelayMs = options.reconnectDelayMs ?? 250;
  let lastError: unknown;
  let lastRevision: number | undefined;

  while (!hasDeadline || Date.now() < deadline) {
    if (options.signal?.aborted) throw relayWaitAbortError(taskId);
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - Date.now());
    const timeout = hasDeadline ? setTimeout(() => controller.abort(), remainingMs) : undefined;
    timeout?.unref?.();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await relayFetch(config, `/v1/tasks/${encodeURIComponent(taskId)}/events`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("text/event-stream")) {
        throw new RelayRequestError(
          `Relay event endpoint returned unexpected content type ${contentType || "(missing)"}.`,
          response.status,
          false,
        );
      }
      if (!response.body) throw new RelayRequestError("Relay event stream has no response body.");
      for await (const task of readRelayTaskEvents(response.body)) {
        await options.onTask?.(task);
        if (TERMINAL_RELAY_STATUSES.has(task.status)) return task;
        if (
          task.revision !== undefined &&
          lastRevision !== undefined &&
          task.revision > lastRevision
        ) {
          reconnectDelayMs = options.reconnectDelayMs ?? 250;
        }
        lastRevision = Math.max(lastRevision ?? 0, task.revision ?? 0);
      }
      lastError = new RelayRequestError("Relay event stream closed before task completion.");
    } catch (error) {
      if (options.signal?.aborted) throw relayWaitAbortError(taskId);
      if (hasDeadline && Date.now() >= deadline) break;
      if (error instanceof RelayRequestError && !error.retryable) throw error;
      lastError = error;
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
    await abortableDelay(
      hasDeadline
        ? Math.min(reconnectDelayMs, Math.max(1, deadline - Date.now()))
        : reconnectDelayMs,
      options.signal,
    );
    reconnectDelayMs = Math.min(5_000, reconnectDelayMs * 2);
  }
  const detail = lastError instanceof Error ? ` Last transport error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for relay task ${taskId}.${detail}`);
}

async function* readRelayTaskEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<RelayTask> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match = /\r?\n\r?\n|\r\r/.exec(buffer);
    while (match?.index !== undefined) {
      const frame = buffer.slice(0, match.index).replace(/\r\n|\r/g, "\n");
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as RelayTask;
      match = /\r?\n\r?\n|\r\r/.exec(buffer);
    }
  }
}

function relayWaitAbortError(taskId: string): Error {
  const error = new Error(
    `Stopped waiting for relay task ${taskId}; the remote task is still active.`,
  );
  error.name = "AbortError";
  return error;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(relayWaitAbortError("request"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(relayWaitAbortError("request"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function cancelRelayTask(
  config: RelaySessionConfig,
  taskId: string,
): Promise<RelayTask> {
  const response = await relayFetch(config, `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    body: "{}",
  });
  return (await response.json()) as RelayTask;
}

export async function acknowledgeRelayTask(
  config: RelaySessionConfig,
  taskId: string,
): Promise<void> {
  await relayFetch(config, `/v1/tasks/${encodeURIComponent(taskId)}/ack`, {
    method: "POST",
    body: "{}",
  });
}

export async function downloadRelayAttachment(
  config: RelaySessionConfig,
  taskId: string,
  attachment: RelayAttachmentDescriptor,
  destinationDir: string,
): Promise<string> {
  const response = await relayFetch(
    config,
    `/v1/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachment.id)}`,
  );
  await fs.mkdir(destinationDir, { recursive: true });
  const safeName = path.basename(attachment.filename).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const parsed = path.parse(safeName || "attachment.bin");
  const destination = path.join(
    destinationDir,
    `${parsed.name || "attachment"}-${attachment.id}${parsed.ext}`,
  );
  const existing = await fs.stat(destination).catch(() => null);
  if (existing?.isFile() && existing.size === attachment.sizeBytes) {
    if ((await sha256File(destination)) === attachment.sha256) return destination;
  }
  if (!response.body) throw new Error(`Relay attachment ${attachment.filename} has no body.`);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      hash.update(value);
      callback(null, value);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
      verifier,
      createWriteStream(temporary, { flags: "wx" }),
    );
    if (bytes !== attachment.sizeBytes || hash.digest("hex") !== attachment.sha256) {
      throw new Error(`Relay attachment checksum mismatch for ${attachment.filename}.`);
    }
    await fs.rename(temporary, destination);
    return destination;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
