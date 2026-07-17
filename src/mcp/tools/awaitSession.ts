import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SessionMetadata } from "../../sessionManager.js";
import { sessionStore } from "../../sessionStore.js";

const DEFAULT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const PROGRESS_INTERVAL_MS = 15_000;
const LOG_TAIL_BYTES = 4_000;

const awaitSessionInputShape = {
  id: z.string().min(1).describe("Existing Oracle session id or slug to wait for."),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(DEFAULT_WAIT_TIMEOUT_MS)
    .optional()
    .describe("Maximum server-side wait in milliseconds (default and maximum: 24 hours)."),
  includeMetadata: z
    .boolean()
    .optional()
    .describe("Include complete session metadata in structuredContent (default: false)."),
} satisfies z.ZodRawShape;

const awaitSessionOutputShape = {
  sessionId: z.string(),
  status: z.string(),
  output: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
} satisfies z.ZodRawShape;

const TERMINAL_STATUSES = new Set(["completed", "partial", "error", "cancelled"]);

export function isTerminalSessionStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface WaitForSessionOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => void | Promise<void>;
}

export interface WaitForSessionDeps {
  readSession: (id: string) => Promise<SessionMetadata | null>;
  now?: () => number;
}

function abortError(sessionId: string): Error {
  const error = new Error(`Stopped waiting for Oracle session ${sessionId}.`);
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError("request"));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError("request"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function waitForTerminalSession(
  sessionId: string,
  options: WaitForSessionOptions,
  deps: WaitForSessionDeps = { readSession: sessionStore.readSession },
): Promise<SessionMetadata> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let lastProgressAt = Number.NEGATIVE_INFINITY;
  let lastProgressValue = 0;
  let lastStatus: string | undefined;

  while (true) {
    if (options.signal?.aborted) throw abortError(sessionId);
    const metadata = await deps.readSession(sessionId);
    if (!metadata) throw new Error(`Session "${sessionId}" not found.`);
    if (isTerminalSessionStatus(metadata.status)) return metadata;

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Oracle session ${sessionId} (status=${metadata.status}).`,
      );
    }

    if (
      options.onProgress &&
      (metadata.status !== lastStatus || elapsedMs - lastProgressAt >= PROGRESS_INTERVAL_MS)
    ) {
      lastStatus = metadata.status;
      lastProgressAt = elapsedMs;
      lastProgressValue = Math.max(lastProgressValue + 1, Math.floor(elapsedMs / 1000));
      await options.onProgress(
        lastProgressValue,
        `Oracle session ${sessionId}: ${metadata.status}`,
      );
    }

    await delay(Math.min(pollIntervalMs, timeoutMs - elapsedMs), options.signal);
  }
}

async function readLogTail(sessionId: string): Promise<string> {
  const log = await sessionStore.readLog(sessionId).catch(() => "");
  return log.length <= LOG_TAIL_BYTES ? log : log.slice(-LOG_TAIL_BYTES);
}

export function registerAwaitSessionTool(server: McpServer): void {
  server.registerTool(
    "await_session",
    {
      title: "Wait for an Oracle session",
      description:
        "Block this single MCP tool call until an existing Oracle session reaches a terminal state. Do not poll sessions/status while this call is pending. This tool never submits a new prompt and cancelling the wait does not cancel the Oracle session.",
      inputSchema: awaitSessionInputShape,
      outputSchema: awaitSessionOutputShape,
    },
    async (input: unknown, extra) => {
      const parsed = z.object(awaitSessionInputShape).strict().parse(input);
      const progressToken = extra?._meta?.progressToken;
      const metadata = await waitForTerminalSession(parsed.id, {
        timeoutMs: parsed.timeoutMs,
        signal: extra?.signal,
        onProgress:
          progressToken === undefined
            ? undefined
            : async (progress, message) => {
                await extra.sendNotification(
                  ProgressNotificationSchema.parse({
                    method: "notifications/progress",
                    params: { progressToken, progress, message },
                  }),
                );
              },
      });
      const output = await readLogTail(metadata.id);
      return {
        content: [
          {
            type: "text" as const,
            text: [`Session ${metadata.id} (${metadata.status})`, output || "(log empty)"]
              .join("\n")
              .trim(),
          },
        ],
        structuredContent: {
          sessionId: metadata.id,
          status: metadata.status,
          output,
          metadata: parsed.includeMetadata ? metadata : undefined,
        },
      };
    },
  );
}
