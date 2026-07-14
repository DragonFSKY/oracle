import type { AdspowerConfig } from "../browser/adspower.js";

export function resolveAdspowerConfigForRun(
  trustedConfig: AdspowerConfig | null | undefined,
  requestedProfile?: string | null,
): AdspowerConfig | undefined {
  const requested = requestedProfile?.trim();
  if (!requested) {
    return trustedConfig ?? undefined;
  }
  if (!trustedConfig) {
    throw new Error(
      "--browser-adspower-profile requires browser.adspower in the trusted user config.",
    );
  }

  const allowedProfiles = [
    ...(trustedConfig.profiles ?? []),
    trustedConfig.userId,
    trustedConfig.profileName,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.toLowerCase());
  if (!allowedProfiles.includes(requested.toLowerCase())) {
    throw new Error(
      `AdsPower profile ${JSON.stringify(requested)} is outside the trusted user-config pool.`,
    );
  }

  return {
    apiBase: trustedConfig.apiBase,
    timeoutMs: trustedConfig.timeoutMs,
    cdpMask: trustedConfig.cdpMask,
    profiles: [requested],
    strategy: "round-robin",
  };
}
