import { describe, expect, test } from "vitest";
import {
  buildContinuationPrompt,
  extractMigratableMessages,
} from "../../src/codex/sessionMigration.js";

function message(role: "user" | "assistant" | "developer", text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
}

describe("Codex session migration", () => {
  test("keeps the latest user/assistant task context without old transport diagnostics", () => {
    const lines = [
      message("user", "旧窗口内容"),
      JSON.stringify({ type: "compacted", payload: {} }),
      message("developer", "内部规则"),
      message("user", "继续专家复审"),
      message("assistant", "当前工具列表未挂载 mcp__oracle__consult"),
      message("assistant", "本地 2531 个测试已经通过。"),
      message("user", "就用 consult"),
      message("user", "继续"),
    ];

    expect(extractMigratableMessages(lines)).toEqual([
      { role: "user", text: "继续专家复审" },
      { role: "assistant", text: "本地 2531 个测试已经通过。" },
      { role: "user", text: "继续" },
    ]);
  });

  test("does not carry an injected AGENTS snapshot", () => {
    const lines = [
      message("user", "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>old</INSTRUCTIONS>"),
      message("user", "继续当前任务"),
    ];
    expect(extractMigratableMessages(lines)).toEqual([{ role: "user", text: "继续当前任务" }]);
  });

  test("drops injected skill/environment snapshots and repeated missing-shell claims", () => {
    const lines = [
      message("user", "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"),
      message("user", "<skill>\n<name>ask-pro</name>\nold injected body\n</skill>"),
      message("assistant", "当前会话没有命令执行工具，无法实际运行 dragon-relay。"),
      message("assistant", "仅提供 filesystem 权限，不等于 shell/terminal 工具入口。"),
      message("user", "用命令行来  $ask-pro"),
      message("user", "你有啊 你再次检查"),
      message("assistant", "好，直接走命令行：读取最新 Skill。"),
      message("user", "$ask-pro 重新分析最新修复"),
      message("assistant", "本地修复和测试证据已经准备完成。"),
    ];

    expect(extractMigratableMessages(lines)).toEqual([
      { role: "user", text: "$ask-pro 重新分析最新修复" },
      { role: "assistant", text: "本地修复和测试证据已经准备完成。" },
    ]);
  });

  test("builds a concise prompt that prefers the blocking Relay MCP", () => {
    const prompt = buildContinuationPrompt("session-1", [{ role: "user", text: "继续" }]);
    expect(prompt).toContain("Dragon Relay MCP 长阻塞调用");
    expect(prompt).toContain("dragon-relay CLI");
    expect(prompt).toContain("用户:\n继续");
    expect(prompt).not.toContain("mcp__oracle__");
    expect(prompt).not.toContain("ALL_TOOLS");
  });
});
