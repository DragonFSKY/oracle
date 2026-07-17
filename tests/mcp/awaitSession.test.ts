import { describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.js";
import {
  isTerminalSessionStatus,
  registerAwaitSessionTool,
  waitForTerminalSession,
} from "../../src/mcp/tools/awaitSession.js";

function metadata(status: string): SessionMetadata {
  return {
    id: "session-1",
    createdAt: "2026-07-17T00:00:00.000Z",
    status,
    mode: "browser",
    model: "gpt-5.5-pro",
    options: { prompt: "review", mode: "browser" },
  };
}

describe("await_session MCP tool", () => {
  test("recognizes every persisted terminal status", () => {
    for (const status of ["completed", "partial", "error", "cancelled"]) {
      expect(isTerminalSessionStatus(status)).toBe(true);
    }
    for (const status of ["pending", "running"]) {
      expect(isTerminalSessionStatus(status)).toBe(false);
    }
  });

  test("blocks locally until the existing session becomes terminal", async () => {
    const readSession = vi
      .fn<(_: string) => Promise<SessionMetadata | null>>()
      .mockResolvedValueOnce(metadata("running"))
      .mockResolvedValueOnce(metadata("running"))
      .mockResolvedValueOnce(metadata("completed"));
    const progress: string[] = [];

    const result = await waitForTerminalSession(
      "session-1",
      {
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        onProgress: (_value, message) => {
          progress.push(message);
        },
      },
      { readSession },
    );

    expect(result.status).toBe("completed");
    expect(readSession).toHaveBeenCalledTimes(3);
    expect(progress).toEqual(["Oracle session session-1: running"]);
  });

  test("stops only the waiter when the MCP request is cancelled", async () => {
    const controller = new AbortController();
    const readSession = vi.fn(async () => metadata("running"));
    const waiting = waitForTerminalSession(
      "session-1",
      { timeoutMs: 1_000, pollIntervalMs: 100, signal: controller.signal },
      { readSession },
    );
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(readSession).toHaveBeenCalledTimes(1);
  });

  test("registers a strict JSON-schema-compatible blocking tool", () => {
    let registeredName = "";
    let description = "";
    registerAwaitSessionTool({
      registerTool: (name: string, definition: { description?: string }) => {
        registeredName = name;
        description = definition.description ?? "";
      },
    } as unknown as Parameters<typeof registerAwaitSessionTool>[0]);

    expect(registeredName).toBe("await_session");
    expect(description).toMatch(/Do not poll sessions\/status/);
  });
});
