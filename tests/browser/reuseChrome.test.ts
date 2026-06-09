import { afterEach, describe, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireManualLoginChromeForRunForTest,
  maybeReuseRunningChromeForTest,
} from "../../src/browser/index.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import type { LaunchedChrome } from "chrome-launcher";

const noopLogger = () => {};

describe("maybeReuseRunningChrome", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("waits for a shared Chrome port before reusing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
    const port = 9222;

    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await fs.writeFile(
        path.join(tmpDir, "DevToolsActivePort"),
        `${port}\n/devtools/browser`,
        "utf8",
      );
    })();

    const probe = vi.fn(async () => ({ ok: true as const }));
    const reusePromise = maybeReuseRunningChromeForTest(tmpDir, noopLogger, {
      waitForPortMs: 1000,
      probe,
    });

    const reused = await reusePromise;
    expect(reused?.port).toBe(port);
    expect(probe).toHaveBeenCalled();

    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 10_000);

  test("returns null immediately when no port and no wait", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
    const probe = vi.fn(async () => ({ ok: true as const }));
    const reused = await maybeReuseRunningChromeForTest(tmpDir, noopLogger, {
      waitForPortMs: 0,
      probe,
    });
    expect(reused).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("cleans stale locks when a recorded Chrome pid is dead and no DevTools target is reachable", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
    const lockFiles = [
      path.join(tmpDir, "lockfile"),
      path.join(tmpDir, "SingletonLock"),
      path.join(tmpDir, "SingletonSocket"),
      path.join(tmpDir, "SingletonCookie"),
    ];
    try {
      for (const lock of lockFiles) {
        await fs.writeFile(lock, "x");
      }
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      await fs.writeFile(path.join(tmpDir, "chrome.pid"), `${child.pid ?? 0}\n`, "utf8");

      const logger = vi.fn();
      const probe = vi.fn(async () => ({ ok: true as const }));
      const reused = await maybeReuseRunningChromeForTest(tmpDir, logger, {
        waitForPortMs: 0,
        probe,
      });

      expect(reused).toBeNull();
      expect(probe).not.toHaveBeenCalled();
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(false);
      }
      expect(logger).toHaveBeenCalledWith(expect.stringContaining("clearing stale profile state"));
      expect(logger).toHaveBeenCalledWith("Cleaned up stale Chrome profile locks");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("serializes manual-login Chrome launch so parallel runs reuse the first browser", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-launch-lock-"));
    try {
      const config = resolveBrowserConfig({
        manualLogin: true,
        manualLoginProfileDir: tmpDir,
        profileLockTimeoutMs: 2_000,
        reuseChromeWaitMs: 0,
      });
      const launch = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          port: 45678,
          pid: process.pid,
          kill: async () => undefined,
          process: undefined,
        } as unknown as LaunchedChrome;
      });
      const maybeReuse = vi.fn(async (dir: string) => {
        try {
          const raw = await fs.readFile(path.join(dir, "DevToolsActivePort"), "utf8");
          const port = Number.parseInt(raw.split(/\r?\n/u)[0] ?? "", 10);
          if (Number.isFinite(port)) {
            return {
              port,
              pid: process.pid,
              kill: async () => undefined,
              process: undefined,
            } as unknown as LaunchedChrome;
          }
        } catch {
          // no reusable browser yet
        }
        return null;
      });

      const first = acquireManualLoginChromeForRunForTest(tmpDir, config, noopLogger, "first", {
        maybeReuse,
        launch,
      });
      const second = acquireManualLoginChromeForRunForTest(tmpDir, config, noopLogger, "second", {
        maybeReuse,
        launch,
      });

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(launch).toHaveBeenCalledTimes(1);
      const results = [firstResult, secondResult];
      expect(results.filter((result) => result.reusedChrome === null)).toHaveLength(1);
      expect(results.filter((result) => result.reusedChrome?.port === 45678)).toHaveLength(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
