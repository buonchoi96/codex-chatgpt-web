import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS } from "../src/adapters/chatgpt-web/mcp-server";

test("MCP delivery timeout retracts only an undelivered call and keeps the turn reusable", () => {
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBe(90_000);
  const source = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  expect(source).toContain('method: "cancel_invoke"');
  expect(source).toContain('code: "codex_tool_delivery_timeout"');
  expect(source).toContain("turn_binding_retained: true");
  expect(source).toContain("retryable: true");
  expect(source).toContain("without an outer Codex observer");
  expect(source).toContain("did not complete within");
});
