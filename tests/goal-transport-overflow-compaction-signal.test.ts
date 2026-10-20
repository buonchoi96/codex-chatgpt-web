import { expect, test } from "bun:test";
import { chatGptTransportBudgetFailure } from "../src/adapters/chatgpt-web/prompt";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

type Decision = Parameters<typeof chatGptTransportBudgetFailure>[0];
function decision(canonicalTokens: number, options: {
  choice?: "BLOCK" | "INLINE";
  accountLimit?: number;
} = {}): Decision {
  return {
    choice: options.choice ?? "BLOCK",
    reason: "canonical context exceeds measured account token budget",
    measurements: {
      canonicalTokens,
      accountCanonicalTokenLimit: options.accountLimit ?? 71_808,
    },
  } as Decision;
}

function originalNativeGoal(overrides: {
  compact?: boolean;
  history?: boolean;
} = {}): CodexParsedRequest {
  const goalMarker = "<goal_context>\n/goal: PURSUING\n</goal_context>";
  const messages = overrides.history === false
    ? [{ role: "user", content: [{ type: "text", text: goalMarker }] }]
    : [
      { role: "user", content: [{ type: "text", text: "Continue the installed goal." }] },
      { role: "assistant", content: [{ type: "text", text: "Work in progress." }] },
      { role: "toolResult", content: [{ type: "text", text: "Tool result persisted." }] },
      { role: "user", content: [{ type: "text", text: goalMarker }] },
    ];
  return {
    context: { messages },
    ...(overrides.compact ? { _compactionRequest: true } : {}),
  } as unknown as CodexParsedRequest;
}

test.each([78_468, 117_926])(
  "canonical overflow %d emits Codex-native context limit without changing PURSUING goal",
  canonicalTokens => {
    const parsed = originalNativeGoal();
    const before = structuredClone(parsed);
    const error = chatGptTransportBudgetFailure(decision(canonicalTokens), parsed);

    expect({ status: error.status, type: error.errorType, code: error.code, retryable: error.retryable })
      .toEqual({ status: 400, type: "invalid_request_error", code: "context_length_exceeded", retryable: false });
    expect(error.message).toStartWith("ChatGPT Web transport blocked:");
    expect(parsed).toEqual(before);
    expect(JSON.stringify(parsed)).toContain("/goal: PURSUING");
  },
);

test("no synthetic /compact on native compact request or source with no compactable history", () => {
  for (const parsed of [originalNativeGoal({ compact: true }), originalNativeGoal({ history: false })]) {
    expect(chatGptTransportBudgetFailure(decision(117_926), parsed).code)
      .toBe("context_transport_unsupported");
  }
});

test("below the canonical ceiling and unrelated composer failure remain non-compaction errors", () => {
  const goal = originalNativeGoal();
  expect(chatGptTransportBudgetFailure(decision(65_000), goal).code)
    .toBe("context_transport_unsupported");
  expect(chatGptTransportBudgetFailure(decision(78_468, { choice: "INLINE" }), goal).code)
    .toBe("context_transport_unsupported");
  expect(chatGptTransportBudgetFailure(decision(78_468, { accountLimit: 120_000 }), goal).code)
    .toBe("context_transport_unsupported");
});

test("Codex receives one terminal streamed context-limit error, not a fake completion or goal state change", async () => {
  async function* fail(): AsyncGenerator<AdapterEvent> {
    yield {
      type: "error",
      message: chatGptTransportBudgetFailure(decision(78_468), originalNativeGoal()).message,
      status: 400,
      errorType: "invalid_request_error",
      code: "context_length_exceeded",
      retryable: false,
    };
  }
  const body = await new Response(
    bridgeToResponsesSSE(fail(), "chatgpt-web/test", undefined, undefined, undefined, undefined,
      2_000, { streamPlatform: "win32" }),
  ).text();
  expect(body).toContain("event: response.failed");
  expect(body).toContain('"code":"context_length_exceeded"');
  expect(body).not.toContain("event: response.completed");
  expect(body).not.toContain('"/goal: COMPLETED"');
  expect(body).toEndWith("data: [DONE]\\n\\n".replaceAll("\\n", "\n"));
});
