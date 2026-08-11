import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { formatClaudeMcpConfig } from "../../src/cli/bridge/claudeConfig.ts";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("formatClaudeMcpConfig", () => {
  test("prints a Dragon Relay MCP config without exposing tokens by default", () => {
    const parsed = JSON.parse(
      formatClaudeMcpConfig({
        relayUrl: "https://relay.example.com",
        relayToken: "secret-token",
        operatorUrl: "https://relay.example.com/operator",
        includeToken: false,
      }),
    );

    expect(parsed.mcpServers.dragon_relay).toMatchObject({
      type: "stdio",
      command: "dragon-relay-mcp",
      args: [],
    });
    expect(parsed.mcpServers.dragon_relay.env).toEqual({
      ORACLE_RELAY_URL: "https://relay.example.com",
      ORACLE_RELAY_TOKEN: "<YOUR_TOKEN>",
      ORACLE_RELAY_OPERATOR_URL: "https://relay.example.com/operator",
    });
  });

  test("can include the configured producer token", () => {
    const parsed = JSON.parse(
      formatClaudeMcpConfig({
        relayUrl: "https://relay.example.com",
        relayToken: "secret-token",
        includeToken: true,
      }),
    );

    expect(parsed.mcpServers.dragon_relay.env).toEqual({
      ORACLE_RELAY_URL: "https://relay.example.com",
      ORACLE_RELAY_TOKEN: "secret-token",
    });
  });

  test("prints CLI config as parseable stdout JSON", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-claude-config-"));
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "bridge", "claude-config", "--print-token"],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, "--disable-warning=DEP0205"]
              .filter(Boolean)
              .join(" "),
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_HOME_DIR: oracleHome,
            ORACLE_RELAY_URL: "https://relay.example.com",
            ORACLE_RELAY_TOKEN: "relay-secret",
          },
        },
      );

      const parsed = JSON.parse(stdout);
      expect(stderr.trim()).toBe("");
      expect(parsed.mcpServers.dragon_relay.env).toEqual({
        ORACLE_RELAY_URL: "https://relay.example.com",
        ORACLE_RELAY_TOKEN: "relay-secret",
      });
    } finally {
      await rm(oracleHome, { recursive: true, force: true });
    }
  }, 15_000);
});
