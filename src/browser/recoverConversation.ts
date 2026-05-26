import { launch, type LaunchedChrome } from "chrome-launcher";
import type { SessionMetadata } from "../sessionStore.js";
import type { BrowserLogger } from "./types.js";
import { defaultManualLoginProfileDir } from "./manualLoginProfile.js";

const DEFAULT_HYDRATION_DELAY_MS = 3_000;

export interface RecoveredConversation {
  host: string;
  port: number;
  url: string;
  chrome: LaunchedChrome;
}

function resolveRecoveryUrl(meta: SessionMetadata): string | null {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  const candidates = [runtime.tabUrl, harvest.url];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("http")) {
      return candidate;
    }
  }
  return null;
}

function resolveProfileDir(meta: SessionMetadata): string {
  const fromMeta = meta?.browser?.config?.manualLoginProfileDir;
  if (typeof fromMeta === "string" && fromMeta.length > 0) {
    return fromMeta;
  }
  return defaultManualLoginProfileDir();
}

/**
 * Re-open a previously-harvested ChatGPT conversation by relaunching Chrome
 * with the session's persistent profile and navigating to the saved tab URL.
 *
 * Used as a fallback when `harvestChatGptTab` can find no live tab matching the
 * stored target (common after the original CLI run exits and closes its
 * browser). ChatGPT preserves attachments + history at the conversation URL,
 * so harvesting against the relaunched tab returns the original message + any
 * assistant response that completed after the original run gave up.
 */
export async function recoverConversationTab(
  meta: SessionMetadata,
  logger: BrowserLogger,
  options: { hydrationDelayMs?: number } = {},
): Promise<RecoveredConversation> {
  const url = resolveRecoveryUrl(meta);
  if (!url) {
    throw new Error(
      "Cannot recover conversation: no saved tab URL in session metadata (browser.runtime.tabUrl).",
    );
  }
  const userDataDir = resolveProfileDir(meta);

  logger(
    `[browser] Recovery: relaunching Chrome with profile ${userDataDir} and navigating to ${url}`,
  );

  const chrome = await launch({
    chromeFlags: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=AutomationControlled,TranslateUI",
      "--disable-sync",
      "--password-store=basic",
      "--use-mock-keychain",
      "--lang=en-US",
      url,
    ],
    userDataDir,
    handleSIGINT: false,
  });

  const host = "127.0.0.1";
  const port = chrome.port;

  const hydrationDelayMs = options.hydrationDelayMs ?? DEFAULT_HYDRATION_DELAY_MS;
  if (hydrationDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, hydrationDelayMs));
  }

  logger(`[browser] Recovery: Chrome listening on ${host}:${port}; tab loaded.`);

  return { host, port, url, chrome };
}
