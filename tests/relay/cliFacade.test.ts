import { describe, expect, test } from "vitest";
import { buildRelayCliInvocation } from "../../src/relay/cliFacade.js";

describe("dragon-relay CLI facade", () => {
  test("routes ask through the Relay engine", () => {
    expect(buildRelayCliInvocation(["ask", "--prompt", "review", "--dry-run", "json"])).toEqual({
      command: "ask",
      args: ["--engine", "relay", "--prompt", "review", "--dry-run", "json"],
    });
  });

  test("routes wait to the durable session command", () => {
    expect(buildRelayCliInvocation(["wait", "review-123", "--render"])).toEqual({
      command: "wait",
      args: ["session", "review-123", "--render"],
    });
  });

  test("routes status and server options", () => {
    expect(buildRelayCliInvocation(["status", "--hours", "72"])).toEqual({
      command: "status",
      args: ["status", "--hours", "72"],
    });
    expect(buildRelayCliInvocation(["serve", "--port", "9474"])).toEqual({
      command: "serve",
      args: ["relay-serve", "--port", "9474"],
    });
  });

  test("rejects incomplete commands", () => {
    expect(() => buildRelayCliInvocation(["wait"])).toThrow(/Usage/u);
    expect(() => buildRelayCliInvocation([])).toThrow(/Usage/u);
  });
});
