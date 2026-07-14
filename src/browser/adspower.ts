import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";

const DEFAULT_ADSPOWER_API = "http://127.0.0.1:50325";
const DEFAULT_ADSPOWER_API_KEY_ENV = "ADSPOWER_API_KEY";
const DEFAULT_ADSPOWER_API_REQUEST_INTERVAL_MS = 500;
const ADSPOWER_API_THROTTLE_DIR = "adspower-api-throttle";
const ADSPOWER_API_LOCK_MIN_STALE_MS = 5_000;
const PINNING_FILE = "adspower-session-pins.json";
const RATELIMIT_FILE = "adspower-rate-limits.json";
const COUNTER_FILE = "adspower-round-robin-counter.json";
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000; // 5 min before retrying a rate-limited profile

async function incrRoundRobinCounter(): Promise<number> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const home = getOracleHomeDir();
  await fs.mkdir(home, { recursive: true });
  const file = path.join(home, COUNTER_FILE);
  let counter = 0;
  try {
    const raw = await fs.readFile(file, "utf-8");
    counter = JSON.parse(raw).counter ?? 0;
  } catch {
    /* first run */
  }
  counter += 1;
  await fs.writeFile(file, JSON.stringify({ counter }), "utf-8");
  return counter;
}

export interface AdspowerConfig {
  /** Single profile name (simple mode — one profile). */
  profileName?: string;
  /** Single profile user_id (simple mode — one profile). */
  userId?: string;
  /** Profile pool for load balancing with session pinning. Entries may be names or user_ids. */
  profiles?: string[];
  /** Pool strategy: "round-robin" | "random" (default: "round-robin"). */
  strategy?: "round-robin" | "random";
  /** AdsPower Local API base URL. Defaults to AdsPower's local_api file, then localhost:50325. */
  apiBase?: string;
  /** Local API generation to use. "auto" prefers V2 and falls back to V1 (default: "auto"). */
  apiVersion?: "auto" | "v1" | "v2";
  /** Environment variable containing the Local API bearer token (default: ADSPOWER_API_KEY). */
  apiKeyEnv?: string;
  /** Timeout for API calls in ms (default: 10_000). */
  timeoutMs?: number;
  /** Minimum interval between Local API calls across Oracle processes (default: 500ms). */
  apiRequestIntervalMs?: number;
  /** Ask AdsPower to mask CDP detection when it starts a profile (default: true). */
  cdpMask?: boolean;
  /** Restore tabs from the profile's previous run (default: false for isolated Oracle runs). */
  lastOpenedTabs?: boolean;
  /** Open AdsPower's proxy-detection page when starting a profile (default: false). */
  proxyDetection?: boolean;
}

export interface AdspowerResolved {
  browserWSEndpoint: string;
  debugPort: number;
  userId: string;
  profileName: string;
  /** Oracle-owned state directory for coordinating tabs in this AdsPower profile. */
  tabLeaseDir: string;
}

export function resolveAdspowerTabLeaseDir(userId: string): string {
  const key = createHash("sha256").update(userId).digest("hex").slice(0, 24);
  return path.join(getOracleHomeDir(), "adspower-tab-leases", key);
}

export function resolveAdspowerConcurrentTabLimit(configuredLimit?: number): number {
  return configuredLimit ?? 1;
}

// ── session → profile pinning ──────────────────────────────────────────

interface PinStore {
  [sessionId: string]: { profileName: string; userId: string; at: string };
}

async function readPins(): Promise<PinStore> {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(getOracleHomeDir(), PINNING_FILE);
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as PinStore;
  } catch {
    return {};
  }
}

async function writePin(sessionId: string, profileName: string, userId: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const home = getOracleHomeDir();
  await fs.mkdir(home, { recursive: true });
  const file = path.join(home, PINNING_FILE);
  const pins = await readPins();
  pins[sessionId] = { profileName, userId, at: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(pins, null, 2), "utf-8");
}

async function getPinnedProfile(
  sessionId: string,
): Promise<{ profileName: string; userId: string } | null> {
  const pins = await readPins();
  const pin = pins[sessionId];
  if (!pin) return null;
  return { profileName: pin.profileName, userId: pin.userId };
}

// ── rate limit tracking ────────────────────────────────────────────────

async function readRateLimits(): Promise<Record<string, number>> {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(getOracleHomeDir(), RATELIMIT_FILE);
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function markProfileRateLimited(profileName: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const home = getOracleHomeDir();
  await fs.mkdir(home, { recursive: true });
  const file = path.join(home, RATELIMIT_FILE);
  const limits = await readRateLimits();
  limits[profileName] = Date.now();
  await fs.writeFile(file, JSON.stringify(limits, null, 2), "utf-8");
}

// ── pool selection ─────────────────────────────────────────────────────

interface AdspowerApiContext {
  apiBase: string;
  apiKey?: string;
  requestedVersion: "auto" | "v1" | "v2";
  negotiatedVersion?: "v1" | "v2";
  timeoutMs: number;
  logger?: (msg: string) => void;
  requestIntervalMs: number;
}

interface AdspowerProfileSummary {
  user_id: string;
  name: string;
}

async function pickFromPool(
  api: AdspowerApiContext,
  profileNames: string[],
  strategy: "round-robin" | "random",
  sessionId: string,
  logger?: (msg: string) => void,
): Promise<{ userId: string; profileName: string; pinned: boolean }> {
  // List all profiles from AdsPower
  const allProfiles = await listAdspowerProfiles(api);

  // Match requested profile names or stable user_ids (case-insensitive).
  const requested = new Set(profileNames.map((n) => n.toLowerCase()));
  const isRequestedProfile = (p: { user_id?: string; name?: string }): boolean => {
    const name = p.name?.toLowerCase();
    const userId = p.user_id?.toLowerCase();
    return Boolean((name && requested.has(name)) || (userId && requested.has(userId)));
  };
  const pinned = await getPinnedProfile(sessionId);
  if (pinned) {
    if (isRequestedProfile({ user_id: pinned.userId, name: pinned.profileName })) {
      return { ...pinned, pinned: true };
    }
    logger?.(
      `[adspower] Ignoring pinned profile "${pinned.profileName}" (${pinned.userId}) because it is outside the configured pool.`,
    );
  }
  const allMatches = allProfiles.filter((p) => {
    return isRequestedProfile(p);
  });

  if (allMatches.length === 0) {
    const available = allProfiles.map((p) => `${p.name || "(unnamed)"} (${p.user_id})`).join(", ");
    throw new Error(
      `No AdsPower profiles matched names/user_ids ${JSON.stringify(profileNames)}. Available: ${available || "(none)"}`,
    );
  }

  // Filter out rate-limited profiles (those still in cooldown)
  const limits = await readRateLimits();
  const now = Date.now();
  const healthy = allMatches.filter((p) => {
    const limitedAt = limits[p.name];
    if (!limitedAt) return true;
    if (now - limitedAt > RATE_LIMIT_COOLDOWN_MS) return true;
    return false;
  });

  // If all are rate-limited, wait for the oldest cooldown to expire and retry
  if (healthy.length === 0) {
    const oldest = Math.min(...allMatches.map((p) => limits[p.name] ?? now));
    const remaining = Math.max(0, oldest + RATE_LIMIT_COOLDOWN_MS - now);
    logger?.(
      `[adspower] All profiles rate-limited. Waiting ${Math.round(remaining / 1000)}s for cooldown...`,
    );
    await new Promise((resolve) => setTimeout(resolve, remaining + 5_000));
    // Retry with all profiles (cooldowns should be expired)
    const retry = allMatches;
    const counter = await incrRoundRobinCounter();
    const idx = (counter - 1) % retry.length;
    const chosen = retry[idx];
    await writePin(sessionId, chosen.name || chosen.user_id, chosen.user_id);
    return { userId: chosen.user_id, profileName: chosen.name || chosen.user_id, pinned: false };
  }

  let chosen: { user_id: string; name: string };
  if (strategy === "random") {
    const idx = Math.floor(Math.random() * healthy.length);
    chosen = healthy[idx];
  } else {
    // True round-robin: each new session gets the next profile in sequence.
    const counter = await incrRoundRobinCounter();
    const idx = (counter - 1) % healthy.length;
    chosen = healthy[idx];
    logger?.(
      `[adspower] Round-robin #${counter} → "${chosen.name}" (${allMatches.length - healthy.length} rate-limited skipped)`,
    );
  }

  await writePin(sessionId, chosen.name || chosen.user_id, chosen.user_id);
  return { userId: chosen.user_id, profileName: chosen.name || chosen.user_id, pinned: false };
}

// ── API helpers ────────────────────────────────────────────────────────

async function adspowerFetch(
  api: AdspowerApiContext,
  path: string,
  options: { body?: Record<string, unknown>; method?: "GET" | "POST" } = {},
): Promise<Record<string, unknown>> {
  await waitForAdspowerApiSlot(api);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), api.timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (api.apiKey) {
      headers.Authorization = `Bearer ${api.apiKey}`;
    }
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(`${api.apiBase}${path}`, {
      body: options.body ? JSON.stringify(options.body) : undefined,
      headers,
      method: options.method ?? (options.body ? "POST" : "GET"),
      signal: controller.signal,
    });
    const result = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new AdspowerApiError(
        formatAdspowerHttpError(res.status, Boolean(api.apiKey)),
        res.status,
        result.code,
      );
    }
    if (typeof result.code === "number" && result.code !== 0) {
      const message = typeof result.msg === "string" ? result.msg : `code ${result.code}`;
      throw new AdspowerApiError(`AdsPower API failed: ${message}`, res.status, result.code);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForAdspowerApiSlot(api: AdspowerApiContext): Promise<void> {
  if (api.requestIntervalMs <= 0) return;
  const fs = await import("node:fs/promises");
  const root = path.join(getOracleHomeDir(), ADSPOWER_API_THROTTLE_DIR);
  const key = createHash("sha256").update(api.apiBase).digest("hex").slice(0, 24);
  const lockDir = path.join(root, `${key}.lock`);
  const stateFile = path.join(root, `${key}.json`);
  await fs.mkdir(root, { recursive: true });

  const lockStaleMs = Math.max(
    ADSPOWER_API_LOCK_MIN_STALE_MS,
    api.requestIntervalMs + ADSPOWER_API_LOCK_MIN_STALE_MS,
  );
  for (;;) {
    try {
      await fs.mkdir(lockDir, { recursive: false });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const lockAgeMs = await fs
        .stat(lockDir)
        .then((stat) => Date.now() - stat.mtimeMs)
        .catch(() => 0);
      if (lockAgeMs > lockStaleMs) {
        await fs.rm(lockDir, { force: true, recursive: true }).catch(() => undefined);
        continue;
      }
      await delay(25);
    }
  }

  try {
    let lastRequestAt = 0;
    try {
      const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as {
        lastRequestAt?: number;
      };
      lastRequestAt = Number.isFinite(state.lastRequestAt) ? (state.lastRequestAt ?? 0) : 0;
    } catch {
      // First request for this Local API endpoint.
    }
    const waitMs = Math.max(0, lastRequestAt + api.requestIntervalMs - Date.now());
    if (waitMs > 0) await delay(waitMs);
    await fs.writeFile(stateFile, JSON.stringify({ lastRequestAt: Date.now() }), "utf8");
  } finally {
    await fs.rm(lockDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class AdspowerApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: unknown,
  ) {
    super(message);
    this.name = "AdspowerApiError";
  }
}

function formatAdspowerHttpError(status: number, hasApiKey: boolean): string {
  if (status === 401 || status === 403) {
    return hasApiKey
      ? `AdsPower Local API rejected the configured bearer token (${status}).`
      : `AdsPower Local API requires authentication (${status}); set ${DEFAULT_ADSPOWER_API_KEY_ENV} or configure adspower.apiKeyEnv.`;
  }
  return `AdsPower API returned ${status}`;
}

function isUnsupportedV2Error(error: unknown): boolean {
  if (error instanceof AdspowerApiError && [404, 405, 501].includes(error.status ?? 0)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /not support(?:ed)?|unsupported|unknown api|no route|\bapi(?: endpoint)? not found\b/i.test(
    message,
  );
}

async function withApiVersionFallback<T>(
  api: AdspowerApiContext,
  operation: string,
  v2: () => Promise<T>,
  v1: () => Promise<T>,
): Promise<T> {
  if (api.requestedVersion === "v1" || api.negotiatedVersion === "v1") {
    return await v1();
  }
  try {
    const result = await v2();
    api.negotiatedVersion = "v2";
    return result;
  } catch (error) {
    if (api.requestedVersion === "v2" || !isUnsupportedV2Error(error)) {
      throw error;
    }
    api.negotiatedVersion = "v1";
    api.logger?.(`[adspower] Local API V2 does not support ${operation}; falling back to V1.`);
    return await v1();
  }
}

async function listAdspowerProfiles(api: AdspowerApiContext): Promise<AdspowerProfileSummary[]> {
  return await withApiVersionFallback(
    api,
    "profile listing",
    async () => {
      const result = await adspowerFetch(api, "/api/v2/browser-profile/list", {
        body: { limit: 100, page: 1 },
      });
      const profiles =
        (result.data as { list?: Array<{ name?: string; profile_id?: string }> } | undefined)
          ?.list ?? [];
      return profiles
        .filter((profile): profile is { name?: string; profile_id: string } =>
          Boolean(profile.profile_id),
        )
        .map((profile) => ({ user_id: profile.profile_id, name: profile.name ?? "" }));
    },
    async () => {
      const result = await adspowerFetch(api, "/api/v1/user/list?page=1&page_size=100");
      return (result.data as { list?: AdspowerProfileSummary[] } | undefined)?.list ?? [];
    },
  );
}

async function resolveAdspowerApiBase(
  config: AdspowerConfig,
  logger?: (msg: string) => void,
): Promise<string> {
  const explicit = config.apiBase?.trim() || process.env.ADSPOWER_API_BASE?.trim();
  if (explicit) {
    return normalizeAdspowerApiBase(explicit, "configured AdsPower API base");
  }
  const configRoot = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  const localApiFile =
    process.env.ADSPOWER_LOCAL_API_FILE?.trim() ||
    path.join(configRoot, "adspower_global", "cwd_global", "source", "local_api");
  try {
    const { readFile } = await import("node:fs/promises");
    const discovered = (await readFile(localApiFile, "utf8")).trim();
    const normalized = normalizeAdspowerApiBase(discovered, "AdsPower local_api file");
    logger?.("[adspower] Discovered the Local API endpoint from AdsPower's local_api file.");
    return normalized;
  } catch (error) {
    if (error instanceof Error && error.name !== "ENOENT" && !/ENOENT/.test(error.message)) {
      logger?.(`[adspower] Ignoring an invalid local_api file (${error.message}).`);
    }
    return DEFAULT_ADSPOWER_API;
  }
}

function normalizeAdspowerApiBase(value: string, source: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${source}: expected an HTTP(S) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${source}: expected an HTTP(S) URL.`);
  }
  return value.replace(/\/+$/, "");
}

function resolveAdspowerApiKey(config: AdspowerConfig): string | undefined {
  const envName = config.apiKeyEnv?.trim() || DEFAULT_ADSPOWER_API_KEY_ENV;
  return process.env[envName]?.trim() || undefined;
}

function resolveAdspowerApiVersion(config: AdspowerConfig): "auto" | "v1" | "v2" {
  const version = config.apiVersion ?? "auto";
  if (version !== "auto" && version !== "v1" && version !== "v2") {
    throw new Error(`Invalid AdsPower API version ${JSON.stringify(version)}.`);
  }
  return version;
}

function resolveAdspowerApiRequestInterval(config: AdspowerConfig): number {
  const envValue = process.env.ADSPOWER_API_REQUEST_INTERVAL_MS?.trim();
  const raw = config.apiRequestIntervalMs ?? (envValue ? Number(envValue) : undefined);
  const interval = raw ?? DEFAULT_ADSPOWER_API_REQUEST_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error(`Invalid AdsPower API request interval ${JSON.stringify(raw)}.`);
  }
  return interval;
}

interface AdspowerBrowserData {
  status?: string;
  ws?: { puppeteer?: string };
  debug_port?: string;
}

async function getAdspowerBrowserStatus(
  api: AdspowerApiContext,
  userId: string,
): Promise<AdspowerBrowserData> {
  return await withApiVersionFallback(
    api,
    "browser status",
    async () => {
      const result = await adspowerFetch(
        api,
        `/api/v2/browser-profile/active?profile_id=${encodeURIComponent(userId)}`,
      );
      return (result.data as AdspowerBrowserData | undefined) ?? {};
    },
    async () => {
      const result = await adspowerFetch(
        api,
        `/api/v1/browser/active?user_id=${encodeURIComponent(userId)}`,
      );
      return (result.data as AdspowerBrowserData | undefined) ?? {};
    },
  );
}

async function startAdspowerBrowser(
  api: AdspowerApiContext,
  userId: string,
  config: AdspowerConfig,
): Promise<Record<string, unknown>> {
  const cdpMask = config.cdpMask ?? true;
  const lastOpenedTabs = config.lastOpenedTabs ?? false;
  const proxyDetection = config.proxyDetection ?? false;
  return await withApiVersionFallback(
    api,
    "browser startup",
    async () =>
      await adspowerFetch(api, "/api/v2/browser-profile/start", {
        body: {
          cdp_mask: cdpMask ? "1" : "0",
          headless: "0",
          last_opened_tabs: lastOpenedTabs ? "1" : "0",
          profile_id: userId,
          proxy_detection: proxyDetection ? "1" : "0",
        },
      }),
    async () =>
      await adspowerFetch(
        api,
        `/api/v1/browser/start?user_id=${encodeURIComponent(userId)}&open_tabs=${lastOpenedTabs ? "0" : "1"}&ip_tab=${proxyDetection ? "1" : "0"}&cdp_mask=${cdpMask ? "1" : "0"}`,
      ),
  );
}

async function findSingleProfile(
  api: AdspowerApiContext,
  config: AdspowerConfig,
): Promise<{ userId: string; profileName: string }> {
  if (config.userId) {
    return { userId: config.userId, profileName: config.profileName ?? config.userId };
  }
  const profiles = await listAdspowerProfiles(api);
  const target = (config.profileName ?? "chatgpt pro").toLowerCase();
  const match = profiles.find((p) => p.name?.toLowerCase() === target);
  if (!match) {
    const available = profiles.map((p) => p.name).join(", ");
    throw new Error(
      `AdsPower profile "${config.profileName}" not found. Available: ${available || "(none)"}`,
    );
  }
  return { userId: match.user_id, profileName: match.name || match.user_id };
}

// ── main resolver ──────────────────────────────────────────────────────

export async function resolveAdspowerBrowser(
  config: AdspowerConfig,
  logger?: (msg: string) => void,
  sessionId?: string,
): Promise<AdspowerResolved & { pinned?: boolean }> {
  const apiBase = await resolveAdspowerApiBase(config, logger);
  const timeoutMs = config.timeoutMs ?? 10_000;
  const api: AdspowerApiContext = {
    apiBase,
    apiKey: resolveAdspowerApiKey(config),
    requestedVersion: resolveAdspowerApiVersion(config),
    requestIntervalMs: resolveAdspowerApiRequestInterval(config),
    timeoutMs,
    logger,
  };

  let userId: string;
  let profileName: string;
  let pinned = false;

  // Pool mode
  if (config.profiles && config.profiles.length > 0) {
    const sid = sessionId ?? `anon-${Date.now().toString(36)}`;
    const strategy = config.strategy ?? "round-robin";
    const pick = await pickFromPool(api, config.profiles, strategy, sid, logger);
    userId = pick.userId;
    profileName = pick.profileName;
    pinned = pick.pinned;
    logger?.(
      `[adspower] Pool pick: "${profileName}" (${userId}) for session ${sid.slice(0, 12)}${pinned ? " [pinned]" : ""}`,
    );
  } else {
    // Single-profile mode (backward compatible)
    const single = await findSingleProfile(api, config);
    userId = single.userId;
    profileName = single.profileName;
    logger?.(`[adspower] Found profile "${profileName}" (${userId})`);
  }

  // Check if browser is already active
  const activeData = await getAdspowerBrowserStatus(api, userId);

  const isActive = activeData?.status === "Active" && activeData?.ws?.puppeteer;
  let wsEndpoint: string;
  let debugPort: number;

  if (isActive) {
    wsEndpoint = activeData!.ws!.puppeteer!;
    debugPort = Number(activeData!.debug_port) || 0;
    logger?.(`[adspower] Browser already active for "${profileName}" on port ${debugPort}`);
  } else {
    const lastOpenedTabs = config.lastOpenedTabs ?? false;
    const proxyDetection = config.proxyDetection ?? false;
    logger?.(
      `[adspower] Starting browser for "${profileName}" with ${lastOpenedTabs ? "restored tabs" : "clean tabs"}, proxy detection ${proxyDetection ? "enabled" : "disabled"}, and CDP masking ${config.cdpMask === false ? "disabled" : "enabled"}...`,
    );
    const originalTimeoutMs = api.timeoutMs;
    api.timeoutMs = Math.max(timeoutMs, 30_000);
    const startResult = await startAdspowerBrowser(api, userId, config).finally(() => {
      api.timeoutMs = originalTimeoutMs;
    });
    const startData = startResult?.data as
      | { ws?: { puppeteer?: string }; debug_port?: string }
      | undefined;

    if (!startData?.ws?.puppeteer) {
      throw new Error(
        `AdsPower failed to start browser for "${profileName}". Response: ${JSON.stringify(startResult)}`,
      );
    }
    wsEndpoint = startData.ws.puppeteer;
    debugPort = Number(startData.debug_port) || 0;
    logger?.(`[adspower] Browser started for "${profileName}" on port ${debugPort}`);
  }

  return {
    browserWSEndpoint: wsEndpoint,
    debugPort,
    userId,
    profileName,
    tabLeaseDir: resolveAdspowerTabLeaseDir(userId),
    pinned,
  };
}
