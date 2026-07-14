import { describe, expect, test } from "vitest";
import { resolveAdspowerConfigForRun } from "../../src/cli/adspowerOverride.js";

describe("resolveAdspowerConfigForRun", () => {
  const trusted = {
    profiles: ["profile-a", "profile-b"],
    strategy: "round-robin" as const,
    apiBase: "http://127.0.0.1:50325",
    apiKeyEnv: "ADSPOWER_API_KEY",
    apiRequestIntervalMs: 500,
    apiVersion: "auto" as const,
    timeoutMs: 12_000,
    cdpMask: true,
    lastOpenedTabs: false,
    proxyDetection: false,
  };

  test("keeps the trusted pool when no per-run profile is requested", () => {
    expect(resolveAdspowerConfigForRun(trusted)).toBe(trusted);
  });

  test("restricts a run to one case-insensitive member of the trusted pool", () => {
    expect(resolveAdspowerConfigForRun(trusted, " PROFILE-B ")).toEqual({
      profiles: ["PROFILE-B"],
      strategy: "round-robin",
      apiBase: trusted.apiBase,
      apiKeyEnv: "ADSPOWER_API_KEY",
      apiRequestIntervalMs: 500,
      apiVersion: "auto",
      timeoutMs: trusted.timeoutMs,
      cdpMask: true,
      lastOpenedTabs: false,
      proxyDetection: false,
    });
  });

  test("rejects missing or out-of-pool profile configuration", () => {
    expect(() => resolveAdspowerConfigForRun(undefined, "profile-a")).toThrow(
      /requires browser\.adspower/,
    );
    expect(() => resolveAdspowerConfigForRun(trusted, "profile-c")).toThrow(
      /outside the trusted user-config pool/,
    );
  });
});
