import type { AdspowerConfig } from "../browser/adspower.js";
import type { BrowserRouteConfig, UserConfig } from "../config.js";
import { resolveAdspowerConfigForRun } from "./adspowerOverride.js";

const CHATGPT_PROJECT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const ROUTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface BrowserRouteFlagOptions {
  browserRoute?: string;
  chatgptUrl?: string;
  browserUrl?: string;
  browserAdspowerProfile?: string;
  browserRequireProject?: boolean;
}

export type BrowserRouteSourceGetter = (key: keyof BrowserRouteFlagOptions) => string | undefined;

export interface ResolvedBrowserRoute {
  name: string;
  chatgptUrl: string;
  adspower: AdspowerConfig;
}

function normalizeRouteName(value: unknown, label: string): string {
  if (typeof value !== "string" || !ROUTE_NAME_PATTERN.test(value.trim())) {
    throw new Error(
      `${label} must match ${ROUTE_NAME_PATTERN.source} and be at most 64 characters.`,
    );
  }
  return value.trim();
}

function normalizeRouteProjectUrl(value: unknown, routeName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Browser route ${JSON.stringify(routeName)} is missing its ChatGPT Project URL.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(
      `Browser route ${JSON.stringify(routeName)} has an invalid ChatGPT Project URL.`,
    );
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:" ||
    !CHATGPT_PROJECT_HOSTS.has(parsed.hostname) ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    segments.length !== 3 ||
    segments[0] !== "g" ||
    !segments[1] ||
    segments[2] !== "project"
  ) {
    throw new Error(
      `Browser route ${JSON.stringify(routeName)} must use an exact HTTPS ChatGPT Project URL ending in /project.`,
    );
  }
  return parsed.toString();
}

function resolveRouteDefinition(
  routes: Record<string, BrowserRouteConfig> | undefined,
  routeName: string,
): BrowserRouteConfig {
  if (!routes || !Object.prototype.hasOwnProperty.call(routes, routeName)) {
    throw new Error(
      `Unknown browser route ${JSON.stringify(routeName)}. Define it in the trusted user config under browser.routes.`,
    );
  }
  const route = routes[routeName];
  if (!route || typeof route !== "object") {
    throw new Error(`Browser route ${JSON.stringify(routeName)} has an invalid definition.`);
  }
  return route;
}

function isExplicit(
  getSource: BrowserRouteSourceGetter,
  key: keyof BrowserRouteFlagOptions,
): boolean {
  const source = getSource(key);
  return source !== undefined && source !== "default";
}

export function resolveBrowserRouteForRun(
  options: BrowserRouteFlagOptions,
  userConfig: UserConfig,
  getSource: BrowserRouteSourceGetter = () => undefined,
): ResolvedBrowserRoute | null {
  const browser = userConfig.browser;
  const rawRouteName = options.browserRoute ?? browser?.route ?? browser?.defaultRoute;
  if (rawRouteName === undefined || rawRouteName === null) {
    return null;
  }
  const routeName = normalizeRouteName(rawRouteName, "Browser route name");
  const conflictingFlags = (["chatgptUrl", "browserUrl", "browserAdspowerProfile"] as const).filter(
    (key) => isExplicit(getSource, key),
  );
  if (conflictingFlags.length > 0) {
    const names = conflictingFlags.map((key) => {
      if (key === "chatgptUrl") return "--chatgpt-url";
      if (key === "browserUrl") return "--browser-url";
      return "--browser-adspower-profile";
    });
    throw new Error(
      `--browser-route selects an atomic profile/Project binding and cannot be combined with ${names.join(", ")}.`,
    );
  }

  const route = resolveRouteDefinition(browser?.routes, routeName);
  const chatgptUrl = normalizeRouteProjectUrl(route.chatgptUrl, routeName);
  const requestedProfile =
    typeof route.adspowerProfile === "string" ? route.adspowerProfile.trim() : "";
  if (!requestedProfile) {
    throw new Error(`Browser route ${JSON.stringify(routeName)} is missing its AdsPower profile.`);
  }
  let adspower: AdspowerConfig | undefined;
  try {
    adspower = resolveAdspowerConfigForRun(browser?.adspower, requestedProfile);
  } catch {
    throw new Error(
      `Browser route ${JSON.stringify(routeName)} must reference one profile from the trusted AdsPower pool.`,
    );
  }
  if (!adspower) {
    throw new Error(
      `Browser route ${JSON.stringify(routeName)} requires browser.adspower in the trusted user config.`,
    );
  }
  return { name: routeName, chatgptUrl, adspower };
}

export function applyBrowserRouteToOptions(
  options: BrowserRouteFlagOptions,
  route: ResolvedBrowserRoute,
): void {
  options.chatgptUrl = route.chatgptUrl;
  options.browserUrl = undefined;
  options.browserRequireProject = true;
}

export function assertBrowserFollowupRouteCompatibility({
  storedRouteName,
  requestedRouteName,
  hasExplicitRawBinding,
}: {
  storedRouteName?: string | null;
  requestedRouteName?: string | null;
  hasExplicitRawBinding?: boolean;
}): void {
  const stored = storedRouteName?.trim() || null;
  const requested = requestedRouteName?.trim() || null;
  if (stored && hasExplicitRawBinding) {
    throw new Error(
      `Browser follow-up session is pinned to route ${JSON.stringify(stored)}; raw profile or URL overrides are not allowed.`,
    );
  }
  if (!requested) return;
  const normalizedRequested = normalizeRouteName(requested, "Browser route name");
  if (!stored) {
    throw new Error(
      "This browser follow-up predates route pinning; --browser-route cannot rebind an existing conversation.",
    );
  }
  if (normalizedRequested !== stored) {
    throw new Error(
      `Browser follow-up session is pinned to route ${JSON.stringify(stored)} and cannot switch to ${JSON.stringify(normalizedRequested)}.`,
    );
  }
}
