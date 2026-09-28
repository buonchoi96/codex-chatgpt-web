import { expect, test } from "bun:test";
import {
  brokerToolResultDiagnostic,
  type BrokerToolRequest,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";

const waitRequest: BrokerToolRequest = {
  callId: "call_wait_123",
  wireName: "multi_agent_v1__wait_agent",
  freeform: false,
  arguments: { targets: ["agent-1"], timeout_ms: 30_000 },
};

test("wait_agent diagnostics prove child final payload presence without logging its content", () => {
  const childFinal = "SECRET_CHILD_FINDINGS_".repeat(20);
  const payload = {
    status: {
      "agent-1": { completed: childFinal },
      "agent-2": { completed: null },
      "agent-3": { errored: "private error detail" },
      "agent-4": "not_found",
    },
    timed_out: false,
  };
  const result: BrokerToolResult = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
  const diagnostic = brokerToolResultDiagnostic(waitRequest, result);
  expect(diagnostic).toEqual({
    wireName: "multi_agent_v1__wait_agent",
    contentItems: 1,
    textChars: JSON.stringify(payload).length,
    structured: true,
    isError: false,
    waitPayloadParsed: true,
    timedOut: false,
    statusEntries: 4,
    completedEntries: 2,
    completedWithMessage: 1,
    completedMessageChars: childFinal.length,
    erroredEntries: 1,
    notFoundEntries: 1,
    otherTerminalEntries: 0,
  });
  expect(JSON.stringify(diagnostic)).not.toContain(childFinal);
  expect(JSON.stringify(diagnostic)).not.toContain("private error detail");
});

test("wait_agent diagnostics can parse the native text result when structuredContent is absent", () => {
  const payload = { status: { "agent-1": { completed: "done" } }, timed_out: false };
  const diagnostic = brokerToolResultDiagnostic(waitRequest, {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });
  expect(diagnostic?.waitPayloadParsed).toBeTrue();
  expect(diagnostic?.completedMessageChars).toBe(4);
  expect(diagnostic?.structured).toBeFalse();
});

test("ordinary tool results do not create extra payload telemetry", () => {
  expect(brokerToolResultDiagnostic(
    { ...waitRequest, wireName: "exec_command" },
    { content: [{ type: "text", text: "sensitive output" }] },
  )).toBeUndefined();
});
