import { describe, expect, test } from "vitest";
import type { UserConfig } from "../../src/config.js";
import {
  applyBrowserRouteToOptions,
  assertBrowserFollowupRouteCompatibility,
  resolveBrowserRouteForRun,
  type BrowserRouteFlagOptions,
} from "../../src/cli/browserRoute.js";

const config: UserConfig = {
  browser: {
    route: "project-a",
    defaultRoute: "fallback",
    adspower: {
      profiles: ["profile-a", "profile-b"],
      strategy: "round-robin",
      apiBase: "http://127.0.0.1:50325",
    },
    routes: {
      "project-a": {
        adspowerProfile: "profile-a",
        chatgptUrl: "https://chatgpt.com/g/g-p-alpha/project",
      },
      "project-b": {
        adspowerProfile: "profile-b",
        chatgptUrl: "https://chatgpt.com/g/g-p-beta/project",
      },
      fallback: {
        adspowerProfile: "profile-b",
        chatgptUrl: "https://chatgpt.com/g/g-p-fallback/project",
      },
    },
  },
};

describe("browser routes", () => {
  test("resolves a project-selected route as an atomic trusted binding", () => {
    const route = resolveBrowserRouteForRun({}, config);

    expect(route).toEqual({
      name: "project-a",
      chatgptUrl: "https://chatgpt.com/g/g-p-alpha/project",
      adspower: {
        profiles: ["profile-a"],
        strategy: "round-robin",
        apiBase: "http://127.0.0.1:50325",
        timeoutMs: undefined,
      },
    });

    const options: BrowserRouteFlagOptions = {};
    applyBrowserRouteToOptions(options, route!);
    expect(options).toEqual({
      chatgptUrl: "https://chatgpt.com/g/g-p-alpha/project",
      browserUrl: undefined,
      browserRequireProject: true,
    });
  });

  test("lets an explicit route override the project and default routes", () => {
    const route = resolveBrowserRouteForRun({ browserRoute: "project-b" }, config, (key) =>
      key === "browserRoute" ? "cli" : "default",
    );
    expect(route?.name).toBe("project-b");
    expect(route?.adspower.profiles).toEqual(["profile-b"]);
  });

  test("uses the trusted default when no project route is selected", () => {
    const route = resolveBrowserRouteForRun(
      {},
      { browser: { ...config.browser, route: undefined } },
    );
    expect(route?.name).toBe("fallback");
  });

  test("preserves the legacy path when no route is configured", () => {
    expect(resolveBrowserRouteForRun({}, { browser: { adspower: config.browser?.adspower } })).toBe(
      null,
    );
  });

  test("rejects split profile or URL overrides beside a route", () => {
    for (const key of ["chatgptUrl", "browserUrl", "browserAdspowerProfile"] as const) {
      const options: BrowserRouteFlagOptions = { browserRoute: "project-a", [key]: "override" };
      expect(() =>
        resolveBrowserRouteForRun(options, config, (candidate) =>
          candidate === key || candidate === "browserRoute" ? "cli" : "default",
        ),
      ).toThrow(/atomic profile\/Project binding/);
    }
  });

  test("fails closed for invalid names, URLs, and profiles without leaking the profile", () => {
    expect(() => resolveBrowserRouteForRun({ browserRoute: "../bad" }, config)).toThrow(
      /Browser route name/,
    );
    expect(() =>
      resolveBrowserRouteForRun(
        { browserRoute: "bad-url" },
        {
          browser: {
            ...config.browser,
            routes: {
              "bad-url": {
                adspowerProfile: "profile-a",
                chatgptUrl: "https://chatgpt.com/c/not-a-project",
              },
            },
          },
        },
      ),
    ).toThrow(/exact HTTPS ChatGPT Project URL/);

    const secretProfile = "outside-secret-profile";
    let message = "";
    try {
      resolveBrowserRouteForRun(
        { browserRoute: "bad-profile" },
        {
          browser: {
            ...config.browser,
            routes: {
              "bad-profile": {
                adspowerProfile: secretProfile,
                chatgptUrl: "https://chatgpt.com/g/g-p-safe/project",
              },
            },
          },
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/trusted AdsPower pool/);
    expect(message).not.toContain(secretProfile);
  });

  test("pins browser follow-ups to their stored route", () => {
    expect(() =>
      assertBrowserFollowupRouteCompatibility({
        storedRouteName: "project-a",
        requestedRouteName: "project-a",
      }),
    ).not.toThrow();
    expect(() =>
      assertBrowserFollowupRouteCompatibility({
        storedRouteName: "project-a",
        requestedRouteName: "project-b",
      }),
    ).toThrow(/cannot switch/);
    expect(() =>
      assertBrowserFollowupRouteCompatibility({
        storedRouteName: "project-a",
        hasExplicitRawBinding: true,
      }),
    ).toThrow(/raw profile or URL overrides/);
    expect(() =>
      assertBrowserFollowupRouteCompatibility({ requestedRouteName: "project-a" }),
    ).toThrow(/predates route pinning/);
  });
});
