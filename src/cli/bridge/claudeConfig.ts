import chalk from "chalk";
import { loadUserConfig } from "../../config.js";

export interface BridgeClaudeConfigCliOptions {
  printToken?: boolean;
}

export async function runBridgeClaudeConfig(options: BridgeClaudeConfigCliOptions): Promise<void> {
  const { config: userConfig } = await loadUserConfig();
  const snippet = formatClaudeMcpConfig({
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

export function formatClaudeMcpConfig({
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
  const env: Record<string, string> = {
    ORACLE_RELAY_URL: relayUrl ?? "https://relay.example.com",
    ORACLE_RELAY_TOKEN: includeToken ? (relayToken ?? "<YOUR_TOKEN>") : "<YOUR_TOKEN>",
  };
  if (operatorUrl) env.ORACLE_RELAY_OPERATOR_URL = operatorUrl;

  return JSON.stringify(
    {
      mcpServers: {
        dragon_relay: {
          type: "stdio",
          command: "dragon-relay-mcp",
          args: [],
          env,
        },
      },
    },
    null,
    2,
  );
}
