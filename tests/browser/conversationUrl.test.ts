import { describe, expect, test } from "vitest";
import {
  extractCanonicalChatGptConversationId,
  isCanonicalChatGptConversationId,
  isChatGptConversationUrl,
  parseChatGptConversationUrl,
} from "../../src/browser/conversationUrl.js";

describe("ChatGPT conversation routes", () => {
  test("separates provisional WEB routes from durable conversation ids", () => {
    const provisional = "https://chatgpt.com/c/WEB:be727ad8-1234";
    expect(parseChatGptConversationUrl(provisional)?.kind).toBe("provisional");
    expect(isChatGptConversationUrl(provisional)).toBe(true);
    expect(extractCanonicalChatGptConversationId(provisional)).toBeUndefined();
    expect(isCanonicalChatGptConversationId("WEB")).toBe(false);
  });

  test("extracts canonical ids only from strict ChatGPT HTTPS routes", () => {
    const canonical = "https://chatgpt.com/c/6a60f77c-1234-5678-9abc-def012345678";
    expect(extractCanonicalChatGptConversationId(canonical)).toBe(
      "6a60f77c-1234-5678-9abc-def012345678",
    );
    expect(extractCanonicalChatGptConversationId("https://evil.test/c/abc")).toBeUndefined();
    expect(extractCanonicalChatGptConversationId("http://chatgpt.com/c/abc")).toBeUndefined();
    expect(
      extractCanonicalChatGptConversationId("https://chatgpt.com/c/abc/extra"),
    ).toBeUndefined();
  });
});
