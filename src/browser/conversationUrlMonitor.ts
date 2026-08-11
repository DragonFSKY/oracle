import type { BrowserLogger } from "./types.js";
import { parseChatGptConversationUrl } from "./conversationUrl.js";
import { delay } from "./utils.js";

export interface ConversationUrlMonitor {
  update: (label: string, timeoutMs?: number) => Promise<boolean>;
  schedule: (label: string, timeoutMs?: number) => Promise<boolean>;
  isInFlight: () => boolean;
  stop: () => Promise<void>;
}

export function createConversationUrlMonitor(options: {
  readUrl: () => Promise<string | null | undefined>;
  persistUrl: (url: string) => Promise<void>;
  logger: BrowserLogger;
  pollIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}): ConversationUrlMonitor {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const wait = options.wait ?? delay;
  const now = options.now ?? Date.now;
  let inFlight: Promise<boolean> | null = null;
  let stopped = false;
  const activePersists = new Set<Promise<void>>();
  let lastPersistedUrl: string | null = null;

  const update = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
    const startedAt = now();
    while (!stopped && now() - startedAt < timeoutMs) {
      try {
        const url = await options.readUrl();
        if (stopped) {
          return false;
        }
        const route = parseChatGptConversationUrl(url);
        if (route) {
          if (url !== lastPersistedUrl) {
            options.logger(`[browser] conversation url (${label}, ${route.kind}) = ${url}`);
            const persist = options.persistUrl(url as string);
            activePersists.add(persist);
            try {
              await persist;
              lastPersistedUrl = url as string;
            } finally {
              activePersists.delete(persist);
            }
          }
          // `/c/WEB:...` is only a client-side submission placeholder. Keep
          // watching until ChatGPT promotes it to the durable canonical route.
          if (route.kind === "canonical") return true;
        }
      } catch {
        // The page can navigate or disconnect between polls; keep trying until timeout.
      }
      await wait(pollIntervalMs);
    }
    return false;
  };

  const schedule = (label: string, timeoutMs?: number): Promise<boolean> => {
    if (stopped) {
      return Promise.resolve(false);
    }
    if (inFlight) {
      return inFlight;
    }
    // The /c/ URL can appear after submit. Persist it without blocking response capture.
    inFlight = update(label, timeoutMs)
      .catch(() => false)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    update,
    schedule,
    isInFlight: () => inFlight !== null,
    stop: async () => {
      stopped = true;
      await Promise.allSettled(activePersists);
    },
  };
}
