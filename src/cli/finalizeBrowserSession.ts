import type { ChatGptTabSummary } from "../browser/liveTabs.js";
import { isRecoveredConversationHarvestReady } from "../browser/recoverConversation.js";
import { ensureSessionArtifacts } from "../browser/sessionRunner.js";
import type { BrowserLogger } from "../browser/types.js";
import { estimateTokenCount } from "../browser/utils.js";
import type { SessionMetadata } from "../sessionManager.js";
import { sessionStore } from "../sessionStore.js";
import { closeTab } from "../browser/chromeLifecycle.js";

export function harvestedAnswerIsCurrent(
  harvested: ChatGptTabSummary,
  requireCompletedDeepResearch = false,
): boolean {
  if (harvested.state !== "completed" || harvested.stopExists) return false;
  if (requireCompletedDeepResearch && !harvested.deepResearchCompleted) return false;
  if (harvested.deepResearchDetected && !harvested.deepResearchCompleted) return false;
  if (!harvested.deepResearchCompleted && harvested.completionStable !== true) return false;
  const answer = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
  return Boolean(answer.trim() && isRecoveredConversationHarvestReady(harvested));
}

export async function finalizeRecoveredBrowserSession(
  metadata: SessionMetadata,
  harvested: ChatGptTabSummary,
): Promise<SessionMetadata | null> {
  const latest = (await sessionStore.readSession(metadata.id)) ?? metadata;
  const requireCompletedDeepResearch = latest.browser?.config?.researchMode === "deep";
  if (!harvestedAnswerIsCurrent(harvested, requireCompletedDeepResearch)) return null;
  const answer = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
  if (latest.status === "completed") return latest;

  const logger = Object.assign((_message: string) => {}, {}) as BrowserLogger;
  const artifacts = await ensureSessionArtifacts({
    sessionId: latest.id,
    prompt: latest.options.prompt ?? latest.promptPreview ?? "",
    answerMarkdown: answer,
    conversationUrl: harvested.url || latest.browser?.runtime?.tabUrl,
    browserConfig: latest.browser?.config ?? {},
    existingArtifacts: latest.artifacts,
    logger,
  });
  const outputTokens = estimateTokenCount(answer);
  const inputTokens = latest.usage?.inputTokens ?? 0;
  const reasoningTokens = latest.usage?.reasoningTokens ?? 0;
  const usage = {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    cost: latest.usage?.cost,
  };
  const completedAt = new Date().toISOString();
  if (latest.model) {
    await sessionStore.updateModelRun(latest.id, latest.model, {
      status: "completed",
      completedAt,
      usage,
      response: { status: "completed" },
      error: undefined,
    });
  }
  const existingLog = await sessionStore.readLog(latest.id).catch(() => "");
  if (!existingLog.includes("[browser-recovery] captured completed assistant response")) {
    const logWriter = sessionStore.createLogWriter(latest.id);
    logWriter.logLine("[browser-recovery] captured completed assistant response from existing tab");
    logWriter.logLine("Answer:");
    logWriter.logLine(answer);
    await new Promise<void>((resolve, reject) => {
      logWriter.stream.once("error", reject);
      logWriter.stream.end(resolve);
    });
  }
  const completed = await sessionStore.updateSession(latest.id, {
    status: "completed",
    completedAt,
    usage,
    artifacts,
    response: { status: "completed" },
    errorMessage: undefined,
    error: undefined,
    lifecycle: latest.lifecycle
      ? {
          ...latest.lifecycle,
          runnerState: "finished",
          runnerFinishedAt: completedAt,
        }
      : undefined,
  });
  await closeFinalizedBrowserTarget(latest, harvested, logger);
  terminateFinalizedBrowserWorker(latest);
  return completed;
}

async function closeFinalizedBrowserTarget(
  metadata: SessionMetadata,
  harvested: ChatGptTabSummary,
  logger: BrowserLogger,
): Promise<boolean> {
  const config = metadata.browser?.config;
  const runtime = metadata.browser?.runtime;
  if (
    config?.newWindow !== true ||
    config.keepBrowser === true ||
    !runtime?.chromePort ||
    !runtime.chromeTargetId ||
    runtime.chromeTargetId !== harvested.targetId
  ) {
    return false;
  }
  return closeTab(runtime.chromePort, runtime.chromeTargetId, logger, runtime.chromeHost).catch(
    () => false,
  );
}

export function terminateFinalizedBrowserWorker(
  metadata: SessionMetadata,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): boolean {
  const pid = metadata.lifecycle?.runnerPid;
  const controllerPid = metadata.browser?.runtime?.controllerPid;
  const activeState = metadata.lifecycle?.runnerState;
  if (
    !pid ||
    pid === process.pid ||
    controllerPid !== pid ||
    !metadata.lifecycle?.runnerToken ||
    !["launching", "running", "recovering"].includes(activeState ?? "")
  ) {
    return false;
  }
  try {
    kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
