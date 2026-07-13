import type { BrowserLogger, ChromeClient } from "./types.js";
import { BrowserAutomationError } from "../oracle/errors.js";

const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

export function extractChatGptProjectScope(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !CHATGPT_HOSTS.has(url.hostname) || url.port) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 3 || segments[0] !== "g") {
      return null;
    }
    if (segments[2] !== "project" && segments[2] !== "c") {
      return null;
    }
    return `/g/${segments[1]}`;
  } catch {
    return null;
  }
}

export function assertChatGptProjectBinding(expectedUrl: string, actualUrl: string): void {
  const expectedScope = extractChatGptProjectScope(expectedUrl);
  if (!expectedScope) {
    throw new BrowserAutomationError(
      "--browser-require-project requires a ChatGPT Project URL ending in /project.",
      { stage: "execute-browser" },
    );
  }
  const actualScope = extractChatGptProjectScope(actualUrl);
  if (actualScope !== expectedScope) {
    throw new BrowserAutomationError(
      "ChatGPT did not remain in the required Project. Refusing to upload attachments or submit the prompt.",
      {
        stage: "execute-browser",
        details: {
          expectedProjectConfigured: true,
          actualProjectDetected: actualScope !== null,
        },
      },
    );
  }
}

export async function ensureChatGptProjectBinding(
  Runtime: ChromeClient["Runtime"],
  expectedUrl: string,
  logger: BrowserLogger,
): Promise<void> {
  const { result } = await Runtime.evaluate({
    expression: "location.href",
    returnByValue: true,
  });
  const actualUrl = typeof result?.value === "string" ? result.value : "";
  assertChatGptProjectBinding(expectedUrl, actualUrl);
  logger("[browser] Required ChatGPT Project binding verified.");
}
