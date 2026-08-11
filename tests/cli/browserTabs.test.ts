import { describe, expect, test } from "vitest";
import { resolveSessionTabRefsForTest } from "../../src/cli/browserTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

describe("browser tab CLI helpers", () => {
  test("tries the owned target before stored URLs and keeps provisional URLs last", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeTargetId: "stale-target",
          tabUrl: "https://chatgpt.com/c/WEB:request-id",
          conversationId: "runtime-conversation",
        },
      },
    } as SessionMetadata;

    expect(resolveSessionTabRefsForTest(meta)).toEqual([
      "stale-target",
      "runtime-conversation",
      "https://chatgpt.com/c/WEB:request-id",
    ]);
  });
});
