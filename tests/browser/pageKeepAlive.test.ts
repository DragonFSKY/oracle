import { afterEach, describe, expect, test, vi } from "vitest";
import { startPageKeepAlive } from "../../src/browser/pageKeepAlive.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

function createClient(options: { lifecycleError?: Error; focusError?: Error } = {}) {
  return {
    Page: {
      setWebLifecycleState: vi.fn(async () => {
        if (options.lifecycleError) throw options.lifecycleError;
      }),
    },
    Emulation: {
      setFocusEmulationEnabled: vi.fn(async () => {
        if (options.focusError) throw options.focusError;
      }),
    },
  } as unknown as Pick<ChromeClient, "Page" | "Emulation">;
}

function createLogger(verbose = false) {
  const logger = vi.fn() as unknown as BrowserLogger;
  logger.verbose = verbose;
  return logger;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("background page keep-alive", () => {
  test("periodically keeps a remote page active without bringing it to the foreground", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const logger = createLogger(true);
    const controller = startPageKeepAlive(client, logger, { intervalMs: 1_000 });

    await controller.pulse();
    expect(client.Page.setWebLifecycleState).toHaveBeenCalledWith({ state: "active" });
    expect(client.Emulation.setFocusEmulationEnabled).toHaveBeenCalledWith({ enabled: true });
    expect((client.Page as unknown as { bringToFront?: unknown }).bringToFront).toBeUndefined();

    const initialCalls = vi.mocked(client.Page.setWebLifecycleState).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.Page.setWebLifecycleState).toHaveBeenCalledTimes(initialCalls + 1);

    await controller.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.Page.setWebLifecycleState).toHaveBeenCalledTimes(initialCalls + 1);
  });

  test("soft-disables unsupported lifecycle APIs while preserving focus pulses", async () => {
    vi.useFakeTimers();
    const client = createClient({ lifecycleError: new Error("method not found") });
    const logger = createLogger(true);
    const controller = startPageKeepAlive(client, logger, { intervalMs: 1_000 });

    await controller.pulse();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(client.Page.setWebLifecycleState).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.Emulation.setFocusEmulationEnabled).mock.calls.length).toBeGreaterThan(
      1,
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Background-tab lifecycle keep-alive unavailable"),
    );

    await controller.stop();
  });
});
