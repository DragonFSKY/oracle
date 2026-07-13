import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe("resolveAdspowerBrowser", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-adspower-"));
    setOracleHomeDirOverrideForTest(homeDir);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setOracleHomeDirOverrideForTest(null);
    await rm(homeDir, { recursive: true, force: true });
  });

  test("matches profile pool entries by stable user_id", async () => {
    fetchMock.mockImplementation(async (url: URL | string) => {
      const href = String(url);
      if (href.includes("/api/v1/user/list")) {
        return jsonResponse({
          data: {
            list: [
              { user_id: "profile-cn", name: "chatgpt pro（中国代理入口）" },
              { user_id: "profile-us", name: "chatgpt pro（美国代理入口）" },
            ],
          },
        });
      }
      if (href.includes("/api/v1/browser/active?user_id=profile-cn")) {
        return jsonResponse({
          data: {
            status: "Active",
            debug_port: "63333",
            ws: { puppeteer: "ws://127.0.0.1:63333/devtools/browser/profile-cn" },
          },
        });
      }
      throw new Error(`Unexpected AdsPower request: ${href}`);
    });

    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");

    const resolved = await resolveAdspowerBrowser(
      { profiles: ["profile-cn"], strategy: "round-robin" },
      undefined,
      "session-cn",
    );

    expect(resolved).toMatchObject({
      userId: "profile-cn",
      profileName: "chatgpt pro（中国代理入口）",
      debugPort: 63333,
      browserWSEndpoint: "ws://127.0.0.1:63333/devtools/browser/profile-cn",
      pinned: false,
    });
    expect(path.dirname(resolved.tabLeaseDir)).toBe(path.join(homeDir, "adspower-tab-leases"));
    expect(path.basename(resolved.tabLeaseDir)).toMatch(/^[a-f0-9]{24}$/);
    expect(resolved.tabLeaseDir).not.toContain("profile-cn");
  });

  test("defaults to one concurrent tab per AdsPower profile and honors explicit limits", async () => {
    const { resolveAdspowerConcurrentTabLimit } = await import("../../src/browser/adspower.js");

    expect(resolveAdspowerConcurrentTabLimit()).toBe(1);
    expect(resolveAdspowerConcurrentTabLimit(2)).toBe(2);
  });

  test("round-robins from the first configured profile and only marks reused sessions pinned", async () => {
    fetchMock.mockImplementation(async (url: URL | string) => {
      const href = String(url);
      if (href.includes("/api/v1/user/list")) {
        return jsonResponse({
          data: {
            list: [
              { user_id: "profile-cn-a", name: "chatgpt pro（中国代理入口）" },
              { user_id: "profile-cn-b", name: "chatgpt pro龙姐（中国代理入口）" },
            ],
          },
        });
      }
      if (href.includes("/api/v1/browser/active?user_id=profile-cn-a")) {
        return jsonResponse({
          data: {
            status: "Active",
            debug_port: "63333",
            ws: { puppeteer: "ws://127.0.0.1:63333/devtools/browser/profile-cn-a" },
          },
        });
      }
      throw new Error(`Unexpected AdsPower request: ${href}`);
    });

    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");
    const config = {
      profiles: ["profile-cn-a", "profile-cn-b"],
      strategy: "round-robin" as const,
    };

    const first = await resolveAdspowerBrowser(config, undefined, "session-cn");
    const second = await resolveAdspowerBrowser(config, undefined, "session-cn");

    expect(first).toMatchObject({
      userId: "profile-cn-a",
      profileName: "chatgpt pro（中国代理入口）",
      pinned: false,
    });
    expect(second).toMatchObject({
      userId: "profile-cn-a",
      profileName: "chatgpt pro（中国代理入口）",
      pinned: true,
    });
  });

  test("reports available profile names with user_ids when a pool entry does not match", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          list: [{ user_id: "profile-cn", name: "chatgpt pro（中国代理入口）" }],
        },
      }),
    );

    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");

    await expect(
      resolveAdspowerBrowser({ profiles: ["missing-profile"] }, undefined, "session-missing"),
    ).rejects.toThrow(
      /No AdsPower profiles matched names\/user_ids.*chatgpt pro（中国代理入口） \(profile-cn\)/,
    );
  });

  test("ignores a pinned profile outside the configured pool", async () => {
    await writeFile(
      path.join(homeDir, "adspower-session-pins.json"),
      JSON.stringify({
        "session-cn": {
          profileName: "TEAM-co",
          userId: "profile-team",
          at: new Date().toISOString(),
        },
      }),
    );

    fetchMock.mockImplementation(async (url: URL | string) => {
      const href = String(url);
      if (href.includes("/api/v1/user/list")) {
        return jsonResponse({
          data: {
            list: [
              { user_id: "profile-cn", name: "chatgpt pro（中国代理入口）" },
              { user_id: "profile-team", name: "TEAM-co" },
            ],
          },
        });
      }
      if (href.includes("/api/v1/browser/active?user_id=profile-cn")) {
        return jsonResponse({
          data: {
            status: "Active",
            debug_port: "63333",
            ws: { puppeteer: "ws://127.0.0.1:63333/devtools/browser/profile-cn" },
          },
        });
      }
      throw new Error(`Unexpected AdsPower request: ${href}`);
    });

    const logger = vi.fn();
    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");

    const resolved = await resolveAdspowerBrowser(
      { profiles: ["profile-cn"], strategy: "round-robin" },
      logger,
      "session-cn",
    );

    expect(resolved.userId).toBe("profile-cn");
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring pinned profile "TEAM-co" (profile-team)'),
    );
  });
});
