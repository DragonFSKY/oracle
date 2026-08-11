import { describe, expect, it } from "vitest";
import {
  isPromptSubmissionPayloadForTest,
  summarizeDeepResearchRequestForTest,
} from "../../src/browser/actions/deepResearchRequest.js";

describe("Deep Research request evidence", () => {
  it("ignores non-submission conversation POSTs without messages", () => {
    expect(isPromptSubmissionPayloadForTest(undefined)).toBe(false);
    expect(isPromptSubmissionPayloadForTest("{}")).toBe(false);
    expect(isPromptSubmissionPayloadForTest(JSON.stringify({ messages: [] }))).toBe(false);
    expect(isPromptSubmissionPayloadForTest(JSON.stringify({ messages: [{ content: {} }] }))).toBe(
      true,
    );
  });

  it("does not treat prompt wording as a transport marker", () => {
    const evidence = summarizeDeepResearchRequestForTest(
      "https://chatgpt.com/backend-api/conversation",
      JSON.stringify({
        model: "gpt-5-6-thinking",
        conversation_mode: { kind: "primary_assistant" },
        messages: [{ content: { parts: ["Use Deep Research with private resume text"] } }],
        attachments: [{ name: "resume.pdf" }],
      }),
    );
    expect(evidence).toEqual({
      requestPath: "/backend-api/conversation",
      fields: {
        model: "gpt-5-6-thinking",
        conversation_mode: { kind: "primary_assistant" },
      },
      hasDeepResearchMarker: false,
    });
    expect(JSON.stringify(evidence)).not.toContain("private resume text");
    expect(JSON.stringify(evidence)).not.toContain("resume.pdf");
  });

  it("recognizes an explicit Deep Research transport binding", () => {
    const evidence = summarizeDeepResearchRequestForTest(
      "https://chatgpt.com/backend-api/f/conversation?temporary-chat=false",
      JSON.stringify({
        model: "auto",
        conversation_mode: { kind: "deep_research" },
        tools: [{ type: "connector_openai_deep_research" }],
      }),
    );
    expect(evidence.requestPath).toBe("/backend-api/f/conversation");
    expect(evidence.hasDeepResearchMarker).toBe(true);
    expect(evidence.fields).toMatchObject({
      conversation_mode: { kind: "deep_research" },
      tools: [{ type: "connector_openai_deep_research" }],
    });
  });

  it("reads only research-related message metadata and excludes message content", () => {
    const evidence = summarizeDeepResearchRequestForTest(
      "https://chatgpt.com/backend-api/f/conversation",
      JSON.stringify({
        model: "gpt-5-5",
        conversation_mode: { kind: "gizmo_interaction", gizmo_id: "g-public" },
        messages: [
          {
            content: { parts: ["private prompt"] },
            metadata: {
              system_hints: ["plugin:connector_openai_deep_research"],
              serialization_metadata: { custom_symbol_offsets: [{ start: 0, end: 4 }] },
              unrelated_private_value: "must stay hidden",
            },
          },
        ],
      }),
    );
    expect(evidence.hasDeepResearchMarker).toBe(true);
    expect(evidence.fields["messages[0].metadata.system_hints"]).toEqual([
      "plugin:connector_openai_deep_research",
    ]);
    expect(JSON.stringify(evidence)).not.toContain("private prompt");
    expect(JSON.stringify(evidence)).not.toContain("must stay hidden");
    expect(JSON.stringify(evidence)).not.toContain("custom_symbol_offsets");
  });
});
