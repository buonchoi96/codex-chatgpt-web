import { expect, test } from "bun:test";
import { submittedTurnFailureCause } from "../src/adapters/chatgpt-web";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

test("submitted-turn diagnostics classify internal observer failures without echoing payloads", () => {
  expect(submittedTurnFailureCause(
    new Error("ChatGPT browser Markdown stream did not reproduce the completed answer"),
  )).toBe("browser_markdown_mismatch");
  expect(submittedTurnFailureCause(
    new Error("ChatGPT Native2 final output conflicts with the browser-verified final answer"),
  )).toBe("native_output_conflict");
  expect(submittedTurnFailureCause(
    new Error("Codex returned 1 of 3 results for a parallel ChatGPT tool batch"),
  )).toBe("partial_parallel_tool_results");
  expect(submittedTurnFailureCause(
    new Error("ChatGPT bridge tool result does not match an outstanding call: SECRET_CALL_ID"),
  )).toBe("tool_result_not_outstanding");
  expect(submittedTurnFailureCause(new DOMException("private abort detail", "AbortError")))
    .toBe("observer_abort");
  expect(submittedTurnFailureCause(new Error("SECRET_USER_CONTROLLED_DETAIL")))
    .toBe("unclassified_internal_error");
  expect(submittedTurnFailureCause(new ChatGptWebAdapterError("private", {
    status: 502,
    errorType: "server_error",
    code: "known_code",
    retryable: true,
  }))).toBe("adapter_known_code");
});
