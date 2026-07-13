import { describe, expect, test, vi } from "vitest";
import {
  assertChatGptProjectBinding,
  ensureChatGptProjectBinding,
  extractChatGptProjectScope,
} from "../../src/browser/projectBinding.js";

describe("ChatGPT Project binding", () => {
  test("extracts the same scope from project shells and project conversations", () => {
    expect(extractChatGptProjectScope("https://chatgpt.com/g/g-p-alpha/project")).toBe(
      "/g/g-p-alpha",
    );
    expect(extractChatGptProjectScope("https://chatgpt.com/g/g-p-alpha/c/conversation")).toBe(
      "/g/g-p-alpha",
    );
    expect(extractChatGptProjectScope("https://chatgpt.com/")).toBeNull();
    expect(extractChatGptProjectScope("https://example.com/g/g-p-alpha/project")).toBeNull();
  });

  test("accepts only the configured project scope", () => {
    expect(() =>
      assertChatGptProjectBinding(
        "https://chatgpt.com/g/g-p-alpha/project",
        "https://chatgpt.com/g/g-p-alpha/c/conversation",
      ),
    ).not.toThrow();
    expect(() =>
      assertChatGptProjectBinding(
        "https://chatgpt.com/g/g-p-alpha/project",
        "https://chatgpt.com/g/g-p-beta/project",
      ),
    ).toThrow(/did not remain in the required Project/);
    expect(() =>
      assertChatGptProjectBinding("https://chatgpt.com/", "https://chatgpt.com/"),
    ).toThrow(/requires a ChatGPT Project URL/);
  });

  test("verifies the live page before browser submission proceeds", async () => {
    const logger = Object.assign(vi.fn(), { verbose: false });
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: "https://chatgpt.com/g/g-p-alpha/project" },
      }),
    };

    await ensureChatGptProjectBinding(
      Runtime as never,
      "https://chatgpt.com/g/g-p-alpha/project",
      logger,
    );

    expect(logger).toHaveBeenCalledWith("[browser] Required ChatGPT Project binding verified.");
  });
});
