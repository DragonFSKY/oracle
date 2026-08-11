import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getOracleHomeDir } from "../oracleHome.js";
import type {
  RelayAttachmentDescriptor,
  RelayCreateTaskRequest,
  RelayCreateUploadTaskRequest,
  RelayLocalReceiver,
  RelayResponseSubmission,
  RelayResponseUploadPlan,
  RelayResponseUploadRequest,
  RelayTask,
} from "./types.js";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENT_BYTES = 0;
const DEFAULT_MAX_TASK_BYTES = 0;
const DEFAULT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_RESPONSE_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000;
const INDEFINITE_EXPIRY = "9999-12-31T23:59:59.999Z";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;

export interface RelayServerOptions {
  host?: string;
  port?: number;
  producerToken?: string;
  operatorToken?: string;
  dataDir?: string;
  maxBodyBytes?: number;
  maxAttachmentBytes?: number;
  maxTaskBytes?: number;
  terminalRetentionMs?: number;
  logger?: (message: string) => void;
}

export interface RelayServerInstance {
  host: string;
  port: number;
  producerToken: string;
  operatorToken: string;
  close(): Promise<void>;
}

type RelayLogger = (message: string) => void;
type RelayTaskSubscriber = (task: RelayTask) => void;

interface StoredResponseUpload extends RelayResponseUploadPlan {
  operator: string;
  markdown: string;
  createdAt: string;
  signature?: string;
}

class RelayTaskStore {
  private readonly subscribers = new Map<string, Set<RelayTaskSubscriber>>();
  private readonly lockTails = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly logger: RelayLogger,
  ) {}

  async ensure(): Promise<void> {
    await fs.mkdir(path.join(this.root, "tasks"), { recursive: true });
  }

  subscribe(id: string, subscriber: RelayTaskSubscriber): () => void {
    const key = safeId(id);
    const listeners = this.subscribers.get(key) ?? new Set<RelayTaskSubscriber>();
    listeners.add(subscriber);
    this.subscribers.set(key, listeners);
    return () => {
      const current = this.subscribers.get(key);
      current?.delete(subscriber);
      if (current?.size === 0) this.subscribers.delete(key);
    };
  }

  closeSubscribers(): void {
    this.subscribers.clear();
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.lockTails.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.lockTails.get(key) === tail) this.lockTails.delete(key);
    }
  }

  private taskDir(id: string): string {
    return path.join(this.root, "tasks", safeId(id));
  }

  private taskPath(id: string): string {
    return path.join(this.taskDir(id), "task.json");
  }

  async create(request: RelayCreateTaskRequest): Promise<RelayTask> {
    const requestId = normalizeRequestId(request.requestId);
    const requestFingerprint = relayRequestFingerprint(request);
    return this.withLock(`request:${requestId ?? randomUUID()}`, async () => {
      const existing = requestId ? await this.findByRequestIdRaw(requestId) : null;
      if (existing) return assertIdempotentRequest(existing, requestFingerprint);
      const id = randomUUID();
      const now = new Date();
      const taskDir = this.taskDir(id);
      await fs.mkdir(path.join(taskDir, "request"), { recursive: true });
      await fs.mkdir(path.join(taskDir, "response"), { recursive: true });
      const attachments = await this.writeAttachments(id, "request", request.attachments ?? []);
      const task: RelayTask = {
        id,
        requestId,
        requestFingerprint,
        status: "queued",
        title: request.title?.trim() || id,
        prompt: request.prompt,
        modelHint: request.modelHint,
        source: request.source,
        sessionId: request.sessionId,
        localReceiver: normalizeLocalReceiver(request.localReceiver),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: taskExpiry(now, request.expiresInMs),
        attachments,
      };
      await this.write(task);
      relayLog(this.logger, "task.created", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        requestAttachments: task.attachments.length,
        requestBytes: sumAttachmentBytes(task.attachments),
        expiresAt: task.expiresAt,
      });
      return task;
    });
  }

  async createUpload(
    request: RelayCreateUploadTaskRequest,
    limits: { maxAttachmentBytes: number; maxTaskBytes: number },
  ): Promise<RelayTask> {
    const requestId = normalizeRequestId(request.requestId);
    const requestFingerprint = relayRequestFingerprint(request);
    return this.withLock(`request:${requestId ?? randomUUID()}`, async () => {
      const existing = requestId ? await this.findByRequestIdRaw(requestId) : null;
      if (existing) return assertIdempotentRequest(existing, requestFingerprint);
      const totalBytes = request.attachments.reduce((total, attachment) => {
        if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
          throw new HttpError(400, "Attachment size must be a non-negative integer.");
        }
        if (exceedsLimit(attachment.sizeBytes, limits.maxAttachmentBytes)) {
          throw new HttpError(413, "Attachment exceeds the per-file size limit.");
        }
        if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) {
          throw new HttpError(400, "Attachment SHA-256 is invalid.");
        }
        if (attachment.sizeBytes === 0 && attachment.sha256.toLowerCase() !== EMPTY_SHA256) {
          throw new HttpError(400, "Empty attachment checksum mismatch.");
        }
        return total + attachment.sizeBytes;
      }, 0);
      if (exceedsLimit(totalBytes, limits.maxTaskBytes)) {
        throw new HttpError(413, "Attachments exceed the per-task size limit.");
      }
      const id = randomUUID();
      const now = new Date();
      const taskDir = this.taskDir(id);
      await fs.mkdir(path.join(taskDir, "request"), { recursive: true });
      await fs.mkdir(path.join(taskDir, "response"), { recursive: true });
      const attachments: RelayAttachmentDescriptor[] = request.attachments.map((attachment) => ({
        id: randomUUID(),
        filename: safeFilename(attachment.filename),
        displayPath: attachment.displayPath || attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256.toLowerCase(),
        direction: "request",
      }));
      const task: RelayTask = {
        id,
        requestId,
        requestFingerprint,
        status: "uploading",
        title: request.title?.trim() || id,
        prompt: request.prompt,
        modelHint: request.modelHint,
        source: request.source,
        sessionId: request.sessionId,
        localReceiver: normalizeLocalReceiver(request.localReceiver),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: taskExpiry(now, request.expiresInMs),
        attachments,
      };
      await this.write(task);
      relayLog(this.logger, "task.upload_staged", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        requestAttachments: attachments.length,
        requestBytes: totalBytes,
      });
      return task;
    });
  }

  async uploadRequestAttachment(
    id: string,
    attachmentId: string,
    input: NodeJS.ReadableStream,
    maxAttachmentBytes: number,
    range?: { start: number; end: number; total: number },
  ): Promise<RelayAttachmentDescriptor> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      if (task.status !== "uploading") throw new HttpError(409, `Task is ${task.status}.`);
      const attachment = task.attachments.find((entry) => entry.id === attachmentId);
      if (!attachment) throw new HttpError(404, "Attachment not found.");
      return this.uploadStagedAttachment(task, attachment, input, maxAttachmentBytes, range);
    });
  }

  private async uploadStagedAttachment(
    task: RelayTask,
    attachment: RelayAttachmentDescriptor,
    input: NodeJS.ReadableStream,
    maxAttachmentBytes: number,
    range?: { start: number; end: number; total: number },
  ): Promise<RelayAttachmentDescriptor> {
    if (range) {
      return this.uploadStagedAttachmentChunk(task, attachment, input, maxAttachmentBytes, range);
    }
    const target = this.attachmentPath(task.id, attachment);
    const temporary = `${target}.${process.pid}.upload`;
    let bytes = 0;
    const hash = createHash("sha256");
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (exceedsLimit(bytes, maxAttachmentBytes) || bytes > attachment.sizeBytes) {
          callback(new HttpError(413, "Attachment upload is too large."));
          return;
        }
        hash.update(buffer);
        callback(null, buffer);
      },
    });
    try {
      await pipeline(input, verifier, createWriteStream(temporary, { flags: "wx" }));
      if (bytes !== attachment.sizeBytes) throw new HttpError(400, "Attachment size mismatch.");
      if (hash.digest("hex") !== attachment.sha256) {
        throw new HttpError(400, "Attachment checksum mismatch.");
      }
      await fs.rename(temporary, target);
      relayLog(this.logger, "attachment.uploaded", {
        taskId: task.id,
        sessionId: task.sessionId,
        direction: attachment.direction,
        bytes,
      });
      return attachment;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async uploadStagedAttachmentChunk(
    task: RelayTask,
    attachment: RelayAttachmentDescriptor,
    input: NodeJS.ReadableStream,
    maxAttachmentBytes: number,
    range: { start: number; end: number; total: number },
  ): Promise<RelayAttachmentDescriptor> {
    if (
      range.total !== attachment.sizeBytes ||
      range.start < 0 ||
      range.end < range.start ||
      range.end >= range.total
    ) {
      throw new HttpError(400, "Attachment content range is invalid.");
    }
    const expectedBytes = range.end - range.start + 1;
    if (exceedsLimit(expectedBytes, maxAttachmentBytes)) {
      throw new HttpError(413, "Attachment upload chunk is too large.");
    }

    const target = this.attachmentPath(task.id, attachment);
    const temporary = `${target}.chunks.upload`;
    const completedStat = await fs.stat(target).catch(() => null);
    if (completedStat?.size === attachment.sizeBytes) {
      await consumeExactBytes(input, expectedBytes, maxAttachmentBytes);
      return attachment;
    }

    const partialStat = await fs.stat(temporary).catch(() => null);
    const currentBytes = partialStat?.size ?? 0;
    if (currentBytes >= range.end + 1) {
      await consumeExactBytes(input, expectedBytes, maxAttachmentBytes);
      return attachment;
    }
    if (currentBytes !== range.start) {
      throw new HttpError(
        409,
        `Attachment upload offset mismatch: expected ${currentBytes}, received ${range.start}.`,
      );
    }

    let bytes = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > expectedBytes || exceedsLimit(bytes, maxAttachmentBytes)) {
          callback(new HttpError(413, "Attachment upload chunk is too large."));
          return;
        }
        callback(null, buffer);
      },
    });
    try {
      await pipeline(
        input,
        verifier,
        createWriteStream(temporary, { flags: range.start === 0 ? "w" : "a" }),
      );
      if (bytes !== expectedBytes) throw new HttpError(400, "Attachment chunk size mismatch.");
      if (range.end + 1 < range.total) {
        relayLog(this.logger, "attachment.upload_chunk", {
          taskId: task.id,
          sessionId: task.sessionId,
          direction: attachment.direction,
          chunkBytes: bytes,
          uploadedBytes: range.end + 1,
          totalBytes: range.total,
        });
        return attachment;
      }

      const stat = await fs.stat(temporary);
      if (stat.size !== attachment.sizeBytes) {
        throw new HttpError(400, "Attachment size mismatch.");
      }
      if ((await sha256File(temporary)) !== attachment.sha256) {
        throw new HttpError(400, "Attachment checksum mismatch.");
      }
      await fs.rename(temporary, target);
      relayLog(this.logger, "attachment.uploaded", {
        taskId: task.id,
        sessionId: task.sessionId,
        direction: attachment.direction,
        bytes: attachment.sizeBytes,
      });
      return attachment;
    } catch (error) {
      await fs.truncate(temporary, range.start).catch(() => {});
      throw error;
    }
  }

  async publish(id: string): Promise<RelayTask> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      if (task.status !== "uploading") return task;
      for (const attachment of task.attachments) {
        const stat = await fs.stat(this.attachmentPath(id, attachment)).catch(() => null);
        if (!stat || stat.size !== attachment.sizeBytes) {
          throw new HttpError(409, "Not all attachments have been uploaded.");
        }
      }
      task.status = "queued";
      task.updatedAt = new Date().toISOString();
      await this.write(task);
      relayLog(this.logger, "task.created", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        requestAttachments: task.attachments.length,
        requestBytes: sumAttachmentBytes(task.attachments),
        expiresAt: task.expiresAt,
      });
      return task;
    });
  }

  async stageResponseUpload(
    id: string,
    request: RelayResponseUploadRequest,
    limits: { maxAttachmentBytes: number; maxTaskBytes: number },
  ): Promise<RelayResponseUploadPlan> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      assertActiveTask(task);
      const requestedAttachments = Array.isArray(request.attachments) ? request.attachments : [];
      if (!request.markdown?.trim() && requestedAttachments.length === 0) {
        throw new HttpError(400, "Response text or an attachment is required.");
      }
      const totalBytes = requestedAttachments.reduce((total, attachment) => {
        if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
          throw new HttpError(400, "Attachment size must be a non-negative integer.");
        }
        if (exceedsLimit(attachment.sizeBytes, limits.maxAttachmentBytes)) {
          throw new HttpError(413, "Attachment exceeds the per-file size limit.");
        }
        if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) {
          throw new HttpError(400, "Attachment SHA-256 is invalid.");
        }
        if (attachment.sizeBytes === 0 && attachment.sha256.toLowerCase() !== EMPTY_SHA256) {
          throw new HttpError(400, "Empty attachment checksum mismatch.");
        }
        return total + attachment.sizeBytes;
      }, 0);
      if (exceedsLimit(totalBytes, limits.maxTaskBytes)) {
        throw new HttpError(413, "Attachments exceed the per-task size limit.");
      }

      const signature = responseUploadSignature(request.markdown ?? "", requestedAttachments);
      const existingUpload = await this.readResponseUpload(id);
      if (
        existingUpload &&
        responseUploadSignature(existingUpload.markdown, existingUpload.attachments) === signature
      ) {
        relayLog(this.logger, "response.upload_resumed", {
          taskId: task.id,
          sessionId: task.sessionId,
          operator: String(request.operator || "operator").slice(0, 120),
          uploadId: existingUpload.id,
          responseAttachments: existingUpload.attachments.length,
          responseBytes: sumAttachmentBytes(existingUpload.attachments),
        });
        return {
          id: existingUpload.id,
          attachments: existingUpload.attachments,
          uploadChunkBytes: existingUpload.uploadChunkBytes,
        };
      }

      const responseDirectory = path.join(this.taskDir(id), "response");
      await fs.rm(responseDirectory, { recursive: true, force: true });
      await fs.mkdir(responseDirectory, { recursive: true });
      const upload: StoredResponseUpload = {
        id: randomUUID(),
        operator: String(request.operator || "operator").slice(0, 120),
        markdown: request.markdown ?? "",
        createdAt: new Date().toISOString(),
        signature,
        uploadChunkBytes: DEFAULT_RESPONSE_UPLOAD_CHUNK_BYTES,
        attachments: requestedAttachments.map((attachment) => ({
          id: randomUUID(),
          filename: safeFilename(attachment.filename),
          displayPath: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256.toLowerCase(),
          direction: "response",
        })),
      };
      await this.writeResponseUpload(id, upload);
      await Promise.all(
        upload.attachments
          .filter((attachment) => attachment.sizeBytes === 0)
          .map((attachment) =>
            fs.writeFile(this.attachmentPath(id, attachment), "", { flag: "wx" }),
          ),
      );
      relayLog(this.logger, "response.upload_staged", {
        taskId: task.id,
        sessionId: task.sessionId,
        operator: upload.operator,
        responseAttachments: upload.attachments.length,
        responseBytes: totalBytes,
      });
      return {
        id: upload.id,
        attachments: upload.attachments,
        uploadChunkBytes: upload.uploadChunkBytes,
      };
    });
  }

  async uploadResponseAttachment(
    id: string,
    uploadId: string,
    attachmentId: string,
    input: NodeJS.ReadableStream,
    maxAttachmentBytes: number,
    range?: { start: number; end: number; total: number },
  ): Promise<RelayAttachmentDescriptor> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      assertActiveTask(task);
      const upload = await this.requiredResponseUpload(id, uploadId);
      const attachment = upload.attachments.find((entry) => entry.id === attachmentId);
      if (!attachment) throw new HttpError(404, "Attachment not found.");
      return this.uploadStagedAttachment(task, attachment, input, maxAttachmentBytes, range);
    });
  }

  async publishResponseUpload(id: string, uploadId: string): Promise<RelayTask> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      assertActiveTask(task);
      const upload = await this.requiredResponseUpload(id, uploadId);
      for (const attachment of upload.attachments) {
        const stat = await fs.stat(this.attachmentPath(id, attachment)).catch(() => null);
        if (!stat || stat.size !== attachment.sizeBytes) {
          throw new HttpError(409, "Not all response attachments have been uploaded.");
        }
      }
      const now = new Date().toISOString();
      task.status = "completed";
      task.updatedAt = now;
      task.completedAt = now;
      task.response = {
        markdown: upload.markdown,
        submittedBy: upload.operator,
        submittedAt: now,
        attachments: upload.attachments,
      };
      await this.write(task);
      await fs.rm(this.responseUploadPath(id), { force: true });
      relayLog(this.logger, "task.completed", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        operator: upload.operator,
        answerChars: upload.markdown.length,
        responseAttachments: upload.attachments.length,
        responseBytes: sumAttachmentBytes(upload.attachments),
        elapsedMs: elapsedSince(task.createdAt, now),
      });
      return task;
    });
  }

  async acknowledge(id: string): Promise<boolean> {
    return this.withLock(id, async () => {
      const task = await this.readRaw(id);
      if (!task) return false;
      if (task.status !== "completed") throw new HttpError(409, `Task is ${task.status}.`);
      await fs.rm(this.taskDir(id), { recursive: true, force: true });
      relayLog(this.logger, "task.deleted", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        reason: "producer-acknowledged",
        elapsedMs: elapsedSince(task.createdAt, new Date().toISOString()),
      });
      return true;
    });
  }

  async pruneTerminal(retentionMs: number): Promise<number> {
    await this.ensure();
    const entries = await fs.readdir(path.join(this.root, "tasks"), { withFileTypes: true });
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await this.withLock(entry.name, async () => {
        const task = await this.readRaw(entry.name);
        if (!task || !["completed", "cancelled", "expired"].includes(task.status)) return;
        const terminalAt = Date.parse(task.completedAt ?? task.updatedAt);
        if (!Number.isFinite(terminalAt) || Date.now() - terminalAt < retentionMs) return;
        await fs.rm(this.taskDir(task.id), { recursive: true, force: true });
        deleted += 1;
        relayLog(this.logger, "task.deleted", {
          taskId: task.id,
          sessionId: task.sessionId,
          status: task.status,
          reason: "retention-expired",
          retentionMs,
        });
      });
    }
    return deleted;
  }

  async list(): Promise<RelayTask[]> {
    await this.ensure();
    const entries = await fs.readdir(path.join(this.root, "tasks"), { withFileTypes: true });
    const tasks = (
      await Promise.all(
        entries.filter((entry) => entry.isDirectory()).map((entry) => this.read(entry.name)),
      )
    ).filter((task): task is RelayTask => Boolean(task));
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async read(id: string): Promise<RelayTask | null> {
    return this.withLock(id, async () => {
      const task = await this.readRaw(id);
      return task ? this.refreshExpiryLocked(task) : null;
    });
  }

  async updateLocalReceiver(id: string, receiver: RelayLocalReceiver): Promise<RelayTask> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      await this.refreshExpiryLocked(task);
      if (["completed", "cancelled", "expired"].includes(task.status)) return task;
      task.localReceiver = normalizeLocalReceiver(receiver);
      if (task.localReceiver && task.localReceiver.expiresAt > task.expiresAt) {
        task.expiresAt = task.localReceiver.expiresAt;
      }
      task.updatedAt = new Date().toISOString();
      await this.write(task);
      relayLog(this.logger, "task.local_receiver_updated", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        expiresAt: task.localReceiver?.expiresAt,
      });
      return task;
    });
  }

  private async readRaw(id: string): Promise<RelayTask | null> {
    try {
      const task = JSON.parse(await fs.readFile(this.taskPath(id), "utf8")) as RelayTask;
      return task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async claim(id: string, operator: string): Promise<RelayTask> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      await this.refreshExpiryLocked(task);
      const now = Date.now();
      if (!["queued", "claimed", "awaiting-response"].includes(task.status)) {
        throw new HttpError(409, `Task is ${task.status}.`);
      }
      const resumingSubmittedTask = task.status === "awaiting-response";
      task.status = resumingSubmittedTask ? "awaiting-response" : "claimed";
      task.claimedAt = new Date(now).toISOString();
      task.claimExpiresAt = new Date(now + DEFAULT_CLAIM_TTL_MS).toISOString();
      task.claimedBy = operator;
      task.updatedAt = new Date(now).toISOString();
      await this.write(task);
      relayLog(this.logger, "task.claimed", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        operator,
        claimExpiresAt: task.claimExpiresAt,
      });
      return task;
    });
  }

  async markSubmitted(id: string, operator: string): Promise<RelayTask> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      assertActiveTask(task);
      task.status = "awaiting-response";
      task.submittedAt = new Date().toISOString();
      task.claimExpiresAt = new Date(Date.now() + DEFAULT_CLAIM_TTL_MS).toISOString();
      task.claimedBy = operator;
      task.updatedAt = task.submittedAt;
      await this.write(task);
      relayLog(this.logger, "task.submitted", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        operator,
        queuedForMs: elapsedSince(task.createdAt, task.submittedAt),
      });
      return task;
    });
  }

  async heartbeat(id: string, operator: string): Promise<RelayTask> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      assertActiveTask(task);
      if (task.status === "queued") {
        task.status = "claimed";
        task.claimedAt = new Date().toISOString();
      }
      task.claimExpiresAt = new Date(Date.now() + DEFAULT_CLAIM_TTL_MS).toISOString();
      task.claimedBy = operator;
      task.updatedAt = new Date().toISOString();
      await this.write(task);
      return task;
    });
  }

  async complete(
    id: string,
    operator: string,
    submission: RelayResponseSubmission,
  ): Promise<RelayTask> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      assertActiveTask(task);
      if (!submission.markdown?.trim() && !submission.attachments?.length) {
        throw new HttpError(400, "Response text or an attachment is required.");
      }
      const responseAttachments = await this.writeAttachments(
        id,
        "response",
        (submission.attachments ?? []).map((attachment) => ({
          ...attachment,
          displayPath: attachment.filename,
        })),
      );
      const now = new Date().toISOString();
      task.status = "completed";
      task.updatedAt = now;
      task.completedAt = now;
      task.response = {
        markdown: submission.markdown ?? "",
        submittedBy: operator,
        submittedAt: now,
        attachments: responseAttachments,
      };
      await this.write(task);
      relayLog(this.logger, "task.completed", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        operator,
        answerChars: task.response.markdown.length,
        responseAttachments: responseAttachments.length,
        responseBytes: sumAttachmentBytes(responseAttachments),
        elapsedMs: elapsedSince(task.createdAt, now),
      });
      return task;
    });
  }

  async cancel(
    id: string,
    actor: { role: "producer" | "operator"; operator?: string } = { role: "producer" },
  ): Promise<RelayTask> {
    return this.withLock(id, async () => {
      const task = await this.requiredRaw(id);
      const previousStatus = task.status;
      if (task.status === "completed")
        throw new HttpError(409, "Completed tasks cannot be cancelled.");
      task.status = "cancelled";
      task.updatedAt = new Date().toISOString();
      await this.write(task);
      relayLog(this.logger, "task.cancelled", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        actorRole: actor.role,
        operator: actor.operator,
        elapsedMs: elapsedSince(task.createdAt, task.updatedAt),
      });
      if (previousStatus === "uploading") {
        await fs.rm(this.taskDir(id), { recursive: true, force: true });
        relayLog(this.logger, "task.deleted", {
          taskId: task.id,
          sessionId: task.sessionId,
          status: task.status,
          reason: "unpublished-upload-cancelled",
        });
      }
      return task;
    });
  }

  attachmentPath(id: string, descriptor: RelayAttachmentDescriptor): string {
    return path.join(this.taskDir(id), descriptor.direction, `${safeId(descriptor.id)}.bin`);
  }

  private responseUploadPath(id: string): string {
    return path.join(this.taskDir(id), "response-upload.json");
  }

  private async writeResponseUpload(id: string, upload: StoredResponseUpload): Promise<void> {
    const target = this.responseUploadPath(id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(upload, null, 2), "utf8");
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async requiredResponseUpload(
    id: string,
    uploadId: string,
  ): Promise<StoredResponseUpload> {
    const upload = await this.readResponseUpload(id);
    if (!upload) throw new HttpError(404, "Response upload not found.");
    if (upload.id !== uploadId) throw new HttpError(409, "Response upload was replaced.");
    return upload;
  }

  private async readResponseUpload(id: string): Promise<StoredResponseUpload | null> {
    try {
      return JSON.parse(
        await fs.readFile(this.responseUploadPath(id), "utf8"),
      ) as StoredResponseUpload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async requiredRaw(id: string): Promise<RelayTask> {
    const task = await this.readRaw(id);
    if (!task) throw new HttpError(404, "Task not found.");
    return task;
  }

  private async write(task: RelayTask): Promise<void> {
    const target = this.taskPath(task.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    task.revision = (task.revision ?? 0) + 1;
    try {
      await fs.writeFile(temporary, JSON.stringify(task, null, 2), "utf8");
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    for (const subscriber of this.subscribers.get(task.id) ?? []) {
      try {
        subscriber(structuredClone(task));
      } catch (error) {
        relayLog(this.logger, "subscriber.failed", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async refreshExpiryLocked(task: RelayTask): Promise<RelayTask> {
    if (
      !["completed", "cancelled", "expired"].includes(task.status) &&
      Date.parse(task.expiresAt) <= Date.now()
    ) {
      task.status = "expired";
      task.updatedAt = new Date().toISOString();
      await this.write(task);
      relayLog(this.logger, "task.expired", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        elapsedMs: elapsedSince(task.createdAt, task.updatedAt),
      });
    } else if (
      ["claimed", "awaiting-response"].includes(task.status) &&
      task.claimExpiresAt &&
      Date.parse(task.claimExpiresAt) <= Date.now()
    ) {
      const wasSubmitted = task.status === "awaiting-response";
      task.status = wasSubmitted ? "awaiting-response" : "queued";
      task.claimedBy = undefined;
      task.claimExpiresAt = undefined;
      task.updatedAt = new Date().toISOString();
      await this.write(task);
      relayLog(this.logger, "task.claim_released", {
        taskId: task.id,
        sessionId: task.sessionId,
        status: task.status,
        submitted: wasSubmitted,
      });
    }
    return task;
  }

  private async findByRequestIdRaw(requestId: string): Promise<RelayTask | null> {
    const entries = await fs.readdir(path.join(this.root, "tasks"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const task = await this.readRaw(entry.name);
      if (task?.requestId === requestId) return task;
    }
    return null;
  }

  async findByRequestId(requestId: string): Promise<RelayTask | null> {
    const normalized = normalizeRequestId(requestId);
    if (!normalized) throw new HttpError(400, "Request id is required.");
    return this.withLock(`request:${normalized}`, async () => {
      const task = await this.findByRequestIdRaw(normalized);
      return task ? this.withLock(task.id, () => this.refreshExpiryLocked(task)) : null;
    });
  }

  private async writeAttachments(
    id: string,
    direction: "request" | "response",
    attachments: Array<{
      filename: string;
      displayPath?: string;
      mimeType?: string;
      contentBase64: string;
    }>,
  ): Promise<RelayAttachmentDescriptor[]> {
    const output: RelayAttachmentDescriptor[] = [];
    for (const attachment of attachments) {
      const attachmentId = randomUUID();
      const bytes = Buffer.from(attachment.contentBase64, "base64");
      const descriptor: RelayAttachmentDescriptor = {
        id: attachmentId,
        filename: safeFilename(attachment.filename),
        displayPath: attachment.displayPath || attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        direction,
      };
      await fs.writeFile(this.attachmentPath(id, descriptor), bytes);
      output.push(descriptor);
    }
    return output;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function createRelayServer(
  options: RelayServerOptions = {},
): Promise<RelayServerInstance> {
  const host = options.host ?? "127.0.0.1";
  const producerToken =
    nonEmpty(options.producerToken) ??
    nonEmpty(process.env.ORACLE_RELAY_PRODUCER_TOKEN) ??
    randomBytes(24).toString("hex");
  const operatorToken =
    nonEmpty(options.operatorToken) ??
    nonEmpty(process.env.ORACLE_RELAY_OPERATOR_TOKEN) ??
    randomBytes(24).toString("hex");
  const logger = options.logger ?? console.log;
  const store = new RelayTaskStore(
    options.dataDir ?? process.env.ORACLE_RELAY_DATA_DIR ?? path.join(getOracleHomeDir(), "relay"),
    logger,
  );
  await store.ensure();
  const server = http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, {
        store,
        producerToken,
        operatorToken,
        maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        maxAttachmentBytes: options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
        maxTaskBytes: options.maxTaskBytes ?? DEFAULT_MAX_TASK_BYTES,
        logger,
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      relayLog(logger, "request.failed", {
        method: req.method,
        path: safeRequestPath(req.url),
        status,
        error: message,
      });
      json(res, status, { error: message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve relay port.");
  const terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
  await store.pruneTerminal(terminalRetentionMs);
  const cleanupTimer = setInterval(() => {
    void store.pruneTerminal(terminalRetentionMs).catch((error) => {
      relayLog(logger, "cleanup.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  relayLog(logger, "server.started", { host, port: address.port });
  return {
    host,
    port: address.port,
    producerToken,
    operatorToken,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(cleanupTimer);
        store.closeSubscribers();
        relayLog(logger, "server.stopping", { host, port: address.port });
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export async function serveRelay(options: RelayServerOptions = {}): Promise<void> {
  const producerTokenConfigured = Boolean(
    nonEmpty(options.producerToken) ?? nonEmpty(process.env.ORACLE_RELAY_PRODUCER_TOKEN),
  );
  const operatorTokenConfigured = Boolean(
    nonEmpty(options.operatorToken) ?? nonEmpty(process.env.ORACLE_RELAY_OPERATOR_TOKEN),
  );
  const instance = await createRelayServer(options);
  const displayHost = instance.host === "0.0.0.0" ? "127.0.0.1" : instance.host;
  console.log(`Relay server: http://${displayHost}:${instance.port}`);
  console.log(
    producerTokenConfigured
      ? "Producer token: configured via environment"
      : `Producer token: ${instance.producerToken}`,
  );
  console.log(
    operatorTokenConfigured
      ? "Operator token: configured via environment"
      : `Operator token: ${instance.operatorToken}`,
  );
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await instance.close();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: {
    store: RelayTaskStore;
    producerToken: string;
    operatorToken: string;
    maxBodyBytes: number;
    maxAttachmentBytes: number;
    maxTaskBytes: number;
    logger: RelayLogger;
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://relay.local");
  setSecurityHeaders(res);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(OPERATOR_HTML);
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, service: "oracle-relay" });
    return;
  }
  const role = authenticate(req, context);
  const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
  const requestLookupMatch = url.pathname.match(/^\/v1\/tasks\/by-request\/([^/]+)$/);
  const taskEventsMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/events$/);
  const localReceiverMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/local-receiver$/);
  const actionMatch = url.pathname.match(
    /^\/v1\/tasks\/([^/]+)\/(claim|submitted|heartbeat|response|cancel|abort|publish|ack)$/,
  );
  const responseUploadStageMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/responses\/uploads$/);
  const responseUploadAttachmentMatch = url.pathname.match(
    /^\/v1\/tasks\/([^/]+)\/responses\/([^/]+)\/attachments\/([^/]+)$/,
  );
  const responseUploadPublishMatch = url.pathname.match(
    /^\/v1\/tasks\/([^/]+)\/responses\/([^/]+)\/publish$/,
  );
  const attachmentMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/attachments\/([^/]+)$/);

  if (req.method === "POST" && url.pathname === "/v1/tasks") {
    requireRole(role, "producer");
    const body = await readJson<RelayCreateTaskRequest>(req, context.maxBodyBytes);
    if (!body.prompt?.trim()) throw new HttpError(400, "Prompt is required.");
    json(res, 201, await context.store.create(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/tasks/uploads") {
    requireRole(role, "producer");
    const body = await readJson<RelayCreateUploadTaskRequest>(req, context.maxBodyBytes);
    if (!body.prompt?.trim()) throw new HttpError(400, "Prompt is required.");
    const task = await context.store.createUpload(body, {
      maxAttachmentBytes: context.maxAttachmentBytes,
      maxTaskBytes: context.maxTaskBytes,
    });
    json(res, 201, { ...task, uploadChunkBytes: DEFAULT_UPLOAD_CHUNK_BYTES });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/tasks") {
    requireRole(role, "operator");
    const statuses = new Set(
      (url.searchParams.get("status") ?? "queued,claimed,awaiting-response").split(","),
    );
    const tasks = (await context.store.list()).filter((task) => statuses.has(task.status));
    json(res, 200, tasks);
    return;
  }
  if (req.method === "GET" && requestLookupMatch) {
    requireRole(role, "producer");
    const task = await context.store.findByRequestId(decodeURIComponent(requestLookupMatch[1]));
    if (!task) throw new HttpError(404, "Task not found.");
    json(res, 200, task);
    return;
  }
  if (req.method === "GET" && taskEventsMatch) {
    requireRole(role, "producer");
    await streamTaskEvents(req, res, context.store, taskEventsMatch[1], context.logger);
    return;
  }
  if (req.method === "GET" && taskMatch) {
    const task = await context.store.read(taskMatch[1]);
    if (!task) throw new HttpError(404, "Task not found.");
    json(res, 200, task);
    return;
  }
  if (req.method === "POST" && localReceiverMatch) {
    requireRole(role, "producer");
    const body = await readJson<RelayLocalReceiver>(req, context.maxBodyBytes);
    json(res, 200, await context.store.updateLocalReceiver(localReceiverMatch[1], body));
    return;
  }
  if (req.method === "POST" && responseUploadStageMatch) {
    requireRole(role, "operator");
    const body = await readJson<RelayResponseUploadRequest>(req, context.maxBodyBytes);
    json(
      res,
      201,
      await context.store.stageResponseUpload(responseUploadStageMatch[1], body, {
        maxAttachmentBytes: context.maxAttachmentBytes,
        maxTaskBytes: context.maxTaskBytes,
      }),
    );
    return;
  }
  if (req.method === "PUT" && responseUploadAttachmentMatch) {
    requireRole(role, "operator");
    const [, id, uploadId, attachmentId] = responseUploadAttachmentMatch;
    const contentLength = Number.parseInt(req.headers["content-length"] || "", 10);
    if (Number.isFinite(contentLength) && exceedsLimit(contentLength, context.maxAttachmentBytes)) {
      throw new HttpError(413, "Attachment upload is too large.");
    }
    json(
      res,
      200,
      await context.store.uploadResponseAttachment(
        id,
        uploadId,
        attachmentId,
        req,
        context.maxAttachmentBytes,
        parseContentRange(req.headers["content-range"]),
      ),
    );
    return;
  }
  if (req.method === "POST" && responseUploadPublishMatch) {
    requireRole(role, "operator");
    json(
      res,
      200,
      await context.store.publishResponseUpload(
        responseUploadPublishMatch[1],
        responseUploadPublishMatch[2],
      ),
    );
    return;
  }
  if (req.method === "POST" && actionMatch) {
    const [, id, action] = actionMatch;
    if (action === "cancel" || action === "publish" || action === "ack") {
      requireRole(role, "producer");
      json(
        res,
        200,
        action === "publish"
          ? await context.store.publish(id)
          : action === "ack"
            ? { deleted: await context.store.acknowledge(id) }
            : await context.store.cancel(id),
      );
      return;
    }
    requireRole(role, "operator");
    const body = await readJson<Record<string, unknown>>(req, context.maxBodyBytes);
    const operator = String(body.operator || "operator").slice(0, 120);
    if (action === "claim") json(res, 200, await context.store.claim(id, operator));
    else if (action === "abort")
      json(res, 200, await context.store.cancel(id, { role: "operator", operator }));
    else if (action === "submitted")
      json(res, 200, await context.store.markSubmitted(id, operator));
    else if (action === "heartbeat") json(res, 200, await context.store.heartbeat(id, operator));
    else
      json(
        res,
        200,
        await context.store.complete(id, operator, body as unknown as RelayResponseSubmission),
      );
    return;
  }
  if (req.method === "PUT" && attachmentMatch) {
    requireRole(role, "producer");
    const [, id, attachmentId] = attachmentMatch;
    const contentLength = Number.parseInt(req.headers["content-length"] || "", 10);
    if (Number.isFinite(contentLength) && exceedsLimit(contentLength, context.maxAttachmentBytes)) {
      throw new HttpError(413, "Attachment upload is too large.");
    }
    json(
      res,
      200,
      await context.store.uploadRequestAttachment(
        id,
        attachmentId,
        req,
        context.maxAttachmentBytes,
        parseContentRange(req.headers["content-range"]),
      ),
    );
    return;
  }
  if (req.method === "GET" && attachmentMatch) {
    const [, id, attachmentId] = attachmentMatch;
    const task = await context.store.read(id);
    if (!task) throw new HttpError(404, "Task not found.");
    const attachment = [...task.attachments, ...(task.response?.attachments ?? [])].find(
      (entry) => entry.id === attachmentId,
    );
    if (!attachment) throw new HttpError(404, "Attachment not found.");
    const attachmentPath = context.store.attachmentPath(id, attachment);
    relayLog(context.logger, "attachment.downloaded", {
      taskId: task.id,
      sessionId: task.sessionId,
      direction: attachment.direction,
      bytes: attachment.sizeBytes,
    });
    res.writeHead(200, {
      "Content-Type": attachment.mimeType || "application/octet-stream",
      "Content-Length": attachment.sizeBytes,
      "Content-Disposition": `attachment; filename="${attachment.filename.replace(/["\\]/g, "-")}"`,
      "Cache-Control": "no-store",
    });
    await pipeline(createReadStream(attachmentPath), res);
    return;
  }
  throw new HttpError(404, "Not found.");
}

const TERMINAL_RELAY_STATUSES = new Set(["completed", "cancelled", "expired"]);
const SSE_HEARTBEAT_MS = 20_000;

async function streamTaskEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: RelayTaskStore,
  id: string,
  logger: RelayLogger,
): Promise<void> {
  safeId(id);
  let closed = false;
  let initialized = false;
  let connected = false;
  let pendingTask: RelayTask | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const send = (task: RelayTask): void => {
    if (closed || res.destroyed) return;
    try {
      res.write(`id: ${task.revision ?? 0}\nevent: task\ndata: ${JSON.stringify(task)}\n\n`);
      if (TERMINAL_RELAY_STATUSES.has(task.status)) finish();
    } catch {
      finish();
    }
  };
  const unsubscribe = store.subscribe(id, (task) => {
    if (!initialized) pendingTask = task;
    else send(task);
  });
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    if (connected) {
      relayLog(logger, "task.events_disconnected", { taskId: id });
      connected = false;
    }
    if (!res.writableEnded) res.end();
  };
  res.once("close", finish);
  try {
    const task = await store.read(id);
    if (!task) throw new HttpError(404, "Task not found.");
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    connected = true;
    relayLog(logger, "task.events_connected", { taskId: id, revision: task.revision });
    heartbeat = setInterval(() => {
      if (!closed && !res.destroyed) res.write(`: keep-alive ${Date.now()}\n\n`);
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref();
    initialized = true;
    send(task);
    if (pendingTask && pendingTask.revision !== task.revision && !closed) send(pendingTask);
  } catch (error) {
    unsubscribe();
    if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
    else throw error;
  }
}

function authenticate(
  req: http.IncomingMessage,
  context: { producerToken: string; operatorToken: string },
): "producer" | "operator" {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (token === context.producerToken) return "producer";
  if (token === context.operatorToken) return "operator";
  throw new HttpError(401, "Unauthorized.");
}

function requireRole(actual: string, expected: "producer" | "operator"): void {
  if (actual !== expected) throw new HttpError(403, `${expected} credentials required.`);
}

function parseContentRange(
  value: string | string[] | undefined,
): { start: number; end: number; total: number } | undefined {
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value[0] : value;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(text ?? "");
  if (!match) throw new HttpError(400, "Invalid Content-Range header.");
  const start = Number.parseInt(match[1]!, 10);
  const end = Number.parseInt(match[2]!, 10);
  const total = Number.parseInt(match[3]!, 10);
  if (![start, end, total].every(Number.isSafeInteger)) {
    throw new HttpError(400, "Invalid Content-Range header.");
  }
  return { start, end, total };
}

async function consumeExactBytes(
  input: NodeJS.ReadableStream,
  expectedBytes: number,
  maxBytes: number,
): Promise<void> {
  let bytes = 0;
  for await (const chunk of input) {
    bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (bytes > expectedBytes || exceedsLimit(bytes, maxBytes)) {
      throw new HttpError(413, "Attachment upload chunk is too large.");
    }
  }
  if (bytes !== expectedBytes) throw new HttpError(400, "Attachment chunk size mismatch.");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readJson<T>(req: http.IncomingMessage, limit: number): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new HttpError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(value)) throw new HttpError(400, "Invalid identifier.");
  return value;
}

function safeFilename(value: string): string {
  return (
    path.basename(value || "attachment.bin").replace(/[^a-zA-Z0-9._-]+/g, "-") || "attachment.bin"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRequestId(value: string | undefined): string | undefined {
  const requestId = nonEmpty(value);
  if (!requestId) return undefined;
  if (requestId.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(requestId)) {
    throw new HttpError(400, "Invalid request id.");
  }
  return requestId;
}

function relayRequestFingerprint(
  request: RelayCreateTaskRequest | RelayCreateUploadTaskRequest,
): string {
  const attachments = (request.attachments ?? []).map((attachment) => {
    if ("contentBase64" in attachment) {
      const bytes = Buffer.from(attachment.contentBase64, "base64");
      return {
        filename: attachment.filename,
        displayPath: attachment.displayPath,
        mimeType: attachment.mimeType,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
    return {
      filename: attachment.filename,
      displayPath: attachment.displayPath,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256.toLowerCase(),
    };
  });
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: request.title?.trim() || undefined,
        prompt: request.prompt,
        modelHint: request.modelHint,
        source: request.source,
        sessionId: request.sessionId,
        attachments,
      }),
    )
    .digest("hex");
}

function exceedsLimit(bytes: number, limit: number): boolean {
  return limit > 0 && bytes > limit;
}

function responseUploadSignature(
  markdown: string,
  attachments: Array<{
    filename: string;
    mimeType?: string;
    sizeBytes: number;
    sha256: string;
  }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        markdown,
        attachments: attachments.map(({ filename, mimeType, sizeBytes, sha256 }) => ({
          filename: safeFilename(filename),
          mimeType,
          sizeBytes,
          sha256: sha256.toLowerCase(),
        })),
      }),
    )
    .digest("hex");
}

function normalizeLocalReceiver(
  receiver: RelayCreateTaskRequest["localReceiver"],
): RelayCreateTaskRequest["localReceiver"] {
  if (!receiver) return undefined;
  let url: URL;
  try {
    url = new URL(receiver.baseUrl);
  } catch {
    throw new HttpError(400, "Local receiver URL is invalid.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    receiver.version !== 1 ||
    url.protocol !== "http:" ||
    !loopback ||
    url.username ||
    url.password
  ) {
    throw new HttpError(400, "Local receiver must use an unauthenticated loopback HTTP URL.");
  }
  if (!/^[a-f0-9]{64}$/i.test(receiver.token)) {
    throw new HttpError(400, "Local receiver token is invalid.");
  }
  const expiresAt = Date.parse(receiver.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new HttpError(400, "Local receiver capability is expired.");
  }
  return {
    version: 1,
    baseUrl: url.origin,
    token: receiver.token.toLowerCase(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function taskExpiry(now: Date, expiresInMs?: number): string {
  if (expiresInMs === 0) return INDEFINITE_EXPIRY;
  const ttl = clamp(expiresInMs ?? DEFAULT_TASK_TTL_MS, 60_000, 7 * 86_400_000);
  return new Date(now.getTime() + ttl).toISOString();
}

function assertIdempotentRequest(task: RelayTask, fingerprint: string): RelayTask {
  if (task.requestFingerprint !== fingerprint) {
    throw new HttpError(409, `Request id ${task.requestId} is already bound to different content.`);
  }
  return task;
}

function relayLog(
  logger: RelayLogger,
  event: string,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  logger(
    `[relay] ${JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    })}`,
  );
}

function elapsedSince(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function sumAttachmentBytes(attachments: RelayAttachmentDescriptor[]): number {
  return attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
}

function safeRequestPath(value: string | undefined): string {
  try {
    return new URL(value ?? "/", "http://relay.local").pathname;
  } catch {
    return "/invalid-url";
  }
}

function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  );
}

function assertActiveTask(task: RelayTask): void {
  if (!["queued", "claimed", "awaiting-response"].includes(task.status)) {
    throw new HttpError(409, `Task is ${task.status}.`);
  }
}

const OPERATOR_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oracle Relay</title><style>
:root{color-scheme:light dark;font-family:Inter,system-ui,sans-serif}body{margin:0;background:#101114;color:#eee}main{max-width:980px;margin:auto;padding:20px}.card{background:#1b1d22;border:1px solid #343740;border-radius:14px;padding:18px;margin:12px 0}button,input,textarea,select{font:inherit}button{background:#7457ff;color:#fff;border:0;border-radius:9px;padding:10px 14px;cursor:pointer}button.secondary{background:#343740}button.danger{background:#a93645}input,textarea,select{box-sizing:border-box;width:100%;background:#111318;color:#eee;border:1px solid #3c404a;border-radius:8px;padding:10px}textarea{min-height:260px;font-family:ui-monospace,monospace}.row{display:flex;gap:10px;align-items:center}.row>*{flex:1}.muted{color:#9ca2af}.task{cursor:pointer}.badge{display:inline-block;padding:3px 8px;border-radius:99px;background:#343740;font-size:12px}.files a{color:#b8aaff}.hidden{display:none}pre{white-space:pre-wrap;max-height:420px;overflow:auto;background:#111318;padding:12px;border-radius:8px}@media(max-width:640px){.row{display:block}.row>*{margin:7px 0}}
</style></head><body><main><h1>🧿 Oracle Relay</h1>
<section id="login" class="card"><h2>连接操作端</h2><input id="token" type="password" placeholder="Operator token"><input id="operator" placeholder="操作人/设备名称"><p><button onclick="connect()">连接</button></p></section>
<section id="queue" class="hidden"><div class="row"><h2>人工任务</h2><button class="secondary" onclick="loadTasks()">刷新</button></div><div id="tasks"></div></section>
<section id="detail" class="hidden"></section></main><script>
let auth=localStorage.relayToken||'', operator=localStorage.relayOperator||('device-'+Math.random().toString(36).slice(2,7)), active=null, heartbeat=null;
token.value=auth;document.getElementById('operator').value=operator;if(auth)connect();
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{Authorization:'Bearer '+auth,...(opts.body?{'Content-Type':'application/json'}:{}),...(opts.headers||{})}});if(!r.ok)throw new Error(await r.text());return r}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function connect(){auth=token.value.trim();operator=document.getElementById('operator').value.trim()||'operator';localStorage.relayToken=auth;localStorage.relayOperator=operator;try{await loadTasks();login.classList.add('hidden');queue.classList.remove('hidden');if(Notification.permission==='default')Notification.requestPermission();const requested=new URLSearchParams(location.search).get('task');if(requested)await openTask(requested)}catch(e){alert('连接失败：'+e.message)}}
async function loadTasks(){const list=await (await api('/v1/tasks')).json();tasks.innerHTML=list.length?list.map(t=>'<div class="card task" onclick="openTask(\''+t.id+'\')"><span class="badge">'+esc(t.status)+'</span><h3>'+esc(t.title)+'</h3><div class="muted">'+esc(t.modelHint||'未指定模型')+' · '+t.attachments.length+' 个文件 · '+new Date(t.createdAt).toLocaleString()+'</div></div>').join(''):'<div class="card muted">暂无待处理任务</div>';if(list.some(t=>t.status==='queued')&&Notification.permission==='granted')new Notification('Oracle Relay 有新任务')}
async function openTask(id){active=await (await api('/v1/tasks/'+id)).json();if(['queued','claimed','awaiting-response'].includes(active.status))active=await (await api('/v1/tasks/'+id+'/claim',{method:'POST',body:JSON.stringify({operator})})).json();render();clearInterval(heartbeat);heartbeat=setInterval(()=>api('/v1/tasks/'+id+'/heartbeat',{method:'POST',body:JSON.stringify({operator})}).catch(()=>{}),60000)}
function attachmentKind(a){const mime=String(a.mimeType||'').toLowerCase(),name=String(a.filename||'').toLowerCase(),ext=name.includes('.')?name.slice(name.lastIndexOf('.')+1):'';if(mime.startsWith('image/')||['png','jpg','jpeg','gif','webp','bmp'].includes(ext))return'image';if(mime.startsWith('text/')||['application/json','application/javascript','application/xml','application/yaml','application/x-yaml','application/toml'].includes(mime)||['txt','md','markdown','json','jsonl','js','jsx','ts','tsx','css','html','htm','xml','yaml','yml','toml','csv','tsv','log','diff','patch','java','kt','kts','groovy','gradle','properties','sql','sh','bash','zsh','fish','py','rb','go','rs','c','h','cc','cpp','hpp','cs','php','vue','svelte'].includes(ext))return'text';return'file'}
function attachmentActions(a){const kind=attachmentKind(a),copy=kind==='text'?'<button onclick="copyAttachment(\''+a.id+'\')">复制内容</button> ':kind==='image'?'<button onclick="copyAttachment(\''+a.id+'\')">复制图片</button> ':'';const note=kind==='file'?'<span class="muted">浏览器无法直接复制此类文件</span> ':'';return copy+'<button class="secondary" onclick="downloadFile(\''+a.id+'\')">下载</button> '+note}
function render(){queue.classList.add('hidden');detail.classList.remove('hidden');detail.innerHTML='<button class="secondary" onclick="back()">← 返回</button><div class="card"><span class="badge">'+esc(active.status)+'</span><h2>'+esc(active.title)+'</h2><div class="muted">建议模型：'+esc(active.modelHint||'自行选择')+'</div><h3>提示词</h3><button onclick="copyPrompt()">复制提示词</button> <button class="secondary" onclick="markSubmitted()">标记已提交到 ChatGPT</button> <button class="danger" onclick="abortTask()">中止任务</button><pre>'+esc(active.prompt)+'</pre><h3>附件</h3><div class="files">'+(active.attachments.length?active.attachments.map(a=>'<p>'+attachmentActions(a)+esc(a.displayPath)+' ('+Math.ceil(a.sizeBytes/1024)+' KB)</p>').join(''):'<p class="muted">无附件</p>')+'</div></div><div class="card"><h3>回传回答</h3><textarea id="answer" placeholder="粘贴完整 Markdown 回答"></textarea><p>回答附件：<input id="responseFiles" type="file" multiple></p><button onclick="submitResponse()">提交给开发机</button></div>'}
async function copyPrompt(){await navigator.clipboard.writeText(active.prompt);alert('提示词已复制')}
async function markSubmitted(){active=await (await api('/v1/tasks/'+active.id+'/submitted',{method:'POST',body:JSON.stringify({operator})})).json();render()}
async function abortTask(){if(!confirm('确定中止这个任务吗？开发机上的等待会立即结束。'))return;try{active=await (await api('/v1/tasks/'+active.id+'/abort',{method:'POST',body:JSON.stringify({operator})})).json();alert('任务已中止');back()}catch(e){alert('中止失败：'+e.message)}}
function findAttachment(id){return active.attachments.find(a=>a.id===id)}
async function copyAttachment(id){const item=findAttachment(id);if(!item)return;try{const r=await api('/v1/tasks/'+active.id+'/attachments/'+id),blob=await r.blob(),kind=attachmentKind(item);if(kind==='text'){await navigator.clipboard.writeText(await blob.text());alert('附件内容已复制：'+item.filename);return}if(kind==='image'){if(!window.ClipboardItem)throw new Error('当前浏览器不支持复制图片');const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close?.();const png=await new Promise((ok,no)=>canvas.toBlob(value=>value?ok(value):no(new Error('图片转换失败')),'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);alert('图片已复制：'+item.filename);return}throw new Error('浏览器无法直接复制此类文件')}catch(e){alert('复制失败：'+e.message)}}
async function downloadFile(id){const item=findAttachment(id);if(!item)return;const r=await api('/v1/tasks/'+active.id+'/attachments/'+id);const blob=await r.blob(),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=item.filename;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
async function submitResponse(){clearInterval(heartbeat);const files=[];for(const f of responseFiles.files){files.push({filename:f.name,mimeType:f.type,contentBase64:await toBase64(f)})}const payload={operator,markdown:answer.value,attachments:files};active=await (await api('/v1/tasks/'+active.id+'/response',{method:'POST',body:JSON.stringify(payload)})).json();alert('已成功回传');back()}
function toBase64(file){return new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]);r.onerror=no;r.readAsDataURL(file)})}
function back(){clearInterval(heartbeat);detail.classList.add('hidden');queue.classList.remove('hidden');loadTasks()}
setInterval(()=>{if(!queue.classList.contains('hidden'))loadTasks().catch(()=>{})},10000);
</script></body></html>`;
