import { expect, test } from "bun:test";
import { RetainedConversationProofStore } from "../src/adapters/chatgpt-web/retained-followup-proof";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import type { CodexParsedRequest } from "../src/types";

function request(): CodexParsedRequest {
  return { modelId: "gpt-5.6-luna", stream: true, options: { reasoning: "low" },
    context: { systemPrompt: ["Native policy"], messages: [{ role: "user", content: "Read A", timestamp: 1 }] },
    _rawBody: { input: [], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-A", turn_id: "turn-A" }) } } };
}
function followup(source: CodexParsedRequest): CodexParsedRequest {
  const next = structuredClone(source);
  next.context.messages.push({ role: "assistant", content: [{ type: "text", text: "A verified" }], timestamp: 2 },
    { role: "user", content: "Now B", timestamp: 3 });
  return next;
}
test("Luna canonical suffix requires exact completed ancestry and retains current policy", () => {
  const store = new RetainedConversationProofStore();
  const source = request(), next = followup(source), key = chatGptConversationKey(source, "profile")!;
  expect(store.resume(key, next)).toBeUndefined();
  store.commit(key, source, "A verified");
  expect(store.resume(key, next)?.context.messages).toEqual(next.context.messages.slice(2));
  expect(store.resume(key, next)?.context.systemPrompt).toEqual(["Native policy"]);
  next.context.messages[0]!.content = "Changed prior request";
  expect(store.resume(key, next)).toBeUndefined();
});
test("foreign assistant, changed policy, tool boundary and expired proof invalidate reuse", () => {
  let now = 1;
  const store = new RetainedConversationProofStore(() => now);
  const source = request(), key = chatGptConversationKey(source, "profile")!;
  store.commit(key, source, "A verified");
  const foreign = followup(source);
  foreign.context.messages[1]!.content = [{ type: "text", text: "Manual assistant" }];
  expect(store.resume(key, foreign)).toBeUndefined();
  const policy = followup(source); policy.context.systemPrompt = ["Changed policy"];
  expect(store.resume(key, policy)).toBeUndefined();
  const tools = followup(source);
  tools.context.messages[1]!.content = [{ type: "toolCall", id: "pending", name: "exec", arguments: {} }];
  expect(store.resume(key, tools)).toBeUndefined();
  now += 31 * 60_000;
  expect(store.resume(key, followup(source))).toBeUndefined();
});
test("canonical timestamp changes do not invalidate exact semantic history; bounded store isolates keys", () => {
  const store = new RetainedConversationProofStore();
  const source = request(), key = chatGptConversationKey(source, "profile")!;
  store.commit(key, source, "A verified");
  const next = followup(source); next.context.messages[0]!.timestamp = 100;
  expect(store.resume(key, next)).toBeDefined();
  expect(store.resume("other-key", next)).toBeUndefined();
  for (let i = 0; i < 513; i++) store.commit(`key-${i}`, source, "A verified");
  expect(store.resume(key, next)).toBeUndefined();
});

test("a matching final answer cannot authorize skipping uncommitted user or tool evidence", () => {
  const store = new RetainedConversationProofStore();
  const source = request(), key = chatGptConversationKey(source, "profile")!;
  store.commit(key, source, "A verified");
  for (const message of [
    { role: "user" as const, content: "Foreign manual turn", timestamp: 4 },
    { role: "toolResult" as const, toolCallId: "missing", toolName: "exec", content: "Uncommitted result", isError: false, timestamp: 4 },
  ]) {
    const next = followup(source);
    next.context.messages.splice(1, 0, message);
    expect(store.resume(key, next)).toBeUndefined();
  }
});
