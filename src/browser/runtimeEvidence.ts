import type { BrowserRuntimeMetadata } from "../sessionManager.js";
import {
  extractCanonicalChatGptConversationId,
  isCanonicalChatGptConversationId,
  parseChatGptConversationUrl,
} from "./conversationUrl.js";

/**
 * Normalize runtime identity and retain the route transition evidence needed
 * to diagnose browser sessions without replaying or resubmitting them.
 */
export function mergeBrowserRuntimeEvidence(
  previous: BrowserRuntimeMetadata | null | undefined,
  next: BrowserRuntimeMetadata,
  observedAt = new Date().toISOString(),
): BrowserRuntimeMetadata {
  const route = parseChatGptConversationUrl(next.tabUrl);
  const routePhase = route?.kind ?? "none";
  const canonicalConversationId =
    extractCanonicalChatGptConversationId(next.tabUrl) ??
    (isCanonicalChatGptConversationId(next.conversationId) ? next.conversationId : undefined);
  const provisionalTabUrl =
    route?.kind === "provisional" ? next.tabUrl : previous?.provisionalTabUrl;
  const canonicalTabUrl = route?.kind === "canonical" ? next.tabUrl : previous?.canonicalTabUrl;
  const routeChanged =
    previous?.routePhase !== routePhase ||
    (route?.kind === "provisional" && previous.provisionalTabUrl !== next.tabUrl) ||
    (route?.kind === "canonical" && previous.canonicalTabUrl !== next.tabUrl);

  return {
    ...next,
    conversationId: canonicalConversationId,
    routePhase,
    provisionalTabUrl,
    canonicalTabUrl,
    routeObservedAt: routeChanged ? observedAt : (previous?.routeObservedAt ?? observedAt),
  };
}
