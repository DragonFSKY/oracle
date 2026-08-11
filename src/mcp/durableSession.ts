import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionMetadata } from "../sessionManager.js";
import { sessionStore } from "../sessionStore.js";

export type DurableSessionWorkerMode = "execute" | "recover";

export interface DurableSessionWorker {
  pid: number;
  mode: DurableSessionWorkerMode;
  token: string;
}

interface DurableSessionDeps {
  spawnProcess?: typeof spawn;
  cliEntrypoint?: string;
  now?: () => number;
  recoveryLockGraceMs?: number;
}

const RECOVERY_LOCK_OWNER_FILE = "owner.json";
const RECOVERY_LOCK_STARTUP_GRACE_MS = 10_000;
const PRE_SUBMIT_ORPHAN_GRACE_MS = 30_000;
const RECOVERY_LOCK_DIR_ENV = "ORACLE_DURABLE_RECOVERY_LOCK_DIR";
const RECOVERY_LOCK_TOKEN_ENV = "ORACLE_DURABLE_RECOVERY_LOCK_TOKEN";
const DURABLE_SESSION_ID_ENV = "ORACLE_DURABLE_SESSION_ID";
const DURABLE_SESSION_TOKEN_ENV = "ORACLE_DURABLE_SESSION_TOKEN";
const DURABLE_SESSION_MODE_ENV = "ORACLE_DURABLE_SESSION_MODE";

export function createDurableSessionWorkerToken(): string {
  return randomUUID();
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ESRCH" || code === "EINVAL") return false;
    return true;
  }
}

async function resolveCliEntrypoint(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const built = fileURLToPath(new URL("../../bin/oracle-cli.js", import.meta.url));
  try {
    await fs.access(built);
    return built;
  } catch {
    return fileURLToPath(new URL("../../bin/oracle-cli.ts", import.meta.url));
  }
}

function buildCliArgs(cliEntrypoint: string, mode: DurableSessionWorkerMode, sessionId: string) {
  const commandArgs = mode === "execute" ? ["--exec-session", sessionId] : ["--session", sessionId];
  if (cliEntrypoint.endsWith(".ts")) {
    return ["--import", "tsx", cliEntrypoint, ...commandArgs];
  }
  return [cliEntrypoint, ...commandArgs];
}

async function spawnWorker(
  sessionId: string,
  mode: DurableSessionWorkerMode,
  deps: DurableSessionDeps,
  envOverrides: Record<string, string> = {},
  token = createDurableSessionWorkerToken(),
): Promise<{ child: ChildProcess; worker: DurableSessionWorker }> {
  const cliEntrypoint = await resolveCliEntrypoint(deps.cliEntrypoint);
  const spawnProcess = deps.spawnProcess ?? spawn;
  const child = spawnProcess(process.execPath, buildCliArgs(cliEntrypoint, mode, sessionId), {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      [DURABLE_SESSION_ID_ENV]: sessionId,
      [DURABLE_SESSION_TOKEN_ENV]: token,
      [DURABLE_SESSION_MODE_ENV]: mode,
      ...envOverrides,
    },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  if (!child.pid) {
    throw new Error(`Detached Oracle ${mode} worker started without a pid.`);
  }
  child.unref();
  return { child, worker: { pid: child.pid, mode, token } };
}

export async function launchDurableSessionWorker(
  sessionId: string,
  deps: DurableSessionDeps = {},
  token = createDurableSessionWorkerToken(),
): Promise<DurableSessionWorker> {
  const { worker } = await spawnWorker(sessionId, "execute", deps, {}, token);
  return worker;
}

interface RecoveryLockRecord {
  pid: number;
  createdAt: string;
  token: string;
  phase: "claiming" | "worker";
}

async function readRecoveryLock(lockDir: string): Promise<RecoveryLockRecord | null> {
  try {
    const raw = await fs.readFile(path.join(lockDir, RECOVERY_LOCK_OWNER_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<RecoveryLockRecord>;
    return typeof parsed.pid === "number" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.token === "string" &&
      (parsed.phase === "claiming" || parsed.phase === "worker")
      ? {
          pid: parsed.pid,
          createdAt: parsed.createdAt,
          token: parsed.token,
          phase: parsed.phase,
        }
      : null;
  } catch {
    return null;
  }
}

async function writeRecoveryLock(lockDir: string, record: RecoveryLockRecord): Promise<void> {
  const temporary = path.join(lockDir, `.owner-${process.pid}-${record.token}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
  await fs.rename(temporary, path.join(lockDir, RECOVERY_LOCK_OWNER_FILE));
}

async function recoveryLockAgeMs(lockDir: string, now: number): Promise<number> {
  const stats = await fs.stat(lockDir).catch(() => null);
  return stats ? Math.max(0, now - stats.mtimeMs) : Number.POSITIVE_INFINITY;
}

async function releaseRecoveryLock(lockDir: string, token: string): Promise<void> {
  const owner = await readRecoveryLock(lockDir);
  if (owner?.token !== token) return;
  await fs.rm(lockDir, { recursive: true, force: true });
}

interface RecoveryLockClaim {
  lockDir: string;
  token: string;
}

async function acquireRecoveryLock(
  sessionId: string,
  deps: DurableSessionDeps,
): Promise<RecoveryLockClaim | null> {
  const { dir } = await sessionStore.getPaths(sessionId);
  const lockDir = path.join(dir, "mcp-recovery.lock");
  const now = deps.now ?? Date.now;
  const graceMs = deps.recoveryLockGraceMs ?? RECOVERY_LOCK_STARTUP_GRACE_MS;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      const token = randomUUID();
      await writeRecoveryLock(lockDir, {
        pid: process.pid,
        createdAt: new Date(now()).toISOString(),
        token,
        phase: "claiming",
      });
      return { lockDir, token };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const owner = await readRecoveryLock(lockDir);
      if (owner && isProcessAlive(owner.pid)) return null;
      // mkdir is atomic, but the owner record is written immediately afterwards. A concurrent
      // caller must not delete a fresh ownerless directory during that hand-off window.
      if (!owner && (await recoveryLockAgeMs(lockDir, now())) < graceMs) return null;
      // A claiming MCP can exit after spawning the worker but before handing over owner.json.
      // Give the child enough time to claim the lease from its inherited environment.
      if (owner?.phase === "claiming" && now() - Date.parse(owner.createdAt) < graceMs) {
        return null;
      }
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }
  return null;
}

/**
 * A detached recovery worker calls this before attaching to the saved session. It closes the
 * parent-exit hand-off gap by making the long-lived worker the recorded lock owner itself.
 */
export async function claimInheritedRecoveryLock(): Promise<void> {
  const lockDir = process.env[RECOVERY_LOCK_DIR_ENV]?.trim();
  const token = process.env[RECOVERY_LOCK_TOKEN_ENV]?.trim();
  if (!lockDir || !token) return;
  const owner = await readRecoveryLock(lockDir);
  if (!owner || owner.token !== token) {
    throw new Error("Detached Oracle recovery worker could not claim its recovery lease.");
  }
  await writeRecoveryLock(lockDir, {
    pid: process.pid,
    createdAt: owner.createdAt,
    token,
    phase: "worker",
  });
}

export async function claimInheritedDurableSessionWorker(sessionId: string): Promise<boolean> {
  await claimInheritedRecoveryLock();
  const inheritedSessionId = process.env[DURABLE_SESSION_ID_ENV]?.trim();
  const token = process.env[DURABLE_SESSION_TOKEN_ENV]?.trim();
  if (!inheritedSessionId && !token) return false;
  if (!inheritedSessionId || !token || inheritedSessionId !== sessionId) {
    throw new Error("Detached Oracle worker identity does not match the requested session.");
  }
  const metadata = await sessionStore.readSession(sessionId);
  if (!metadata || metadata.lifecycle?.runnerToken !== token) {
    throw new Error("Detached Oracle worker could not claim its session fencing token.");
  }
  const recovering = process.env[DURABLE_SESSION_MODE_ENV] === "recover";
  await sessionStore.updateSession(sessionId, {
    lifecycle: {
      ...metadata.lifecycle,
      runnerPid: process.pid,
      runnerState: recovering ? "recovering" : "running",
      runnerStartedAt: metadata.lifecycle.runnerStartedAt ?? new Date().toISOString(),
    },
  });
  return true;
}

export async function finishInheritedDurableSessionWorker(sessionId: string): Promise<void> {
  const token = process.env[DURABLE_SESSION_TOKEN_ENV]?.trim();
  if (!token) return;
  const metadata = await sessionStore.readSession(sessionId);
  if (
    !metadata?.lifecycle ||
    metadata.lifecycle.runnerToken !== token ||
    metadata.lifecycle.runnerPid !== process.pid
  ) {
    return;
  }
  await sessionStore.updateSession(sessionId, {
    lifecycle: {
      ...metadata.lifecycle,
      runnerState: "finished",
      runnerFinishedAt: new Date().toISOString(),
    },
  });
}

export async function launchOrphanedBrowserRecovery(
  sessionId: string,
  deps: DurableSessionDeps = {},
): Promise<DurableSessionWorker | null> {
  const claim = await acquireRecoveryLock(sessionId, deps);
  if (!claim) return null;
  const { lockDir, token } = claim;
  try {
    const metadata = await sessionStore.readSession(sessionId);
    if (!metadata) throw new Error(`Session "${sessionId}" not found.`);
    await sessionStore.updateSession(sessionId, {
      lifecycle: {
        ...(metadata.lifecycle ?? {
          engine: "browser",
          execution: "background",
          attached: false,
          detached: true,
          reattachCommand: `oracle session ${sessionId}`,
        }),
        runnerPid: undefined,
        runnerToken: token,
        runnerState: "recovering",
        runnerStartedAt: new Date((deps.now ?? Date.now)()).toISOString(),
        runnerFinishedAt: undefined,
      },
    });
    const { child, worker } = await spawnWorker(
      sessionId,
      "recover",
      deps,
      {
        [RECOVERY_LOCK_DIR_ENV]: lockDir,
        [RECOVERY_LOCK_TOKEN_ENV]: token,
      },
      token,
    );
    await writeRecoveryLock(lockDir, {
      pid: worker.pid,
      createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
      token,
      phase: "worker",
    });
    child.once("exit", () => {
      void releaseRecoveryLock(lockDir, token);
    });
    return worker;
  } catch (error) {
    const latest = await sessionStore.readSession(sessionId).catch(() => null);
    if (latest?.lifecycle?.runnerToken === token) {
      await sessionStore
        .updateSession(sessionId, {
          lifecycle: {
            ...latest.lifecycle,
            runnerState: "failed",
            runnerFinishedAt: new Date((deps.now ?? Date.now)()).toISOString(),
          },
        })
        .catch(() => undefined);
    }
    await releaseRecoveryLock(lockDir, token);
    throw error;
  }
}

export async function ensureOrphanedBrowserRecovery(
  metadata: SessionMetadata,
  deps: DurableSessionDeps = {},
): Promise<DurableSessionWorker | null> {
  const worker = await launchOrphanedBrowserRecovery(metadata.id, deps);
  if (!worker) return null;
  const latest = await sessionStore.readSession(metadata.id);
  const claimedLifecycle =
    latest?.lifecycle?.runnerToken === worker.token ? latest.lifecycle : metadata.lifecycle;
  const workerAlreadyFinished = Boolean(
    latest && new Set(["completed", "partial", "error", "cancelled"]).has(latest.status),
  );
  await sessionStore.updateSession(metadata.id, {
    lifecycle: {
      ...(claimedLifecycle ?? {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        reattachCommand: `oracle session ${metadata.id}`,
      }),
      runnerPid: worker.pid,
      runnerStartedAt: claimedLifecycle?.runnerStartedAt ?? new Date().toISOString(),
      runnerToken: worker.token,
      runnerState: workerAlreadyFinished ? "finished" : "recovering",
      runnerFinishedAt: workerAlreadyFinished
        ? (claimedLifecycle?.runnerFinishedAt ?? new Date().toISOString())
        : undefined,
    },
  });
  return worker;
}

export function isRecoverableOrphanedBrowserSession(
  metadata: SessionMetadata,
  processAlive: (pid?: number) => boolean = isProcessAlive,
): boolean {
  return classifyOrphanedBrowserSession(metadata, processAlive) === "recoverable";
}

export type OrphanedBrowserSessionState = "none" | "recoverable" | "failed-before-submit";

export function classifyOrphanedBrowserSession(
  metadata: SessionMetadata,
  processAlive: (pid?: number) => boolean = isProcessAlive,
  now: () => number = Date.now,
  preSubmitGraceMs = PRE_SUBMIT_ORPHAN_GRACE_MS,
): OrphanedBrowserSessionState {
  if (!new Set(["pending", "running"]).has(metadata.status) || metadata.mode !== "browser") {
    return "none";
  }
  const runtime = metadata.browser?.runtime;
  const durableRunnerPid = metadata.lifecycle?.runnerPid;
  const controllerPid = runtime?.controllerPid;
  if (durableRunnerPid && processAlive(durableRunnerPid)) return "none";
  if (controllerPid && controllerPid !== durableRunnerPid && processAlive(controllerPid)) {
    return "none";
  }
  const hasDurableLaunchIntent = Boolean(
    metadata.lifecycle?.runnerToken &&
    (metadata.lifecycle.runnerState === "launching" ||
      metadata.lifecycle.runnerState === "running" ||
      metadata.lifecycle.runnerState === "recovering"),
  );
  if (!durableRunnerPid && !controllerPid && !hasDurableLaunchIntent) return "none";

  if (!runtime?.promptSubmitted) {
    const startedAt =
      Date.parse(metadata.lifecycle?.runnerStartedAt ?? "") || Date.parse(metadata.createdAt);
    if (!Number.isFinite(startedAt) || now() - startedAt < preSubmitGraceMs) return "none";
    return "failed-before-submit";
  }
  const hasConversation = Boolean(
    runtime.tabUrl || runtime.conversationId || runtime.chromeTargetId || runtime.chromePort,
  );
  return hasConversation ? "recoverable" : "none";
}

export async function failOrphanedBrowserSessionBeforeSubmit(
  metadata: SessionMetadata,
): Promise<SessionMetadata> {
  const message =
    "Detached Oracle browser worker exited before prompt submission; refusing to resubmit automatically.";
  const completedAt = new Date().toISOString();
  if (metadata.model) {
    await sessionStore.updateModelRun(metadata.id, metadata.model, {
      status: "error",
      completedAt,
      response: { status: "error", incompleteReason: "worker-exited-before-submit" },
      error: { category: "session-lifecycle", message },
    });
  }
  return sessionStore.updateSession(metadata.id, {
    status: "error",
    completedAt,
    errorMessage: message,
    response: { status: "error", incompleteReason: "worker-exited-before-submit" },
    error: { category: "session-lifecycle", message },
  });
}
