import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MigratedRole = "user" | "assistant";

export interface MigratedMessage {
  role: MigratedRole;
  text: string;
}

export interface CodexSessionMigration {
  sourcePath: string;
  sessionId: string;
  cwd: string;
  messages: MigratedMessage[];
  prompt: string;
}

type JsonRecord = {
  type?: string;
  payload?: Record<string, unknown>;
};

const TRANSPORT_ONLY_MESSAGE =
  /(?:mcp__oracle__|mcp__dragon_relay__|ALL_TOOLS|functions\.exec|exec_command|\bMCP\b|\bconsult\b|deferred tools|命令执行工具|(?:shell|terminal).{0,20}(?:工具|入口)|filesystem 权限|工具(?:列表|入口|集)|无法实际运行.{0,30}dragon-relay|请挂载.{0,20}(?:终端|工具)|重启.{0,20}(?:看看|加载|MCP)|调用行吗|^用命令行来|^你有啊.{0,20}(?:检查|看看)|直接走命令行|切换为 CLI 路径)/iu;
const TRANSIENT_ASSISTANT_STATUS = /^(?:我现在提交|检查完成后|（正在)/u;

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";

  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseRecord(line: string): JsonRecord | null {
  try {
    return JSON.parse(line) as JsonRecord;
  } catch {
    return null;
  }
}

function isRulesSnapshot(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("# AGENTS.md instructions for ") ||
    /^<skill>\s*$/mu.test(trimmed) ||
    /^<environment_context>\s*$/mu.test(trimmed) ||
    /^<permissions instructions>\s*$/mu.test(trimmed)
  );
}

export function extractMigratableMessages(lines: string[], limit = 32): MigratedMessage[] {
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (parseRecord(lines[index] ?? "")?.type === "compacted") start = index + 1;
  }

  const messages: MigratedMessage[] = [];
  for (const line of lines.slice(start)) {
    const record = parseRecord(line);
    const payload = record?.payload;
    if (record?.type !== "response_item" || payload?.type !== "message") continue;

    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = textFromContent(payload.content).trim();
    if (!text || isRulesSnapshot(text)) continue;
    if (TRANSPORT_ONLY_MESSAGE.test(text)) continue;
    if (role === "assistant" && TRANSIENT_ASSISTANT_STATUS.test(text)) continue;
    messages.push({ role, text });
  }

  return messages.slice(-limit);
}

export function buildContinuationPrompt(sessionId: string, messages: MigratedMessage[]): string {
  const transcript = messages
    .map(({ role, text }) => `${role === "user" ? "用户" : "助手"}:\n${text}`)
    .join("\n\n");

  return [
    `继续 Codex 历史会话 ${sessionId} 的当前工作。`,
    "",
    "下面是可迁移的任务上下文。当前项目规则、代码状态和工具以本会话实际加载的内容为准。需要外部专家意见时，优先使用已加载的 Dragon Relay MCP 长阻塞调用；仅在 MCP 不可用时使用异步 dragon-relay CLI，并复用同一稳定 slug。",
    "",
    transcript || "用户希望继续此前未完成的工作；请先检查当前仓库状态并确认下一步。",
    "",
    "请从最后一条用户请求继续，先核对当前仓库状态，再执行尚未完成的工作。",
  ].join("\n");
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function findCodexRollout(sessionId: string, codexHome = defaultCodexHome()): string {
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsRoot)) {
    throw new Error(`Codex sessions directory not found: ${sessionsRoot}`);
  }

  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(candidate);
      } else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
        return candidate;
      }
    }
  }

  throw new Error(`Codex session not found: ${sessionId}`);
}

export function loadCodexSessionMigration(
  sessionId: string,
  options: { codexHome?: string; cwd?: string; messageLimit?: number } = {},
): CodexSessionMigration {
  const sourcePath = findCodexRollout(sessionId, options.codexHome);
  const lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/u).filter(Boolean);

  let storedCwd = "";
  for (const line of lines) {
    const record = parseRecord(line);
    if (record?.type !== "session_meta") continue;
    const cwd = record.payload?.cwd;
    if (typeof cwd === "string") storedCwd = cwd;
    break;
  }

  const cwd = options.cwd || storedCwd || process.cwd();
  const messages = extractMigratableMessages(lines, options.messageLimit);
  return {
    sourcePath,
    sessionId,
    cwd,
    messages,
    prompt: buildContinuationPrompt(sessionId, messages),
  };
}
