import type { BrowserLogger, ChromeClient } from "./types.js";

export const DEFAULT_PAGE_KEEP_ALIVE_INTERVAL_MS = 30_000;

export interface PageKeepAliveController {
  pulse: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Keep a long-running browser target out of Chrome's background frozen state.
 *
 * Focus emulation avoids foreground-tab requirements without switching the user's
 * visible tab. The lifecycle pulse lets a background ChatGPT page drain queued
 * network/UI work so the normal DOM observer and snapshot watchdog can see a
 * response that completed while the target was backgrounded.
 */
export function startPageKeepAlive(
  client: Pick<ChromeClient, "Page" | "Emulation">,
  logger: BrowserLogger,
  options: { intervalMs?: number } = {},
): PageKeepAliveController {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_PAGE_KEEP_ALIVE_INTERVAL_MS);
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let lifecycleEnabled = typeof client.Page?.setWebLifecycleState === "function";
  let focusEnabled = typeof client.Emulation?.setFocusEmulationEnabled === "function";
  let lifecycleFailureLogged = false;
  let focusFailureLogged = false;

  const logVerboseOnce = (kind: "lifecycle" | "focus", error: unknown) => {
    if (!logger.verbose) return;
    if (kind === "lifecycle" && lifecycleFailureLogged) return;
    if (kind === "focus" && focusFailureLogged) return;
    if (kind === "lifecycle") lifecycleFailureLogged = true;
    if (kind === "focus") focusFailureLogged = true;
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Background-tab ${kind} keep-alive unavailable: ${message}`);
  };

  const runPulse = async () => {
    if (lifecycleEnabled) {
      try {
        await client.Page.setWebLifecycleState({ state: "active" });
      } catch (error) {
        lifecycleEnabled = false;
        logVerboseOnce("lifecycle", error);
      }
    }
    if (focusEnabled) {
      try {
        await client.Emulation.setFocusEmulationEnabled({ enabled: true });
      } catch (error) {
        focusEnabled = false;
        logVerboseOnce("focus", error);
      }
    }
  };

  const pulse = async () => {
    if (stopped) return;
    if (!inFlight) {
      inFlight = runPulse().finally(() => {
        inFlight = null;
      });
    }
    await inFlight;
  };

  if (logger.verbose) {
    logger(
      `[browser] Background-tab keep-alive enabled (${Math.round(intervalMs / 1000)}s lifecycle pulse).`,
    );
  }
  void pulse();
  const timer = setInterval(() => {
    void pulse();
  }, intervalMs);
  timer.unref?.();

  return {
    pulse,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inFlight?.catch(() => undefined);
    },
  };
}
