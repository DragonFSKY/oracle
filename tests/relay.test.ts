import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer, type RelayServerInstance } from "../src/relay/server.js";
import {
  acknowledgeRelayTask,
  cancelRelayTask,
  createRelayTask,
  createRelayTaskFromFiles,
  downloadRelayAttachment,
  getRelayTask,
  getRelayTaskByRequestId,
  updateRelayTaskLocalReceiver,
  waitForRelayTaskEvents,
} from "../src/relay/client.js";
import { collectRelayTaskResult, runRelayEngine } from "../src/relay/engine.js";
import {
  readLocalResponseReceipt,
  startLocalResponseReceiver,
  type LocalResponseReceiverInstance,
} from "../src/relay/localReceiver.js";
import { buildSessionLifecycle } from "../src/cli/sessionLifecycle.js";
import { refreshRelaySessionOnce, submitRelaySession } from "../src/cli/relaySession.js";
import { sessionStore } from "../src/sessionStore.js";

const servers: RelayServerInstance[] = [];
const localReceivers: LocalResponseReceiverInstance[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(localReceivers.splice(0).map((receiver) => receiver.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setup(
  logger?: (message: string) => void,
  limits: {
    maxBodyBytes?: number;
    maxAttachmentBytes?: number;
    maxTaskBytes?: number;
    terminalRetentionMs?: number;
  } = {},
) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-relay-test-"));
  tempDirs.push(dataDir);
  const server = await createRelayServer({
    host: "127.0.0.1",
    producerToken: "producer-test-token",
    operatorToken: "operator-test-token",
    dataDir,
    logger,
    ...limits,
  });
  servers.push(server);
  return {
    server,
    dataDir,
    url: `http://127.0.0.1:${server.port}`,
    producer: { url: `http://127.0.0.1:${server.port}`, token: server.producerToken },
  };
}

async function operatorRequest(url: string, pathname: string, body?: unknown) {
  const response = await fetch(`${url}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer operator-test-token",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBeLessThan(300);
  return response;
}

describe("human relay", () => {
  it("offers clipboard actions for text and image request attachments", async () => {
    const { url } = await setup();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("复制内容");
    expect(html).toContain("复制图片");
    expect(html).toContain("navigator.clipboard.writeText(await blob.text())");
    expect(html).toContain("new ClipboardItem({'image/png':png})");
    expect(html).toContain("浏览器无法直接复制此类文件");
    expect(html).toContain("中止任务");
    expect(html).toContain("/abort");
  });

  it("lets any authenticated operator abort a stuck task", async () => {
    const logs: string[] = [];
    const { url, producer } = await setup((message) => logs.push(message));
    const task = await createRelayTask(producer, {
      prompt: "Generate an image",
      title: "stuck-image",
    });
    await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "phone" });
    await operatorRequest(url, `/v1/tasks/${task.id}/abort`, { operator: "mac" });

    const cancelled = await getRelayTask(producer, task.id);
    expect(cancelled.status).toBe("cancelled");
    expect(logs.join("\n")).toContain('"event":"task.cancelled"');
    expect(logs.join("\n")).toContain('"actorRole":"operator"');
  });

  it("shares one active task across operator clients without ownership locks", async () => {
    const { url, producer } = await setup();
    const task = await createRelayTask(producer, { prompt: "Use this task from every device" });

    const claimed = await operatorRequest(url, `/v1/tasks/${task.id}/claim`, {
      operator: "windows",
    });
    expect((await claimed.json()).claimedBy).toBe("windows");

    const joined = await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "mac" });
    expect((await joined.json()).claimedBy).toBe("mac");
    await operatorRequest(url, `/v1/tasks/${task.id}/submitted`, { operator: "android" });
    await operatorRequest(url, `/v1/tasks/${task.id}/heartbeat`, { operator: "windows" });
    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "mac",
      markdown: "Completed from another client.",
    });

    const completed = await getRelayTask(producer, task.id);
    expect(completed.status).toBe("completed");
    expect(completed.response?.submittedBy).toBe("mac");
  });

  it("does not require a claim before an operator submits an answer", async () => {
    const { url, producer } = await setup();
    const task = await createRelayTask(producer, { prompt: "Answer directly from the queue" });
    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "android",
      markdown: "No claim was needed.",
    });
    expect((await getRelayTask(producer, task.id)).response?.submittedBy).toBe("android");
  });

  it("accepts only the first terminal response when clients submit together", async () => {
    const { url, producer } = await setup();
    const task = await createRelayTask(producer, { prompt: "Take the first submitted answer" });
    await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "windows" });
    const headers = {
      Authorization: "Bearer operator-test-token",
      "Content-Type": "application/json",
    };

    const responses = await Promise.all(
      ["mac", "android"].map((operator) =>
        fetch(`${url}/v1/tasks/${task.id}/response`, {
          method: "POST",
          headers,
          body: JSON.stringify({ operator, markdown: `Answer from ${operator}` }),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const completed = await getRelayTask(producer, task.id);
    expect(["Answer from mac", "Answer from android"]).toContain(completed.response?.markdown);
  });

  it("persists, claims, and completes a task with attachments", async () => {
    const { url, producer, dataDir } = await setup();
    const task = await createRelayTask(producer, {
      prompt: "Review this file",
      title: "review",
      attachments: [
        {
          filename: "input.txt",
          contentBase64: Buffer.from("hello").toString("base64"),
        },
      ],
    });
    expect(task.status).toBe("queued");
    expect(task.attachments[0]?.sizeBytes).toBe(5);

    await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "phone" });
    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "phone",
      markdown: "Looks good.",
      attachments: [
        {
          filename: "report.md",
          mimeType: "text/markdown",
          contentBase64: Buffer.from("# Report").toString("base64"),
        },
      ],
    });
    const completed = await getRelayTask(producer, task.id);
    expect(completed.status).toBe("completed");
    expect(completed.response?.markdown).toBe("Looks good.");
    expect(completed.response?.attachments[0]?.filename).toBe("report.md");

    await acknowledgeRelayTask(producer, task.id);
    await expect(getRelayTask(producer, task.id)).rejects.toThrow(/404/);
    await expect(fs.stat(path.join(dataDir, "tasks", task.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("streams request attachments outside the JSON body limit", async () => {
    const logs: string[] = [];
    const { url, producer } = await setup((message) => logs.push(message), {
      maxBodyBytes: 4 * 1024,
      maxAttachmentBytes: 12 * 1024 * 1024,
      maxTaskBytes: 12 * 1024 * 1024,
    });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-relay-stream-"));
    tempDirs.push(cwd);
    const source = path.join(cwd, "large.zip");
    await fs.writeFile(source, Buffer.alloc(10 * 1024 * 1024, 7));

    const task = await createRelayTaskFromFiles(
      producer,
      { prompt: "Review the large archive", title: "large-stream" },
      [{ path: source, filename: "large.zip" }],
    );

    expect(task.status).toBe("queued");
    expect(task.attachments[0]?.sizeBytes).toBe(10 * 1024 * 1024);
    expect(logs.join("\n")).toContain('"event":"attachment.upload_chunk"');
    const download = await fetch(
      `${url}/v1/tasks/${task.id}/attachments/${task.attachments[0]!.id}`,
      { headers: { Authorization: "Bearer operator-test-token" } },
    );
    expect(download.status).toBe(200);
    expect((await download.arrayBuffer()).byteLength).toBe(10 * 1024 * 1024);
  });

  it("stages, retries, and publishes chunked response attachments", async () => {
    const logs: string[] = [];
    const { url, producer } = await setup((message) => logs.push(message), {
      maxBodyBytes: 4 * 1024,
      maxAttachmentBytes: 4 * 1024 * 1024,
      maxTaskBytes: 4 * 1024 * 1024,
    });
    const task = await createRelayTask(producer, { prompt: "Return the generated image" });
    const bytes = Buffer.alloc(2 * 1024 * 1024, 23);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const stagedResponse = await operatorRequest(url, `/v1/tasks/${task.id}/responses/uploads`, {
      operator: "mac",
      markdown: "Generated image attached.",
      attachments: [
        {
          filename: "generated.png",
          mimeType: "image/png",
          sizeBytes: bytes.length,
          sha256: digest,
        },
      ],
    });
    const staged = (await stagedResponse.json()) as {
      id: string;
      uploadChunkBytes: number;
      attachments: Array<{ id: string }>;
    };
    expect(staged.uploadChunkBytes).toBe(1024 * 1024);
    const attachmentId = staged.attachments[0]!.id;
    for (let start = 0; start < bytes.length; start += staged.uploadChunkBytes) {
      const end = Math.min(bytes.length - 1, start + staged.uploadChunkBytes - 1);
      const upload = () =>
        fetch(`${url}/v1/tasks/${task.id}/responses/${staged.id}/attachments/${attachmentId}`, {
          method: "PUT",
          headers: {
            Authorization: "Bearer operator-test-token",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
          },
          body: bytes.subarray(start, end + 1),
        });
      expect((await upload()).status).toBe(200);
      if (start === 0) {
        expect((await upload()).status).toBe(200);
        const resumedResponse = await operatorRequest(
          url,
          `/v1/tasks/${task.id}/responses/uploads`,
          {
            operator: "mac-retry",
            markdown: "Generated image attached.",
            attachments: [
              {
                filename: "generated.png",
                mimeType: "image/png",
                sizeBytes: bytes.length,
                sha256: digest,
              },
            ],
          },
        );
        expect((await resumedResponse.json()).id).toBe(staged.id);
      }
    }
    await operatorRequest(url, `/v1/tasks/${task.id}/responses/${staged.id}/publish`, {});

    const completed = await getRelayTask(producer, task.id);
    expect(completed.status).toBe("completed");
    expect(completed.response?.markdown).toBe("Generated image attached.");
    expect(completed.response?.attachments[0]).toMatchObject({
      filename: "generated.png",
      sizeBytes: bytes.length,
      sha256: digest,
      direction: "response",
    });
    expect(logs.join("\n")).toContain('"event":"attachment.upload_chunk"');
    expect(logs.join("\n")).toContain('"event":"task.completed"');
  });

  it("uses a task-scoped loopback receiver and keeps the public relay as control plane", async () => {
    const { url, producer } = await setup();
    const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-relay-local-artifacts-"));
    tempDirs.push(artifactsDir);
    const receiver = await startLocalResponseReceiver({
      requestId: "local-fast-path-test",
      artifactsDir,
    });
    localReceivers.push(receiver);
    const task = await createRelayTask(producer, {
      requestId: "local-fast-path-test",
      prompt: "Return this locally",
      localReceiver: receiver.capability,
    });
    expect(task.localReceiver).toEqual(receiver.capability);

    const replacement = await startLocalResponseReceiver({
      requestId: "local-fast-path-test",
      artifactsDir,
    });
    localReceivers.push(replacement);
    const refreshed = await updateRelayTaskLocalReceiver(producer, task.id, replacement.capability);
    expect(refreshed.localReceiver).toEqual(replacement.capability);
    await updateRelayTaskLocalReceiver(producer, task.id, receiver.capability);

    const localHeaders = {
      Authorization: `Bearer ${receiver.capability.token}`,
      "Content-Type": "application/json",
    };
    const health = await fetch(`${receiver.capability.baseUrl}/v1/tasks/${task.id}/health`, {
      headers: localHeaders,
    });
    expect(await health.json()).toMatchObject({
      version: 1,
      requestId: "local-fast-path-test",
      taskId: task.id,
    });

    const bytes = Buffer.alloc(1024 * 1024 + 17, 44);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const localRequest = {
      operator: "mac",
      markdown: "Delivered over loopback.",
      attachments: [
        {
          filename: "local.bin",
          mimeType: "application/octet-stream",
          sizeBytes: bytes.length,
          sha256,
        },
      ],
    };
    const stagedResponse = await fetch(
      `${receiver.capability.baseUrl}/v1/tasks/${task.id}/responses/uploads`,
      { method: "POST", headers: localHeaders, body: JSON.stringify(localRequest) },
    );
    expect(stagedResponse.status).toBe(201);
    const staged = (await stagedResponse.json()) as {
      id: string;
      uploadChunkBytes: number;
      attachments: Array<{ id: string }>;
    };
    for (let start = 0; start < bytes.length; start += staged.uploadChunkBytes) {
      const end = Math.min(bytes.length - 1, start + staged.uploadChunkBytes - 1);
      const send = () =>
        fetch(
          `${receiver.capability.baseUrl}/v1/tasks/${task.id}/responses/${staged.id}/attachments/${staged.attachments[0]!.id}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${receiver.capability.token}`,
              "Content-Length": String(end - start + 1),
              "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
            },
            body: bytes.subarray(start, end + 1),
          },
        );
      expect((await send()).status).toBe(200);
      if (start === 0) expect((await send()).status).toBe(200);
    }
    const localPublish = await fetch(
      `${receiver.capability.baseUrl}/v1/tasks/${task.id}/responses/${staged.id}/publish`,
      { method: "POST", headers: localHeaders, body: "{}" },
    );
    expect(localPublish.status).toBe(200);
    const receipt = await readLocalResponseReceipt(artifactsDir);
    expect(receipt?.artifacts[0]).toMatchObject({
      label: "local.bin",
      sizeBytes: bytes.length,
      sha256,
    });

    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "mac",
      markdown: localRequest.markdown,
    });
    const completed = await getRelayTask(producer, task.id);
    const result = await collectRelayTaskResult(completed, producer, artifactsDir);
    expect(result.answerText).toBe(localRequest.markdown);
    expect(result.artifacts[0]).toMatchObject({
      label: "local.bin",
      sizeBytes: bytes.length,
      sha256,
    });
  });

  it("publishes a staged zero-byte response attachment", async () => {
    const { url, producer } = await setup();
    const task = await createRelayTask(producer, { prompt: "Return an empty marker file" });
    const stagedResponse = await operatorRequest(url, `/v1/tasks/${task.id}/responses/uploads`, {
      operator: "mac",
      markdown: "Empty marker attached.",
      attachments: [
        {
          filename: "marker.txt",
          mimeType: "text/plain",
          sizeBytes: 0,
          sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        },
      ],
    });
    const staged = (await stagedResponse.json()) as {
      id: string;
      attachments: Array<{ id: string }>;
    };
    await operatorRequest(url, `/v1/tasks/${task.id}/responses/${staged.id}/publish`, {});

    const completed = await getRelayTask(producer, task.id);
    expect(completed.response?.attachments[0]).toMatchObject({
      filename: "marker.txt",
      sizeBytes: 0,
      direction: "response",
    });
  });

  it("rejects staged attachments above the configured per-file limit", async () => {
    const { producer } = await setup(undefined, {
      maxAttachmentBytes: 4,
      maxTaskBytes: 8,
    });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-relay-limit-"));
    tempDirs.push(cwd);
    const source = path.join(cwd, "too-large.zip");
    await fs.writeFile(source, "12345");

    await expect(
      createRelayTaskFromFiles(producer, { prompt: "Review it" }, [
        { path: source, filename: "too-large.zip" },
      ]),
    ).rejects.toThrow(/413/);
  });

  it("has no default Relay per-file or per-task attachment guard", async () => {
    const { producer } = await setup();
    const formerPerFileLimit = 512 * 1024 * 1024;
    const response = await fetch(`${producer.url}/v1/tasks/uploads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${producer.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Accept metadata above the former default without allocating the file",
        attachments: [
          {
            filename: "large.bin",
            sizeBytes: formerPerFileLimit + 1,
            sha256: "a".repeat(64),
          },
          {
            filename: "also-large.bin",
            sizeBytes: formerPerFileLimit + 1,
            sha256: "b".repeat(64),
          },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const staged = await response.json();
    expect(staged.status).toBe("uploading");
    expect(staged.attachments).toHaveLength(2);
    await cancelRelayTask(producer, staged.id);
  });

  it("prunes unacknowledged terminal tasks after the retention window", async () => {
    const { server, url, producer, dataDir } = await setup();
    const task = await createRelayTask(producer, { prompt: "Finish and retain briefly" });
    await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "phone" });
    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "phone",
      markdown: "Done.",
    });
    const taskPath = path.join(dataDir, "tasks", task.id, "task.json");
    const stored = JSON.parse(await fs.readFile(taskPath, "utf8")) as Record<string, unknown>;
    stored.completedAt = "2000-01-01T00:00:00.000Z";
    stored.updatedAt = stored.completedAt;
    await fs.writeFile(taskPath, JSON.stringify(stored));

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const restarted = await createRelayServer({
      host: "127.0.0.1",
      producerToken: "producer-test-token",
      operatorToken: "operator-test-token",
      dataDir,
      terminalRetentionMs: 1,
      logger: () => {},
    });
    servers.push(restarted);
    await expect(
      getRelayTask(
        { url: `http://127.0.0.1:${restarted.port}`, token: restarted.producerToken },
        task.id,
      ),
    ).rejects.toThrow(/404/);
  });

  it("runs the relay engine end to end and restores response artifacts", async () => {
    const { url, producer } = await setup();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-relay-cwd-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "source.ts"), "export const value = 1;\n");
    const artifactsDir = path.join(cwd, "artifacts");
    let completedTask = false;

    const result = await runRelayEngine(
      {
        prompt: "Review the source",
        model: "gpt-5.5-pro",
        file: ["source.ts"],
      },
      { ...producer, pollIntervalMs: 1, timeoutMs: 5_000 },
      { cwd, sessionId: "relay-session", artifactsDir },
      {
        sleep: async () => {},
        onTask: async (task) => {
          if (completedTask || task.status !== "queued") return;
          completedTask = true;
          await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "laptop" });
          await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
            operator: "laptop",
            markdown: "Use a readonly export.",
            attachments: [
              {
                filename: "suggestion.patch",
                contentBase64: Buffer.from("patch contents").toString("base64"),
              },
            ],
          });
        },
      },
    );

    expect(result.answerText).toBe("Use a readonly export.");
    expect(result.artifacts).toHaveLength(1);
    expect(await fs.readFile(result.artifacts[0]!.path, "utf8")).toBe("patch contents");
    expect(result.relay.status).toBe("completed");
  });

  it("submits without a local worker and refreshes the remote task exactly on demand", async () => {
    const { url, producer } = await setup();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-relay-submit-only-"));
    tempDirs.push(cwd);
    const session = await sessionStore.createSession(
      {
        prompt: "Review once",
        model: "gpt-5.6",
        mode: "relay",
        relayConfig: producer,
        waitPreference: false,
      },
      cwd,
    );
    const paths = await sessionStore.getPaths(session.id);
    tempDirs.push(paths.dir);
    const lifecycle = buildSessionLifecycle({
      engine: "relay",
      detached: false,
      waitingRemote: true,
      reattachCommand: `dragon-relay wait ${session.id}`,
    });
    await sessionStore.updateSession(session.id, { lifecycle });

    const submitted = await submitRelaySession({
      sessionMeta: { ...session, lifecycle },
      runOptions: { prompt: "Review once", model: "gpt-5.6" },
      relayConfig: producer,
      cwd,
    });
    expect(submitted.relay?.status).toBe("queued");
    expect(submitted.lifecycle?.waitingRemote).toBe(true);
    expect(submitted.lifecycle?.workerPid).toBeUndefined();

    const pending = await refreshRelaySessionOnce(session.id);
    expect(pending.state).toBe("pending");
    expect(pending.metadata.relay?.status).toBe("queued");

    const taskId = submitted.relay?.taskId;
    expect(taskId).toBeTruthy();
    await operatorRequest(url, `/v1/tasks/${taskId}/claim`, { operator: "laptop" });
    await operatorRequest(url, `/v1/tasks/${taskId}/response`, {
      operator: "laptop",
      markdown: "Finished manually.",
    });

    const completed = await refreshRelaySessionOnce(session.id);
    expect(completed.state).toBe("completed");
    expect(completed.metadata.status).toBe("completed");
    expect(await sessionStore.readLog(session.id)).toContain("Finished manually.");
    await expect(getRelayTask(producer, taskId!)).rejects.toThrow(/404/u);
  });

  it("keeps one SSE connection open until the operator completes the task", async () => {
    const logs: string[] = [];
    const { url, producer } = await setup((message) => logs.push(message));
    const task = await createRelayTask(producer, {
      requestId: "relay-sse-single-connection",
      prompt: "Wait on one event stream",
    });
    let sawInitial!: () => void;
    const initial = new Promise<void>((resolve) => {
      sawInitial = resolve;
    });
    const statuses: string[] = [];
    const waiting = waitForRelayTaskEvents(producer, task.id, {
      timeoutMs: 5_000,
      onTask: (observed) => {
        statuses.push(observed.status);
        if (observed.status === "queued") sawInitial();
      },
    });
    await initial;
    await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "phone" });
    await operatorRequest(url, `/v1/tasks/${task.id}/submitted`, { operator: "phone" });
    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "phone",
      markdown: "SSE finished.",
    });
    const completed = await waiting;
    expect(completed.status).toBe("completed");
    expect(statuses).toEqual(["queued", "claimed", "awaiting-response", "completed"]);
    expect(logs.filter((line) => line.includes('"event":"task.events_connected"'))).toHaveLength(1);
  });

  it("waits indefinitely when the Relay timeout is zero", async () => {
    const { url, producer } = await setup();
    const task = await createRelayTask(producer, {
      requestId: "relay-indefinite-wait",
      prompt: "Wait without a deadline",
      expiresInMs: 0,
    });
    expect(task.expiresAt).toBe("9999-12-31T23:59:59.999Z");

    const waiting = waitForRelayTaskEvents(producer, task.id, { timeoutMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 75));
    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "phone",
      markdown: "Returned after the deadline-free wait.",
    });
    expect((await waiting).response?.markdown).toBe("Returned after the deadline-free wait.");
  });

  it("extends an active task to an indefinite local receiver lifetime", async () => {
    const { producer } = await setup();
    const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-relay-indefinite-local-"));
    tempDirs.push(artifactsDir);
    const task = await createRelayTask(producer, {
      requestId: "relay-local-indefinite",
      prompt: "Keep the local response route alive",
    });
    const receiver = await startLocalResponseReceiver({
      requestId: "relay-local-indefinite",
      artifactsDir,
      lifetimeMs: 0,
    });
    localReceivers.push(receiver);
    expect(receiver.capability.expiresAt).toBe("9999-12-31T23:59:59.999Z");

    const updated = await updateRelayTaskLocalReceiver(producer, task.id, receiver.capability);
    expect(updated.expiresAt).toBe("9999-12-31T23:59:59.999Z");
  });

  it("fails fast when the SSE task does not exist", async () => {
    const { producer } = await setup();
    await expect(
      waitForRelayTaskEvents(producer, "missing-task", { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ status: 404, retryable: false });
  });

  it("reconnects after a Relay restart and receives the persisted terminal snapshot", async () => {
    const { server, dataDir, url, producer } = await setup();
    const task = await createRelayTask(producer, {
      requestId: "relay-restart-recovery",
      prompt: "Survive a Relay restart",
    });
    let sawInitial!: () => void;
    const initial = new Promise<void>((resolve) => {
      sawInitial = resolve;
    });
    const waiting = waitForRelayTaskEvents(producer, task.id, {
      timeoutMs: 10_000,
      reconnectDelayMs: 10,
      onTask: (observed) => {
        if (observed.status === "queued") sawInitial();
      },
    });
    await initial;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const restarted = await createRelayServer({
      host: "127.0.0.1",
      port: server.port,
      producerToken: server.producerToken,
      operatorToken: server.operatorToken,
      dataDir,
      logger: () => {},
    });
    servers.push(restarted);
    await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "phone" });
    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "phone",
      markdown: "Recovered after restart.",
    });
    expect((await waiting).response?.markdown).toBe("Recovered after restart.");
  });

  it("deduplicates identical request ids and rejects conflicting reuse", async () => {
    const { producer } = await setup();
    const first = await createRelayTask(producer, {
      requestId: "stable-review-request",
      prompt: "Review this exact input",
    });
    const repeated = await createRelayTask(producer, {
      requestId: "stable-review-request",
      prompt: "Review this exact input",
    });
    expect(repeated.id).toBe(first.id);
    await expect(
      createRelayTask(producer, {
        requestId: "stable-review-request",
        prompt: "Different input",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await getRelayTaskByRequestId(producer, "stable-review-request")).id).toBe(first.id);
  });

  it("resumes a multi-chunk upload from an already committed prefix", async () => {
    const { url, producer } = await setup(undefined, {
      maxAttachmentBytes: 16 * 1024 * 1024,
      maxTaskBytes: 16 * 1024 * 1024,
    });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-relay-resume-upload-"));
    tempDirs.push(cwd);
    const source = path.join(cwd, "resume.zip");
    const bytes = Buffer.alloc(10 * 1024 * 1024, 9);
    await fs.writeFile(source, bytes);
    const requestId = "relay-resume-upload-prefix";
    const stagedResponse = await fetch(`${url}/v1/tasks/uploads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${producer.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId,
        prompt: "Resume a partially uploaded archive",
        attachments: [
          {
            filename: "resume.zip",
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      }),
    });
    expect(stagedResponse.status).toBe(201);
    const staged = (await stagedResponse.json()) as {
      id: string;
      uploadChunkBytes: number;
      attachments: Array<{ id: string }>;
    };
    const chunkBytes = staged.uploadChunkBytes;
    const attachmentId = staged.attachments[0]!.id;
    for (let start = 0; start < chunkBytes * 2; start += chunkBytes) {
      const end = start + chunkBytes - 1;
      const response = await fetch(`${url}/v1/tasks/${staged.id}/attachments/${attachmentId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${producer.token}`,
          "Content-Length": String(chunkBytes),
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        },
        body: bytes.subarray(start, end + 1),
      });
      expect(response.status).toBe(200);
    }

    const completedUpload = await createRelayTaskFromFiles(
      producer,
      { requestId, prompt: "Resume a partially uploaded archive" },
      [{ path: source, filename: "resume.zip" }],
    );
    expect(completedUpload.id).toBe(staged.id);
    expect(completedUpload.status).toBe("queued");
  });

  it("retains queued cancellation so a reconnecting waiter sees the terminal snapshot", async () => {
    const { producer } = await setup();
    const task = await createRelayTask(producer, { prompt: "Cancel before claim" });
    await cancelRelayTask(producer, task.id);
    const cancelled = await waitForRelayTaskEvents(producer, task.id, { timeoutMs: 2_000 });
    expect(cancelled.status).toBe("cancelled");
  });

  it("preserves response attachments whose display names collide", async () => {
    const { url, producer } = await setup();
    const task = await createRelayTask(producer, { prompt: "Return colliding files" });
    await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "phone" });
    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "phone",
      markdown: "Two files.",
      attachments: [
        { filename: "same.txt", contentBase64: Buffer.from("first").toString("base64") },
        { filename: "same.txt", contentBase64: Buffer.from("second").toString("base64") },
      ],
    });
    const completed = await getRelayTask(producer, task.id);
    const destination = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-relay-collide-"));
    tempDirs.push(destination);
    const paths = await Promise.all(
      completed.response!.attachments.map((attachment) =>
        downloadRelayAttachment(producer, task.id, attachment, destination),
      ),
    );
    expect(new Set(paths).size).toBe(2);
    expect((await Promise.all(paths.map((file) => fs.readFile(file, "utf8")))).sort()).toEqual([
      "first",
      "second",
    ]);
  });

  it("serializes heartbeat and completion so terminal state cannot roll back", async () => {
    const { url, producer } = await setup();
    for (let index = 0; index < 10; index += 1) {
      const task = await createRelayTask(producer, { prompt: `Race ${index}` });
      await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "phone" });
      await operatorRequest(url, `/v1/tasks/${task.id}/submitted`, { operator: "phone" });
      const headers = {
        Authorization: "Bearer operator-test-token",
        "Content-Type": "application/json",
      };
      const [heartbeat, response] = await Promise.all([
        fetch(`${url}/v1/tasks/${task.id}/heartbeat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ operator: "phone" }),
        }),
        fetch(`${url}/v1/tasks/${task.id}/response`, {
          method: "POST",
          headers,
          body: JSON.stringify({ operator: "phone", markdown: `Done ${index}` }),
        }),
      ]);
      expect([200, 409]).toContain(heartbeat.status);
      expect(response.status).toBe(200);
      const completed = await getRelayTask(producer, task.id);
      expect(completed.status).toBe("completed");
      expect(completed.response?.markdown).toBe(`Done ${index}`);
    }
  });

  it("logs task lifecycle metadata without prompt or answer contents", async () => {
    const logs: string[] = [];
    const { url, producer } = await setup((message) => logs.push(message));
    const task = await createRelayTask(producer, {
      prompt: "SECRET_PROMPT_CONTENT",
      sessionId: "diagnostic-session",
      attachments: [],
    });
    await operatorRequest(url, `/v1/tasks/${task.id}/claim`, { operator: "phone" });
    await operatorRequest(url, `/v1/tasks/${task.id}/submitted`, { operator: "phone" });
    await operatorRequest(url, `/v1/tasks/${task.id}/response`, {
      operator: "phone",
      markdown: "SECRET_ANSWER_CONTENT",
    });

    const output = logs.join("\n");
    expect(output).toContain('"event":"task.created"');
    expect(output).toContain('"event":"task.claimed"');
    expect(output).toContain('"event":"task.submitted"');
    expect(output).toContain('"event":"task.completed"');
    expect(output).toContain('"sessionId":"diagnostic-session"');
    expect(output).not.toContain("SECRET_PROMPT_CONTENT");
    expect(output).not.toContain("SECRET_ANSWER_CONTENT");
    expect(output).not.toContain("producer-test-token");
    expect(output).not.toContain("operator-test-token");
  });
});
