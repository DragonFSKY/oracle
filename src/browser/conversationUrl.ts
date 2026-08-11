const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const CANONICAL_CONVERSATION_ID = /^[a-zA-Z0-9-]+$/;
const PROVISIONAL_CONVERSATION_PREFIX = "WEB:";

export type ChatGptConversationRoute =
  | { kind: "canonical"; url: URL; segment: string; conversationId: string }
  | { kind: "provisional"; url: URL; segment: string };

/**
 * Parse ChatGPT conversation routes without mistaking the client-side
 * `/c/WEB:<request-id>` placeholder for a durable conversation id.
 */
export function parseChatGptConversationUrl(
  value: string | null | undefined,
): ChatGptConversationRoute | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port) return null;
    if (!CHATGPT_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/(?:^|\/)c\/([^/]+)\/?$/);
    if (!match) return null;
    const segment = decodeURIComponent(match[1] ?? "");
    if (
      segment.toUpperCase() === "WEB" ||
      segment.toUpperCase().startsWith(PROVISIONAL_CONVERSATION_PREFIX)
    ) {
      return { kind: "provisional", url, segment };
    }
    if (!CANONICAL_CONVERSATION_ID.test(segment)) return null;
    return { kind: "canonical", url, segment, conversationId: segment };
  } catch {
    return null;
  }
}

export function isChatGptConversationUrl(value: string | null | undefined): boolean {
  return parseChatGptConversationUrl(value) !== null;
}

export function extractCanonicalChatGptConversationId(
  value: string | null | undefined,
): string | undefined {
  const route = parseChatGptConversationUrl(value);
  return route?.kind === "canonical" ? route.conversationId : undefined;
}

export function isCanonicalChatGptConversationId(value: string | null | undefined): boolean {
  return Boolean(
    value &&
    CANONICAL_CONVERSATION_ID.test(value) &&
    value.toUpperCase() !== "WEB" &&
    !value.toUpperCase().startsWith(PROVISIONAL_CONVERSATION_PREFIX),
  );
}

/** Shared source for browser-injected route readers. */
export function buildCanonicalConversationIdReaderJs(
  functionName = "conversationIdFromUrl",
): string {
  return `const ${functionName} = (value) => {
    try {
      const parsed = new URL(String(value ?? ''), location.origin);
      if (!['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname.toLowerCase())) return null;
      const match = parsed.pathname.match(/(?:^|\\/)c\\/([^/]+)\\/?$/);
      if (!match) return null;
      const segment = decodeURIComponent(match[1] || '');
      if (segment.toUpperCase() === 'WEB' || segment.toUpperCase().startsWith('WEB:')) return null;
      return /^[a-zA-Z0-9-]+$/.test(segment) ? segment : null;
    } catch {
      return null;
    }
  };`;
}
