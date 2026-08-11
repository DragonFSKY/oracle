#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildRelayCliInvocation, RELAY_CLI_USAGE } from "../src/relay/cliFacade.js";

try {
  if (process.argv.length === 2 || process.argv[2] === "--help" || process.argv[2] === "-h") {
    console.log(RELAY_CLI_USAGE);
    process.exit(0);
  }
  const invocation = buildRelayCliInvocation(process.argv.slice(2));
  const oracleEntry = fileURLToPath(new URL("./oracle-cli.js", import.meta.url));
  const child = spawn(process.execPath, [oracleEntry, ...invocation.args], {
    env: {
      ...process.env,
      ORACLE_CLI_NAME: "dragon-relay",
      ORACLE_SESSION_COMMAND: "dragon-relay wait",
    },
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`dragon-relay failed: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
