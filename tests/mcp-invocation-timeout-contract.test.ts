import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS } from "../src/adapters/chatgpt-web/mcp-server";

test("MCP response timeout preserves delivered native work and exposes a result poll path", () => {
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBe(90_000);
  const source = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");

  // Undelivered calls are still the only calls safe to retract/retry.
  expect(source).toContain('method: "cancel_invoke"');
  expect(source).toContain('code: "codex_tool_delivery_timeout"');
  expect(source).toContain("without an outer Codex observer");

  // Once Codex received the operation, the transport deadline must not revoke the turn.
  expect(source).toContain('code: "codex_tool_in_progress"');
  expect(source).toContain("operation_may_still_be_running: true");
  expect(source).toContain('poll_tool: "codex_tool_wait"');
  expect(source).toContain('method: "invoke_status"');
  expect(source).toContain('"codex_tool_wait"');
  expect(source).toContain("turn_binding_retained: true");
  expect(source).not.toContain("did not complete within ${timeoutMs}ms after delivery; retired its turn binding");
});
