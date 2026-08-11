export interface RelayCliInvocation {
  args: string[];
  command: "ask" | "wait" | "status" | "serve";
}

export const RELAY_CLI_USAGE = `Usage:
  dragon-relay ask [options]                Submit a Relay task (async by default)
  dragon-relay wait <session-id> [options]  Check once; render if complete
  dragon-relay status [options]             List durable sessions
  dragon-relay serve [options]              Run the Relay server and operator UI`;

export function buildRelayCliInvocation(argv: string[]): RelayCliInvocation {
  const [command, ...rest] = argv;

  if (command === "ask") {
    return { command, args: ["--engine", "relay", ...rest] };
  }

  if (command === "wait") {
    const [id, ...extra] = rest;
    if (!id) throw new Error(RELAY_CLI_USAGE);
    return { command, args: ["session", id, ...extra] };
  }

  if (command === "status") {
    return { command, args: ["status", ...rest] };
  }

  if (command === "serve") return { command, args: ["relay-serve", ...rest] };

  throw new Error(RELAY_CLI_USAGE);
}
