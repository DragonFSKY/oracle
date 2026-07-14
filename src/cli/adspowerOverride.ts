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
    apiKeyEnv: trustedConfig.apiKeyEnv,
    apiRequestIntervalMs: trustedConfig.apiRequestIntervalMs,
    apiVersion: trustedConfig.apiVersion,
    timeoutMs: trustedConfig.timeoutMs,
    cdpMask: trustedConfig.cdpMask,
    lastOpenedTabs: trustedConfig.lastOpenedTabs,
    proxyDetection: trustedConfig.proxyDetection,
    profiles: [requested],
    strategy: "round-robin",
  };
}
