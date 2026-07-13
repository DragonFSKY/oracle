import { createHash } from "node:crypto";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";

const DEFAULT_ADSPOWER_API = "http://127.0.0.1:50325";
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
  /** AdsPower local API base URL (default: http://127.0.0.1:50325). */
  apiBase?: string;
  /** Timeout for API calls in ms (default: 10_000). */
  timeoutMs?: number;
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

async function pickFromPool(
  apiBase: string,
  timeoutMs: number,
  profileNames: string[],
  strategy: "round-robin" | "random",
  sessionId: string,
  logger?: (msg: string) => void,
): Promise<{ userId: string; profileName: string; pinned: boolean }> {
  // List all profiles from AdsPower
  const list = await adspowerFetch(apiBase, "/api/v1/user/list?page=1&page_size=100", timeoutMs);
  const allProfiles =
    (list?.data as { list?: Array<{ user_id: string; name: string }> })?.list ?? [];

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
  apiBase: string,
  path: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`AdsPower API returned ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

async function findSingleProfile(
  apiBase: string,
  timeoutMs: number,
  config: AdspowerConfig,
): Promise<{ userId: string; profileName: string }> {
  if (config.userId) {
    return { userId: config.userId, profileName: config.profileName ?? config.userId };
  }
  const list = await adspowerFetch(apiBase, "/api/v1/user/list?page=1&page_size=100", timeoutMs);
  const profiles = (list?.data as { list?: Array<{ user_id: string; name: string }> })?.list ?? [];
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
  const apiBase = config.apiBase ?? DEFAULT_ADSPOWER_API;
  const timeoutMs = config.timeoutMs ?? 10_000;

  let userId: string;
  let profileName: string;
  let pinned = false;

  // Pool mode
  if (config.profiles && config.profiles.length > 0) {
    const sid = sessionId ?? `anon-${Date.now().toString(36)}`;
    const strategy = config.strategy ?? "round-robin";
    const pick = await pickFromPool(apiBase, timeoutMs, config.profiles, strategy, sid, logger);
    userId = pick.userId;
    profileName = pick.profileName;
    pinned = pick.pinned;
    logger?.(
      `[adspower] Pool pick: "${profileName}" (${userId}) for session ${sid.slice(0, 12)}${pinned ? " [pinned]" : ""}`,
    );
  } else {
    // Single-profile mode (backward compatible)
    const single = await findSingleProfile(apiBase, timeoutMs, config);
    userId = single.userId;
    profileName = single.profileName;
    logger?.(`[adspower] Found profile "${profileName}" (${userId})`);
  }

  // Check if browser is already active
  const activeResult = await adspowerFetch(
    apiBase,
    `/api/v1/browser/active?user_id=${userId}`,
    timeoutMs,
  );
  const activeData = activeResult?.data as
    | { status?: string; ws?: { puppeteer?: string }; debug_port?: string }
    | undefined;

  const isActive = activeData?.status === "Active" && activeData?.ws?.puppeteer;
  let wsEndpoint: string;
  let debugPort: number;

  if (isActive) {
    wsEndpoint = activeData!.ws!.puppeteer!;
    debugPort = Number(activeData!.debug_port) || 0;
    logger?.(`[adspower] Browser already active for "${profileName}" on port ${debugPort}`);
  } else {
    logger?.(`[adspower] Starting browser for "${profileName}"...`);
    const startResult = await adspowerFetch(
      apiBase,
      `/api/v1/browser/start?user_id=${userId}`,
      Math.max(timeoutMs, 30_000),
    );
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
