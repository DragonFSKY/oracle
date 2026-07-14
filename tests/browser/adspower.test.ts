import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
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
    vi.stubEnv("XDG_CONFIG_HOME", homeDir);
    vi.stubEnv("ADSPOWER_API_REQUEST_INTERVAL_MS", "0");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setOracleHomeDirOverrideForTest(null);
    await rm(homeDir, { recursive: true, force: true });
  });

  test("matches profile pool entries by stable user_id", async () => {
    fetchMock.mockImplementation(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/v2/browser-profile/list")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          data: {
            list: [
              { profile_id: "profile-cn", name: "chatgpt pro（中国代理入口）" },
              { profile_id: "profile-us", name: "chatgpt pro（美国代理入口）" },
            ],
          },
        });
      }
      if (href.includes("/api/v2/browser-profile/active?profile_id=profile-cn")) {
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

  test.each([
    { configured: undefined, expected: "1", label: "defaults to enabled" },
    { configured: true, expected: "1", label: "can be explicitly enabled" },
    { configured: false, expected: "0", label: "can be explicitly disabled" },
  ])("$label CDP masking when starting a profile", async ({ configured, expected }) => {
    fetchMock.mockImplementation(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/v2/browser-profile/active?profile_id=profile-cn")) {
        return jsonResponse({ data: { status: "Inactive" } });
      }
      if (href.includes("/api/v2/browser-profile/start")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          cdp_mask: expected,
          headless: "0",
          last_opened_tabs: "0",
          profile_id: "profile-cn",
          proxy_detection: "0",
        });
        return jsonResponse({
          data: {
            debug_port: "63333",
            ws: { puppeteer: "ws://127.0.0.1:63333/devtools/browser/profile-cn" },
          },
        });
      }
      throw new Error(`Unexpected AdsPower request: ${href}`);
    });

    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");
    const config = {
      userId: "profile-cn",
      profileName: "chatgpt pro",
      ...(configured === undefined ? {} : { cdpMask: configured }),
    };

    await expect(resolveAdspowerBrowser(config)).resolves.toMatchObject({
      userId: "profile-cn",
      debugPort: 63333,
    });
  });

  test("round-robins from the first configured profile and only marks reused sessions pinned", async () => {
    fetchMock.mockImplementation(async (url: URL | string) => {
      const href = String(url);
      if (href.includes("/api/v2/browser-profile/list")) {
        return jsonResponse({
          data: {
            list: [
              { profile_id: "profile-cn-a", name: "chatgpt pro（中国代理入口）" },
              { profile_id: "profile-cn-b", name: "chatgpt pro龙姐（中国代理入口）" },
            ],
          },
        });
      }
      if (href.includes("/api/v2/browser-profile/active?profile_id=profile-cn-a")) {
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
        data: { list: [{ profile_id: "profile-cn", name: "chatgpt pro（中国代理入口）" }] },
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
      if (href.includes("/api/v2/browser-profile/list")) {
        return jsonResponse({
          data: {
            list: [
              { profile_id: "profile-cn", name: "chatgpt pro（中国代理入口）" },
              { profile_id: "profile-team", name: "TEAM-co" },
            ],
          },
        });
      }
      if (href.includes("/api/v2/browser-profile/active?profile_id=profile-cn")) {
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

  test("discovers AdsPower's Local API endpoint from the official local_api file", async () => {
    const localApiFile = path.join(homeDir, "adspower_global", "cwd_global", "source", "local_api");
    await mkdir(path.dirname(localApiFile), { recursive: true });
    await writeFile(localApiFile, "http://local.adspower.test:61000/\n");

    fetchMock.mockImplementation(async (url: URL | string) => {
      expect(String(url)).toBe(
        "http://local.adspower.test:61000/api/v2/browser-profile/active?profile_id=profile-cn",
      );
      return jsonResponse({
        data: {
          status: "Active",
          debug_port: "63333",
          ws: { puppeteer: "ws://127.0.0.1:63333/devtools/browser/profile-cn" },
        },
      });
    });

    const logger = vi.fn();
    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");
    await resolveAdspowerBrowser({ userId: "profile-cn" }, logger);

    expect(logger).toHaveBeenCalledWith(
      "[adspower] Discovered the Local API endpoint from AdsPower's local_api file.",
    );
  });

  test("reads bearer authentication from a named environment variable", async () => {
    vi.stubEnv("ORACLE_ADSPOWER_TOKEN", "secret-token");
    fetchMock.mockImplementation(async (_url: URL | string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-token" });
      return jsonResponse({
        data: {
          status: "Active",
          debug_port: "63333",
          ws: { puppeteer: "ws://127.0.0.1:63333/devtools/browser/profile-cn" },
        },
      });
    });

    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");
    await resolveAdspowerBrowser({ userId: "profile-cn", apiKeyEnv: "ORACLE_ADSPOWER_TOKEN" });
  });

  test("falls back to optimized V1 startup when V2 is unavailable", async () => {
    fetchMock.mockImplementation(async (url: URL | string) => {
      const href = String(url);
      if (href.includes("/api/v2/browser-profile/active")) {
        return jsonResponse({}, { ok: false, status: 404 });
      }
      if (href.includes("/api/v1/browser/active?user_id=profile-cn")) {
        return jsonResponse({ data: { status: "Inactive" } });
      }
      if (href.includes("/api/v1/browser/start?")) {
        const parsed = new URL(href);
        expect(parsed.searchParams.get("open_tabs")).toBe("1");
        expect(parsed.searchParams.get("ip_tab")).toBe("0");
        expect(parsed.searchParams.get("cdp_mask")).toBe("1");
        return jsonResponse({
          data: {
            debug_port: "63333",
            ws: { puppeteer: "ws://127.0.0.1:63333/devtools/browser/profile-cn" },
          },
        });
      }
      throw new Error(`Unexpected AdsPower request: ${href}`);
    });

    const logger = vi.fn();
    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");
    await resolveAdspowerBrowser({ userId: "profile-cn" }, logger);

    expect(logger).toHaveBeenCalledWith(
      "[adspower] Local API V2 does not support browser status; falling back to V1.",
    );
  });

  test("honors explicit V2 tab-restoration and proxy-detection settings", async () => {
    fetchMock.mockImplementation(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/v2/browser-profile/active")) {
        return jsonResponse({ data: { status: "Inactive" } });
      }
      if (href.includes("/api/v2/browser-profile/start")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          last_opened_tabs: "1",
          proxy_detection: "1",
        });
        return jsonResponse({
          data: {
            debug_port: "63333",
            ws: { puppeteer: "ws://127.0.0.1:63333/devtools/browser/profile-cn" },
          },
        });
      }
      throw new Error(`Unexpected AdsPower request: ${href}`);
    });

    const logger = vi.fn();
    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");
    await resolveAdspowerBrowser(
      { userId: "profile-cn", lastOpenedTabs: true, proxyDetection: true },
      logger,
    );
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("with restored tabs"));
  });

  test("paces Local API calls across one profile-pool resolution", async () => {
    const requestTimes: number[] = [];
    fetchMock.mockImplementation(async (url: URL | string) => {
      requestTimes.push(Date.now());
      const href = String(url);
      if (href.includes("/api/v2/browser-profile/list")) {
        return jsonResponse({
          data: { list: [{ profile_id: "profile-cn", name: "chatgpt pro" }] },
        });
      }
      if (href.includes("/api/v2/browser-profile/active")) {
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
    await resolveAdspowerBrowser(
      { profiles: ["profile-cn"], apiRequestIntervalMs: 20 },
      undefined,
      "paced-session",
    );

    expect(requestTimes).toHaveLength(2);
    expect(requestTimes[1] - requestTimes[0]).toBeGreaterThanOrEqual(15);
  });

  test("does not hide V2 business errors behind a V1 fallback", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: -1, msg: "profile not found" }));

    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");
    await expect(resolveAdspowerBrowser({ userId: "missing" })).rejects.toThrow(
      "AdsPower API failed: profile not found",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("rejects unsupported configured API versions", async () => {
    const { resolveAdspowerBrowser } = await import("../../src/browser/adspower.js");
    await expect(
      resolveAdspowerBrowser({ userId: "profile-cn", apiVersion: "v3" as never }),
    ).rejects.toThrow('Invalid AdsPower API version "v3"');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
