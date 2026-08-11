#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { loadCodexSessionMigration } from "../src/codex/sessionMigration.js";

function usage(): never {
  console.error(
    "Usage: dragon-relay-continue <codex-session-id> [--cd <directory>] [--print] [--check]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const sessionId = args.shift();
if (!sessionId) usage();

let cwd: string | undefined;
let printOnly = false;
let checkOnly = false;
while (args.length > 0) {
  const arg = args.shift();
  if (arg === "--print") {
    printOnly = true;
  } else if (arg === "--check") {
    checkOnly = true;
  } else if (arg === "--cd") {
    cwd = args.shift();
    if (!cwd) usage();
  } else {
    usage();
  }
}

try {
  const migration = loadCodexSessionMigration(sessionId, { cwd });
  const prompt = checkOnly
    ? `${migration.prompt}\n\n本轮只做 CLI 恢复验证，不继续原任务，也不发起 live：必须实际运行 pwd、command -v dragon-relay、dragon-relay --help，并执行一个最小 dragon-relay ask --dry-run json。最后报告真实命令结果。`
    : migration.prompt;
  if (printOnly) {
    process.stdout.write(`${prompt}\n`);
    process.exit(0);
  }

  console.error(`🧿 Continuing ${sessionId} in a clean Codex session (${migration.cwd})`);
  const child = spawn("codex", ["-C", migration.cwd, prompt], {
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`Failed to start Codex: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`Codex exited after signal ${signal}`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
