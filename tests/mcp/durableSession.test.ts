import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.js";
import {
  claimInheritedDurableSessionWorker,
  classifyOrphanedBrowserSession,
  createDurableSessionWorkerToken,
  finishInheritedDurableSessionWorker,
  isRecoverableOrphanedBrowserSession,
  launchDurableSessionWorker,
  launchOrphanedBrowserRecovery,
} from "../../src/mcp/durableSession.js";
import { sessionStore } from "../../src/sessionStore.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const cleanupPids = new Set<number>();

afterEach(async () => {
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already exited
    }
  }
  cleanupPids.clear();
  setOracleHomeDirOverrideForTest(null);
});

function browserSession(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "browser-session",
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "running",
    mode: "browser",
    model: "gpt-5.6",
    options: { prompt: "review", mode: "browser" },
    browser: {
      config: {},
      runtime: {
        promptSubmitted: true,
        tabUrl: "https://chatgpt.com/c/conversation-1",
        controllerPid: 111,
      },
    },
    ...overrides,
  };
}

describe("durable MCP sessions", () => {
  test("recognizes a submitted browser run whose controller died", () => {
    expect(isRecoverableOrphanedBrowserSession(browserSession(), () => false)).toBe(true);
  });

  test("does not steal a session from a live durable runner", () => {
    const metadata = browserSession({
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        reattachCommand: "oracle session browser-session",
        runnerPid: 222,
      },
    });
    expect(isRecoverableOrphanedBrowserSession(metadata, (pid) => pid === 222)).toBe(false);
  });

  test("refuses automatic recovery before prompt submission", () => {
    const metadata = browserSession({
      browser: {
        config: {},
        runtime: {
          promptSubmitted: false,
          controllerPid: 111,
          chromePort: 9222,
        },
      },
    });
    expect(isRecoverableOrphanedBrowserSession(metadata, () => false)).toBe(false);
  });

  test("classifies a dead pre-submit worker as a fail-closed orphan after grace", () => {
    const metadata = browserSession({
      createdAt: "2026-07-20T00:00:00.000Z",
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        reattachCommand: "oracle session browser-session",
        runnerPid: 222,
        runnerStartedAt: "2026-07-20T00:00:00.000Z",
      },
      browser: {
        config: {},
        runtime: { promptSubmitted: false, controllerPid: 222 },
      },
    });

    expect(
      classifyOrphanedBrowserSession(
        metadata,
        () => false,
        () => Date.parse("2026-07-20T00:01:00.000Z"),
        30_000,
      ),
    ).toBe("failed-before-submit");
  });

  test("launches execution in a detached process", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-durable-worker-"));
    const script = path.join(dir, "worker.js");
    await writeFile(script, "setTimeout(() => process.exit(0), 30000);\n", "utf8");
    try {
      const worker = await launchDurableSessionWorker("session-1", { cliEntrypoint: script });
      cleanupPids.add(worker.pid);
      expect(worker.mode).toBe("execute");
      expect(worker.pid).toBeGreaterThan(0);
      expect(() => process.kill(worker.pid, 0)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fences and records a detached worker during parent-child hand-off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oracle-worker-claim-home-"));
    const token = createDurableSessionWorkerToken();
    const previous = {
      id: process.env.ORACLE_DURABLE_SESSION_ID,
      token: process.env.ORACLE_DURABLE_SESSION_TOKEN,
      mode: process.env.ORACLE_DURABLE_SESSION_MODE,
    };
    setOracleHomeDirOverrideForTest(home);
    await sessionStore.ensureStorage();
    const created = await sessionStore.createSession(
      { prompt: "review", model: "gpt-5.6", mode: "browser", browserConfig: {} },
      home,
      undefined,
      "claim-me",
    );
    await sessionStore.updateSession(created.id, {
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        reattachCommand: `oracle session ${created.id}`,
        runnerToken: token,
        runnerState: "launching",
        runnerStartedAt: new Date().toISOString(),
      },
    });
    process.env.ORACLE_DURABLE_SESSION_ID = created.id;
    process.env.ORACLE_DURABLE_SESSION_TOKEN = token;
    process.env.ORACLE_DURABLE_SESSION_MODE = "execute";
    try {
      await expect(claimInheritedDurableSessionWorker(created.id)).resolves.toBe(true);
      const claimed = await sessionStore.readSession(created.id);
      expect(claimed?.lifecycle).toMatchObject({
        runnerPid: process.pid,
        runnerToken: token,
        runnerState: "running",
      });

      await finishInheritedDurableSessionWorker(created.id);
      const finished = await sessionStore.readSession(created.id);
      expect(finished?.lifecycle).toMatchObject({
        runnerPid: process.pid,
        runnerToken: token,
        runnerState: "finished",
      });
    } finally {
      if (previous.id === undefined) delete process.env.ORACLE_DURABLE_SESSION_ID;
      else process.env.ORACLE_DURABLE_SESSION_ID = previous.id;
      if (previous.token === undefined) delete process.env.ORACLE_DURABLE_SESSION_TOKEN;
      else process.env.ORACLE_DURABLE_SESSION_TOKEN = previous.token;
      if (previous.mode === undefined) delete process.env.ORACLE_DURABLE_SESSION_MODE;
      else process.env.ORACLE_DURABLE_SESSION_MODE = previous.mode;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("serializes orphan recovery across MCP callers", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-home-"));
    const scriptDir = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-worker-"));
    const script = path.join(scriptDir, "worker.js");
    await writeFile(script, "setTimeout(() => process.exit(0), 30000);\n", "utf8");
    setOracleHomeDirOverrideForTest(home);
    await sessionStore.ensureStorage();
    await sessionStore.createSession(
      { prompt: "review", model: "gpt-5.6", mode: "browser", browserConfig: {} },
      home,
      undefined,
      "recover-me",
    );
    try {
      const results = await Promise.all([
        launchOrphanedBrowserRecovery("recover-me", { cliEntrypoint: script }),
        launchOrphanedBrowserRecovery("recover-me", { cliEntrypoint: script }),
      ]);
      const workers = results.filter((worker) => worker !== null);
      expect(workers).toHaveLength(1);
      cleanupPids.add(workers[0]!.pid);
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
