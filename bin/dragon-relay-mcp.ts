#!/usr/bin/env node
import { startDragonRelayMcpServer } from "../src/mcp/relayServer.js";

startDragonRelayMcpServer().catch((error) => {
  console.error("Failed to start dragon-relay-mcp:", error);
  process.exitCode = 1;
});
