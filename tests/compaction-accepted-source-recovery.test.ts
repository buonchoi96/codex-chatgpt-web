import { expect, test } from "bun:test";
import type { CodexParsedRequest } from "../src/types";
import { extractChatGptCompactionSourceRevision } from "../src/adapters/chatgpt-web/environment";
import {
  bindAcceptedCompactionSource, ChatGptTextFeed, ChatGptTraceFeed,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";

function request(threadId: string, turnId: string, goalOnly = false): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/high", stream: false,
    context: { messages: [] }, options: { reasoning: "high" },
    _compactionRequest: goalOnly,
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId, turn_id: turnId,
      }) },
      input: [{
        type: "message", role: "user", id: goalOnly ? "goal-only" : "real-user-instruction",
        content: [{ type: "input_text", text: goalOnly
          ? '<codex_internal_context source="goal">Continue work</codex_internal_context>'
          : "Implement the authorized repository change." }],
      }],
    },
  };
}

function addAccepted(sessions: ChatGptTurnSessions, source: CodexParsedRequest, accepted = true): void {
  const body = source._rawBody as { client_metadata: Record<string,string> };
  const owner = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
  sessions.getOrCreate("source:" + owner.thread_id + ":" + owner.turn_id, () => ({
    mode: "read-only", browser: Promise.resolve("finished"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(), usageInput: source,
    submission: { phase: accepted ? "accepted" : "prepared" },
    cancel() {},
  }), undefined, undefined, owner.turn_id, owner.thread_id);
}

test("tool-only /goal compact reuses an accepted same-native-turn user instruction", () => {
  const sessions = new ChatGptTurnSessions();
  const source = request("native-thread-1", "native-turn-1");
  const compact = request("native-thread-1", "native-turn-1", true);
  addAccepted(sessions, source);
  expect(bindAcceptedCompactionSource(compact, sessions)).toBe(true);
  expect(extractChatGptCompactionSourceRevision(compact).content).toEqual(
    ((source._rawBody as any).input as any[])[0]!.content,
  );
});

test("unaccepted, cross-turn, cross-thread and different-effort sources cannot authorize compact", () => {
  for (const accepted of [false, true]) {
    const sessions = new ChatGptTurnSessions();
    addAccepted(sessions, request("thread-a", "turn-a"), accepted);
    for (const compact of [
      request("thread-a", "turn-b", true),
      request("thread-b", "turn-a", true),
      { ...request("thread-a", "turn-a", true), options: { reasoning: "medium" as const } },
    ]) {
      expect(bindAcceptedCompactionSource(compact, sessions)).toBe(false);
      expect(() => extractChatGptCompactionSourceRevision(compact)).toThrow();
    }
    if (!accepted) {
      const compact = request("thread-a", "turn-a", true);
      expect(bindAcceptedCompactionSource(compact, sessions)).toBe(false);
    }
  }
});

test("a real user message in compaction input wins over a retained source", () => {
  const sessions = new ChatGptTurnSessions();
  addAccepted(sessions, request("thread-a", "turn-a"));
  const compact = request("thread-a", "turn-a", true);
  ((compact._rawBody as any).input as any[]).push({
    type: "message", role: "user", id: "current-compact-user",
    content: [{ type: "input_text", text: "New genuine user instruction." }],
  });
  expect(bindAcceptedCompactionSource(compact, sessions)).toBe(true);
  expect(extractChatGptCompactionSourceRevision(compact).content).toEqual([
    { type: "input_text", text: "New genuine user instruction." },
  ]);
  expect(compact._trustedCompactionSource).toBeUndefined();
});
