import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import {
  isCanonicalChatGptConversationId,
  parseChatGptConversationUrl,
} from "./conversationUrl.js";

/**
 * True when the URL points at a specific ChatGPT conversation (`/c/<id>`) on
 * chatgpt.com or chat.openai.com. Rejects home, project shell, and external
 * URLs — anything else would be unsafe to auto-reopen in a persistent
 * signed-in browser profile.
 */
export function isRecoverableChatGptConversationUrl(candidate: string | null | undefined): boolean {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return false;
  }
  return parseChatGptConversationUrl(trimmed)?.kind === "canonical";
}

export function hasRecoverableChatGptConversation(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  if (!runtime) {
    return false;
  }
  if (isCanonicalChatGptConversationId(runtime.conversationId?.trim())) {
    return true;
  }
  return isRecoverableChatGptConversationUrl(runtime.tabUrl);
}
