import chalk from "chalk";
import { loadUserConfig } from "../../config.js";

export interface BridgeCodexConfigCliOptions {
  printToken?: boolean;
}

export async function runBridgeCodexConfig(options: BridgeCodexConfigCliOptions): Promise<void> {
  const { config: userConfig } = await loadUserConfig();
  const snippet = formatCodexMcpSnippet({
    relayUrl: process.env.ORACLE_RELAY_URL ?? userConfig.relay?.url,
    relayToken: process.env.ORACLE_RELAY_TOKEN ?? userConfig.relay?.token,
    operatorUrl: process.env.ORACLE_RELAY_OPERATOR_URL ?? userConfig.relay?.operatorUrl,
    includeToken: Boolean(options.printToken),
  });

  console.log(snippet);
  if (!options.printToken) {
    console.error("");
    console.error(
      chalk.dim("Tip: rerun with --print-token to include ORACLE_RELAY_TOKEN in the snippet."),
    );
  }
}

export function formatCodexMcpSnippet({
  relayUrl,
  relayToken,
  operatorUrl,
  includeToken,
}: {
  relayUrl?: string;
  relayToken?: string;
  operatorUrl?: string;
  includeToken: boolean;
}): string {
  const urlValue = relayUrl ?? "https://relay.example.com";
  const tokenValue = includeToken ? (relayToken ?? "<YOUR_TOKEN>") : "<YOUR_TOKEN>";
  const env = [
    `ORACLE_RELAY_URL = "${escapeTomlString(urlValue)}"`,
    `ORACLE_RELAY_TOKEN = "${escapeTomlString(tokenValue)}"`,
    operatorUrl ? `ORACLE_RELAY_OPERATOR_URL = "${escapeTomlString(operatorUrl)}"` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  return [
    "# ~/.codex/config.toml",
    "",
    "[mcp_servers.dragon_relay]",
    'command = "dragon-relay-mcp"',
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 90000",
    `env = { ${env} }`,
  ].join("\n");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
