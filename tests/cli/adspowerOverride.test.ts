import { describe, expect, test } from "vitest";
import { resolveAdspowerConfigForRun } from "../../src/cli/adspowerOverride.js";

describe("resolveAdspowerConfigForRun", () => {
  const trusted = {
    profiles: ["profile-a", "profile-b"],
    strategy: "round-robin" as const,
    apiBase: "http://127.0.0.1:50325",
    timeoutMs: 12_000,
    cdpMask: true,
  };

  test("keeps the trusted pool when no per-run profile is requested", () => {
    expect(resolveAdspowerConfigForRun(trusted)).toBe(trusted);
  });

  test("restricts a run to one case-insensitive member of the trusted pool", () => {
    expect(resolveAdspowerConfigForRun(trusted, " PROFILE-B ")).toEqual({
      profiles: ["PROFILE-B"],
      strategy: "round-robin",
      apiBase: trusted.apiBase,
      timeoutMs: trusted.timeoutMs,
      cdpMask: true,
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
