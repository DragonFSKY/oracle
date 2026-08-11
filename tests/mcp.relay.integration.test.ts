import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRelayServer, type RelayServerInstance } from "../src/relay/server.js";

describe.sequential("dragon-relay-mcp blocking flow", () => {
  let relay: RelayServerInstance;
  let relayUrl: string;
  let homeDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "dragon-relay-mcp-home-"));
    relay = await createRelayServer({
      host: "127.0.0.1",
      producerToken: "producer-mcp-token",
      operatorToken: "operator-mcp-token",
      dataDir: path.join(homeDir, "relay-server"),
      logger: () => {},
    });
    relayUrl = `http://127.0.0.1:${relay.port}`;
    client = new Client({ name: "relay-integration", version: "0.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/bin/dragon-relay-mcp.js")],
      cwd: process.cwd(),
      env: {
        ...process.env,
        ORACLE_HOME_DIR: homeDir,
        ORACLE_DISABLE_KEYTAR: "1",
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await relay?.close().catch(() => undefined);
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("blocks ask and await on one durable task, then resumes idempotently", async () => {
    const args = {
      requestId: "mcp-blocking-review-test",
      prompt: "Review the event-driven relay path.",
      files: [],
      model: "gpt-5.6",
      relayUrl,
      relayToken: relay.producerToken,
    };
    const ask = client.callTool({ name: "ask_expert", arguments: args }, undefined, {
      timeout: 25_000,
    });
    const task = await waitForOperatorTask();
    const awaiting = client.callTool(
      { name: "await_expert", arguments: { id: args.requestId } },
      undefined,
      { timeout: 25_000 },
    );
    await operator(`/v1/tasks/${task.id}/claim`, { operator: "integration" });
    await operator(`/v1/tasks/${task.id}/submitted`, { operator: "integration" });
    await operator(`/v1/tasks/${task.id}/response`, {
      operator: "integration",
      markdown: "The blocking path completed.",
      attachments: [
        {
          filename: "review.md",
          mimeType: "text/markdown",
          contentBase64: Buffer.from("# Review").toString("base64"),
        },
      ],
    });

    const [askResult, awaitResult] = await Promise.all([ask, awaiting]);
    expect(askResult.isError, JSON.stringify(askResult)).not.toBe(true);
    expect(awaitResult.isError, JSON.stringify(awaitResult)).not.toBe(true);
    expect(JSON.stringify(askResult)).toContain("The blocking path completed.");
    expect(JSON.stringify(awaitResult)).toContain("The blocking path completed.");

    const metadataPath = path.join(homeDir, "sessions", args.requestId, "meta.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
      relay?: { ackStatus?: string };
    };
    metadata.relay = { ...metadata.relay, ackStatus: "pending" };
    await fs.writeFile(metadataPath, JSON.stringify(metadata));

    const repeated = await client.callTool({ name: "ask_expert", arguments: args }, undefined, {
      timeout: 5_000,
    });
    expect(repeated.isError).not.toBe(true);
    expect(JSON.stringify(repeated)).toContain("The blocking path completed.");
    const acknowledged = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
      relay?: { ackStatus?: string };
    };
    expect(acknowledged.relay?.ackStatus).toBe("succeeded");

    const conflict = await client.callTool(
      {
        name: "ask_expert",
        arguments: { ...args, prompt: "Conflicting prompt." },
      },
      undefined,
      { timeout: 5_000 },
    );
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("already bound to a different expert request");

    const log = await fs.readFile(
      path.join(homeDir, "sessions", args.requestId, "output.log"),
      "utf8",
    );
    expect(log.match(/\[relay-result:/g)).toHaveLength(1);
    const artifacts = await fs.readdir(path.join(homeDir, "sessions", args.requestId, "artifacts"));
    expect(artifacts).toHaveLength(1);
  }, 45_000);

  it("recovers an unbound local session by caller-known request id", async () => {
    const requestId = "mcp-lookup-recovery-test";
    const created = await fetch(`${relayUrl}/v1/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${relay.producerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId,
        sessionId: requestId,
        prompt: "Recover this task by request id.",
        modelHint: "gpt-5.6",
      }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };
    const sessionDir = path.join(homeDir, "sessions", requestId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "meta.json"),
      JSON.stringify({
        id: requestId,
        createdAt: new Date().toISOString(),
        status: "running",
        mode: "relay",
        cwd: process.cwd(),
        model: "gpt-5.6",
        options: {
          prompt: "Recover this task by request id.",
          model: "gpt-5.6",
          file: [],
          mode: "relay",
          sessionId: requestId,
          relayConfig: { url: relayUrl, token: "<redacted>" },
        },
        relay: {
          config: { url: relayUrl, tokenConfigured: true, timeoutMs: 10_000 },
          status: "queued",
        },
      }),
    );
    await fs.writeFile(path.join(sessionDir, "relay-token"), relay.producerToken);
    await fs.writeFile(path.join(sessionDir, "output.log"), "");

    const awaiting = client.callTool(
      { name: "await_expert", arguments: { id: requestId } },
      undefined,
      { timeout: 15_000 },
    );
    await operator(`/v1/tasks/${task.id}/claim`, { operator: "integration" });
    await operator(`/v1/tasks/${task.id}/response`, {
      operator: "integration",
      markdown: "Recovered through request lookup.",
    });
    const result = await awaiting;
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("Recovered through request lookup.");
    const recovered = JSON.parse(await fs.readFile(path.join(sessionDir, "meta.json"), "utf8")) as {
      relay?: { taskId?: string };
    };
    expect(recovered.relay?.taskId).toBe(task.id);
  }, 30_000);

  it("rejects reuse after attached file contents change", async () => {
    const requestId = "mcp-file-fingerprint-test";
    const source = path.join(homeDir, "fingerprint.txt");
    await fs.writeFile(source, "version one");
    const args = {
      requestId,
      prompt: "Review this changing file.",
      files: [source],
      model: "gpt-5.6",
      relayUrl,
      relayToken: relay.producerToken,
    };
    const ask = client.callTool({ name: "ask_expert", arguments: args }, undefined, {
      timeout: 15_000,
    });
    const task = await waitForOperatorTask(requestId);
    await operator(`/v1/tasks/${task.id}/claim`, { operator: "integration" });
    await operator(`/v1/tasks/${task.id}/response`, {
      operator: "integration",
      markdown: "First file reviewed.",
    });
    expect((await ask).isError).not.toBe(true);

    await fs.writeFile(source, "version two");
    const conflict = await client.callTool({ name: "ask_expert", arguments: args }, undefined, {
      timeout: 5_000,
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("different file contents or working directory");
  }, 30_000);

  async function waitForOperatorTask(requestId?: string): Promise<{ id: string }> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${relayUrl}/v1/tasks`, {
        headers: { Authorization: `Bearer ${relay.operatorToken}` },
      });
      const tasks = (await response.json()) as Array<{ id: string; requestId?: string }>;
      const task = requestId
        ? tasks.find((candidate) => candidate.requestId === requestId)
        : tasks[0];
      if (task) return task;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Relay task did not appear.");
  }

  async function operator(pathname: string, body: unknown): Promise<void> {
    const response = await fetch(`${relayUrl}${pathname}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${relay.operatorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBeLessThan(300);
  }
});
