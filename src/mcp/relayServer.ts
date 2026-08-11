#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getCliVersion } from "../version.js";
import { registerRelayExpertTools } from "./relayTools.js";

export async function startDragonRelayMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: "dragon-relay-mcp", version: getCliVersion() },
    { capabilities: { logging: {} } },
  );
  registerRelayExpertTools(server);
  const transport = new StdioServerTransport();
  transport.onerror = (error) => console.error("Dragon Relay MCP transport error:", error);
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}

export function shouldStartDragonRelayMcpFromModule(
  moduleUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): boolean {
  return argv1 ? moduleUrl === pathToFileURL(argv1).href : false;
}

if (shouldStartDragonRelayMcpFromModule()) {
  startDragonRelayMcpServer().catch((error) => {
    console.error("Failed to start dragon-relay-mcp:", error);
    process.exitCode = 1;
  });
}
