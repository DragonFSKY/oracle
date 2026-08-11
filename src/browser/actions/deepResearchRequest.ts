import type Protocol from "devtools-protocol";
import type { BrowserLogger, ChromeClient } from "../types.js";

const conversationRequestPattern = /\/backend-api\/(?:f\/)?conversation(?:\/|$|\?)/i;
const evidenceKeyPattern =
  /(?:model|mode|tool|research|feature|paragen|reasoning|hint|plugin|connector)/i;
const sensitiveKeyPattern = /(?:message|content|prompt|attachment|file|text|author)/i;
const deepResearchPattern =
  /deep[\s_-]*research|research[_-](?:mode|tool)|connector_openai_deep_research/i;

export interface DeepResearchRequestEvidence {
  requestPath: string;
  fields: Readonly<Record<string, unknown>>;
  hasDeepResearchMarker: boolean;
}

export interface DeepResearchRequestProbe {
  wait(timeoutMs?: number): Promise<DeepResearchRequestEvidence | null>;
  dispose(): void;
}

export function createDeepResearchRequestProbe(
  Network: ChromeClient["Network"],
  logger: BrowserLogger,
): DeepResearchRequestProbe {
  if (!Network || typeof Network.requestWillBeSent !== "function") {
    return {
      async wait() {
        return null;
      },
      dispose() {},
    };
  }
  let evidence: DeepResearchRequestEvidence | null = null;
  let resolvePending: ((value: DeepResearchRequestEvidence | null) => void) | null = null;
  let disposed = false;
  const unsubscribe = Network.requestWillBeSent((event) => {
    if (
      disposed ||
      evidence ||
      !isConversationPost(event) ||
      !isPromptSubmissionPayload(event.request.postData)
    ) {
      return;
    }
    evidence = summarizeDeepResearchRequest(event.request.url, event.request.postData);
    logger(
      `Deep Research request payload: marker=${evidence.hasDeepResearchMarker ? "yes" : "no"} ` +
        `fields=${JSON.stringify(evidence.fields)}`,
    );
    resolvePending?.(evidence);
    resolvePending = null;
  });

  return {
    async wait(timeoutMs = 5_000) {
      if (evidence || disposed) return evidence;
      return await new Promise<DeepResearchRequestEvidence | null>((resolve) => {
        const timer = setTimeout(
          () => {
            if (resolvePending === complete) resolvePending = null;
            resolve(null);
          },
          Math.max(0, timeoutMs),
        );
        const complete = (value: DeepResearchRequestEvidence | null) => {
          clearTimeout(timer);
          resolve(value);
        };
        resolvePending = complete;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      resolvePending?.(evidence);
      resolvePending = null;
    },
  };
}

function isConversationPost(event: Protocol.Network.RequestWillBeSentEvent): boolean {
  return (
    event.request.method.toUpperCase() === "POST" &&
    conversationRequestPattern.test(event.request.url)
  );
}

function isPromptSubmissionPayload(postData?: string): boolean {
  if (!postData) return false;
  try {
    const parsed = JSON.parse(postData) as unknown;
    return isRecord(parsed) && Array.isArray(parsed.messages) && parsed.messages.length > 0;
  } catch {
    return false;
  }
}

function summarizeDeepResearchRequest(url: string, postData?: string): DeepResearchRequestEvidence {
  const fields: Record<string, unknown> = {};
  let parsed: unknown = null;
  try {
    parsed = postData ? JSON.parse(postData) : null;
  } catch {
    parsed = null;
  }
  if (isRecord(parsed)) collectEvidenceFields(parsed, fields);
  return {
    requestPath: safeRequestPath(url),
    fields,
    hasDeepResearchMarker: deepResearchPattern.test(JSON.stringify(fields)),
  };
}

function collectEvidenceFields(
  value: Record<string, unknown>,
  output: Record<string, unknown>,
): void {
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) continue;
    if (!evidenceKeyPattern.test(key)) continue;
    output[key] = sanitizeEvidenceValue(entry, 0);
  }
  if (Array.isArray(value.messages)) {
    value.messages.slice(0, 4).forEach((message, index) => {
      if (!isRecord(message) || !isRecord(message.metadata)) return;
      collectNestedEvidenceFields(message.metadata, `messages[${index}].metadata`, output, 0);
    });
  }
}

function collectNestedEvidenceFields(
  value: Record<string, unknown>,
  prefix: string,
  output: Record<string, unknown>,
  depth: number,
): void {
  if (depth >= 4) return;
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) continue;
    const path = `${prefix}.${key}`;
    if (evidenceKeyPattern.test(key)) {
      output[path] = sanitizeEvidenceValue(entry, depth);
      continue;
    }
    if (isRecord(entry)) collectNestedEvidenceFields(entry, path, output, depth + 1);
  }
}

function sanitizeEvidenceValue(value: unknown, depth: number): unknown {
  if (depth >= 3) return describeValue(value);
  if (typeof value === "string") return value.slice(0, 160);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value))
    return value.slice(0, 12).map((entry) => sanitizeEvidenceValue(entry, depth + 1));
  if (!isRecord(value)) return describeValue(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveKeyPattern.test(key))
      .slice(0, 24)
      .map(([key, entry]) => [key, sanitizeEvidenceValue(entry, depth + 1)]),
  );
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (isRecord(value)) return `[object:${Object.keys(value).length}]`;
  return `[${typeof value}]`;
}

function safeRequestPath(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname;
  } catch {
    return "unknown";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function summarizeDeepResearchRequestForTest(
  url: string,
  postData?: string,
): DeepResearchRequestEvidence {
  return summarizeDeepResearchRequest(url, postData);
}

export function isPromptSubmissionPayloadForTest(postData?: string): boolean {
  return isPromptSubmissionPayload(postData);
}
