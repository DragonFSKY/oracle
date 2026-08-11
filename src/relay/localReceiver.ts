import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type {
  RelayAttachmentDescriptor,
  RelayLocalReceiver,
  RelayResponseUploadPlan,
  RelayResponseUploadRequest,
} from "./types.js";

const CHUNK_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const RECEIPT_FILENAME = ".relay-local-response.json";
const INDEFINITE_EXPIRY_MS = Date.parse("9999-12-31T23:59:59.999Z");

interface LocalArtifactReceipt {
  path: string;
  label: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
}

export interface LocalResponseReceipt {
  version: 1;
  receiptId: string;
  requestId: string;
  taskId: string;
  signature: string;
  markdownSha256: string;
  completedAt: string;
  artifacts: LocalArtifactReceipt[];
}

interface ActiveUpload {
  plan: RelayResponseUploadPlan;
  request: RelayResponseUploadRequest;
  signature: string;
  directory: string;
}

export interface LocalResponseReceiverInstance {
  capability: RelayLocalReceiver;
  close(): Promise<void>;
}

export async function startLocalResponseReceiver(options: {
  requestId: string;
  artifactsDir: string;
  lifetimeMs?: number;
}): Promise<LocalResponseReceiverInstance> {
  const token = randomBytes(32).toString("hex");
  const lifetimeMs = options.lifetimeMs ?? 24 * 60 * 60 * 1000;
  const expiresAtMs = lifetimeMs <= 0 ? INDEFINITE_EXPIRY_MS : Date.now() + lifetimeMs;
  const receiptPath = path.join(options.artifactsDir, RECEIPT_FILENAME);
  await fs.mkdir(options.artifactsDir, { recursive: true });
  let active: ActiveUpload | undefined;
  let boundTaskId: string | undefined;

  const server = http.createServer(async (req, res) => {
    try {
      if (Date.now() >= expiresAtMs) throw new LocalHttpError(410, "Capability expired.");
      requireToken(req, token);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const health = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/health$/);
      const stage = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/responses\/uploads$/);
      const upload = url.pathname.match(
        /^\/v1\/tasks\/([^/]+)\/responses\/([^/]+)\/attachments\/([^/]+)$/,
      );
      const publish = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/responses\/([^/]+)\/publish$/);

      if (req.method === "GET" && health) {
        assertSafeId(health[1]);
        json(res, 200, { version: 1, requestId: options.requestId, taskId: health[1] });
        return;
      }
      if (req.method === "POST" && stage) {
        const taskId = assertSafeId(stage[1]);
        bindTask(taskId);
        const request = await readJson<RelayResponseUploadRequest>(req);
        validateResponseRequest(request);
        const signature = responseSignature(request);
        const receipt = await readLocalResponseReceipt(options.artifactsDir);
        if (receipt?.taskId === taskId && receipt.signature === signature) {
          json(res, 200, {
            id: receipt.receiptId,
            attachments: receipt.artifacts.map((artifact) => ({
              id: randomUUID(),
              filename: artifact.label,
              displayPath: artifact.label,
              mimeType: artifact.mimeType,
              sizeBytes: artifact.sizeBytes,
              sha256: artifact.sha256,
              direction: "response" as const,
            })),
            uploadChunkBytes: CHUNK_BYTES,
            alreadyComplete: true,
          } satisfies RelayResponseUploadPlan);
          return;
        }
        if (active?.signature === signature && boundTaskId === taskId) {
          json(res, 200, active.plan);
          return;
        }
        if (active) await fs.rm(active.directory, { recursive: true, force: true });
        const id = randomUUID();
        const directory = path.join(options.artifactsDir, `.local-upload-${id}`);
        await fs.mkdir(directory, { recursive: true });
        const attachments = request.attachments.map((attachment) => ({
          id: randomUUID(),
          filename: safeFilename(attachment.filename),
          displayPath: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256.toLowerCase(),
          direction: "response" as const,
        }));
        for (const attachment of attachments) {
          if (attachment.sizeBytes === 0)
            await fs.writeFile(uploadPath(directory, attachment.id), "");
        }
        active = {
          plan: { id, attachments, uploadChunkBytes: CHUNK_BYTES },
          request,
          signature,
          directory,
        };
        json(res, 201, active.plan);
        return;
      }
      if (req.method === "PUT" && upload) {
        const taskId = assertSafeId(upload[1]);
        bindTask(taskId);
        if (!active || active.plan.id !== upload[2]) {
          throw new LocalHttpError(404, "Local upload not found.");
        }
        const attachment = active.plan.attachments.find((entry) => entry.id === upload[3]);
        if (!attachment) throw new LocalHttpError(404, "Attachment not found.");
        await writeChunk(req, uploadPath(active.directory, attachment.id), attachment);
        json(res, 200, attachment);
        return;
      }
      if (req.method === "POST" && publish) {
        const taskId = assertSafeId(publish[1]);
        bindTask(taskId);
        if (!active || active.plan.id !== publish[2]) {
          const receipt = await readLocalResponseReceipt(options.artifactsDir);
          if (receipt?.taskId === taskId && receipt.receiptId === publish[2]) {
            json(res, 200, receipt);
            return;
          }
          throw new LocalHttpError(404, "Local upload not found.");
        }
        const artifacts: LocalArtifactReceipt[] = [];
        for (const attachment of active.plan.attachments) {
          const temporary = uploadPath(active.directory, attachment.id);
          const stat = await fs.stat(temporary).catch(() => null);
          if (!stat || stat.size !== attachment.sizeBytes) {
            throw new LocalHttpError(409, "Not all local attachments have been uploaded.");
          }
          if ((await sha256File(temporary)) !== attachment.sha256) {
            throw new LocalHttpError(400, `Attachment checksum mismatch: ${attachment.filename}`);
          }
          const destination = await uniqueArtifactPath(options.artifactsDir, attachment.filename);
          await fs.rename(temporary, destination);
          artifacts.push({
            path: destination,
            label: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            sha256: attachment.sha256,
          });
        }
        const receipt: LocalResponseReceipt = {
          version: 1,
          receiptId: active.plan.id,
          requestId: options.requestId,
          taskId,
          signature: active.signature,
          markdownSha256: sha256Text(active.request.markdown),
          completedAt: new Date().toISOString(),
          artifacts,
        };
        await writeJsonAtomic(receiptPath, receipt);
        await fs.rm(active.directory, { recursive: true, force: true });
        active = undefined;
        json(res, 200, receipt);
        return;
      }
      throw new LocalHttpError(404, "Local receiver endpoint not found.");
    } catch (error) {
      const status = error instanceof LocalHttpError ? error.status : 500;
      json(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  function bindTask(taskId: string): void {
    if (boundTaskId && boundTaskId !== taskId) {
      throw new LocalHttpError(409, "Capability is already bound to another task.");
    }
    boundTaskId = taskId;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local receiver did not bind TCP.");

  return {
    capability: {
      version: 1,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (active) await fs.rm(active.directory, { recursive: true, force: true });
    },
  };
}

export async function readLocalResponseReceipt(
  artifactsDir: string,
): Promise<LocalResponseReceipt | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(artifactsDir, RECEIPT_FILENAME), "utf8"),
    ) as LocalResponseReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function requireToken(req: http.IncomingMessage, expected: string): void {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new LocalHttpError(401, "Invalid local capability.");
  }
}

function validateResponseRequest(request: RelayResponseUploadRequest): void {
  if (!request.markdown?.trim() && !request.attachments?.length) {
    throw new LocalHttpError(400, "Response text or an attachment is required.");
  }
  if (!Array.isArray(request.attachments))
    throw new LocalHttpError(400, "Attachments are required.");
  const emptySha = sha256Text("");
  for (const attachment of request.attachments) {
    if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
      throw new LocalHttpError(400, "Attachment size is invalid.");
    }
    if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) {
      throw new LocalHttpError(400, "Attachment checksum is invalid.");
    }
    if (attachment.sizeBytes === 0 && attachment.sha256.toLowerCase() !== emptySha) {
      throw new LocalHttpError(400, "Empty attachment checksum mismatch.");
    }
  }
}

async function writeChunk(
  req: http.IncomingMessage,
  target: string,
  attachment: RelayAttachmentDescriptor,
): Promise<void> {
  const range = parseContentRange(req.headers["content-range"]);
  if (range.total !== attachment.sizeBytes || range.end < range.start) {
    throw new LocalHttpError(400, "Attachment range mismatch.");
  }
  const expectedBytes = range.end - range.start + 1;
  if (expectedBytes > CHUNK_BYTES) throw new LocalHttpError(413, "Attachment chunk is too large.");
  const current = await fs.stat(target).catch(() => null);
  if (current?.size === attachment.sizeBytes) return;
  if ((current?.size ?? 0) > range.start) {
    if ((current?.size ?? 0) >= range.end + 1) return;
    throw new LocalHttpError(409, "Attachment chunk overlaps an incomplete range.");
  }
  if ((current?.size ?? 0) !== range.start) {
    throw new LocalHttpError(409, `Expected chunk offset ${current?.size ?? 0}.`);
  }
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > expectedBytes) req.destroy(new LocalHttpError(413, "Chunk is too large."));
  });
  try {
    await pipeline(req, createWriteStream(target, { flags: range.start === 0 ? "w" : "a" }));
    if (bytes !== expectedBytes) throw new LocalHttpError(400, "Attachment chunk size mismatch.");
  } catch (error) {
    await fs.truncate(target, range.start).catch(() => undefined);
    throw error;
  }
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_JSON_BYTES) throw new LocalHttpError(413, "JSON body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
  } catch {
    throw new LocalHttpError(400, "Invalid JSON body.");
  }
}

function parseContentRange(value: string | undefined): {
  start: number;
  end: number;
  total: number;
} {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) throw new LocalHttpError(400, "Content-Range is required.");
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function responseSignature(request: RelayResponseUploadRequest): string {
  return sha256Text(
    JSON.stringify({
      markdown: request.markdown,
      attachments: request.attachments.map(({ filename, mimeType, sizeBytes, sha256 }) => ({
        filename,
        mimeType,
        sizeBytes,
        sha256: sha256.toLowerCase(),
      })),
    }),
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function uniqueArtifactPath(directory: string, filename: string): Promise<string> {
  const parsed = path.parse(safeFilename(filename));
  for (let index = 0; ; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

function uploadPath(directory: string, attachmentId: string): string {
  return path.join(directory, `${assertSafeId(attachmentId)}.part`);
}

function safeFilename(value: string): string {
  const filename = path.basename(value || "attachment.bin").replace(/[\u0000-\u001f]/g, "_");
  return filename || "attachment.bin";
}

function assertSafeId(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9._-]{1,160}$/.test(value)) {
    throw new LocalHttpError(400, "Identifier is invalid.");
  }
  return value;
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

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

class LocalHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
