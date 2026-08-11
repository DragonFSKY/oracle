import { isProModel } from "../oracle/modelResolver.js";

export type EngineMode = "api" | "browser" | "relay";

export function defaultWaitPreference(model: string, engine: EngineMode): boolean {
  // Human relay work is inherently asynchronous and may sit with an operator for hours.
  // Return the durable session immediately unless the caller explicitly asks for --wait.
  if (engine === "relay") {
    return false;
  }
  // Pro-class API runs can take a long time; prefer non-blocking unless explicitly overridden.
  if (engine === "api" && isProModel(model)) {
    return false;
  }
  return true; // browser or non-pro API models block unless explicitly detached
}

/**
 * Determine which engine to use based on CLI flags and the environment.
 *
 * Precedence:
 * 1) Legacy --browser flag forces browser.
 * 2) Explicit --engine value.
 * 3) Explicit API provider routing flags force API.
 * 4) ORACLE_ENGINE environment override (api|browser|relay).
 * 5) Config engine value.
 * 6) API environment decides: api when set, otherwise browser.
 */
export function resolveEngine({
  engine,
  configEngine,
  browserFlag,
  apiProviderRequested,
  env,
}: {
  engine?: EngineMode;
  configEngine?: EngineMode;
  browserFlag?: boolean;
  apiProviderRequested?: boolean;
  env: NodeJS.ProcessEnv;
}): EngineMode {
  if (browserFlag) {
    return "browser";
  }
  if (engine) {
    return engine;
  }
  if (apiProviderRequested) {
    return "api";
  }
  const envEngine = normalizeEngineMode(env.ORACLE_ENGINE);
  if (envEngine) {
    return envEngine;
  }
  if (configEngine) {
    return configEngine;
  }
  return hasApiEnvironment(env) ? "api" : "browser";
}

function hasApiEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OPENAI_API_KEY || env.OPENROUTER_API_KEY);
}

function normalizeEngineMode(raw: unknown): EngineMode | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "api") return "api";
  if (normalized === "browser") return "browser";
  if (normalized === "relay") return "relay";
  return null;
}
