import { describe, expect, test } from "vitest";
import { mergeBrowserRuntimeEvidence } from "../../src/browser/runtimeEvidence.js";

describe("browser runtime route evidence", () => {
  test("records provisional to canonical promotion and never persists WEB as an id", () => {
    const provisional = mergeBrowserRuntimeEvidence(
      undefined,
      {
        tabUrl: "https://chatgpt.com/c/WEB:request-1",
        conversationId: "WEB",
      },
      "2026-07-23T01:00:00.000Z",
    );
    expect(provisional).toMatchObject({
      routePhase: "provisional",
      provisionalTabUrl: "https://chatgpt.com/c/WEB:request-1",
      routeObservedAt: "2026-07-23T01:00:00.000Z",
    });
    expect(provisional.conversationId).toBeUndefined();

    const canonical = mergeBrowserRuntimeEvidence(
      provisional,
      { tabUrl: "https://chatgpt.com/c/6a60f77c-1234" },
      "2026-07-23T01:00:01.000Z",
    );
    expect(canonical).toMatchObject({
      routePhase: "canonical",
      provisionalTabUrl: "https://chatgpt.com/c/WEB:request-1",
      canonicalTabUrl: "https://chatgpt.com/c/6a60f77c-1234",
      conversationId: "6a60f77c-1234",
      routeObservedAt: "2026-07-23T01:00:01.000Z",
    });
  });

  test("retains canonical evidence after later navigation away", () => {
    const previous = mergeBrowserRuntimeEvidence(undefined, {
      tabUrl: "https://chatgpt.com/c/durable-id",
    });
    const navigated = mergeBrowserRuntimeEvidence(previous, {
      tabUrl: "https://chatgpt.com/",
    });

    expect(navigated.routePhase).toBe("none");
    expect(navigated.canonicalTabUrl).toBe("https://chatgpt.com/c/durable-id");
    expect(navigated.conversationId).toBeUndefined();
  });
});
