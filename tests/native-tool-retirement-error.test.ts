import { expect, test } from "bun:test";
import { ChatGptWebAdapterError, chatGptToolTimeoutError } from "../src/adapters/chatgpt-web/adapter-error";
import { submittedTurnFailure } from "../src/adapters/chatgpt-web";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";

function session(progress: ChatGptExternalTurnProgress): ChatGptTurnSession {
  return new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("test-only-token"), externalProgress: progress,
    browser: Promise.resolve("browser answer"), physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    submission: { phase: "accepted" }, cancel() {},
  });
}

test("a same-turn native command timeout is not mislabeled as ChatGPT stopped responding", () => {
  const progress = new ChatGptExternalTurnProgress();
  const timeout = chatGptToolTimeoutError("exec_command", 90_000);
  progress.retire(timeout);
  const diagnostic = submittedTurnFailure(session(progress),
    new DOMException("ChatGPT web turn aborted", "AbortError"));
  expect(diagnostic).toBe(timeout);
  expect((diagnostic as ChatGptWebAdapterError).code).toBe("codex_tool_timeout");
  expect(diagnostic.message).toContain("90 seconds");
  expect(diagnostic.message).toContain("Check whether the command is still running");
});

test("submitted turn with no proven broker retirement keeps its previous conservative error", () => {
  const diagnostic = submittedTurnFailure(session(new ChatGptExternalTurnProgress()),
    new DOMException("ChatGPT web turn aborted", "AbortError"));
  expect(diagnostic).toBeInstanceOf(ChatGptWebAdapterError);
  expect((diagnostic as ChatGptWebAdapterError).code).toBe("chatgpt_submitted_turn_failed");
});

test("specific response errors outrank independent broker retirement", () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.retire(chatGptToolTimeoutError("exec_command", 90_000));
  const responseFailure = new ChatGptWebAdapterError("Browser reported a real context error", {
    status: 413, errorType: "browser_transport_error", code: "message_length_exceeds_limit", retryable: false,
  });
  expect(submittedTurnFailure(session(progress), responseFailure)).toBe(responseFailure);
});
