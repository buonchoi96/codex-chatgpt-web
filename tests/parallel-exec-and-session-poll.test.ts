import { expect, test } from "bun:test";
import {
  CHATGPT_NATIVE_MCP_INSTRUCTIONS,
  CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
  CHATGPT_WEB_WRITE_STDIN_YIELD_MAX_MS,
  PARALLEL_COMMAND_RULE,
  WRITE_STDIN_TRANSPORT_RULE,
  chatGptWriteStdinYieldMs,
} from "../src/adapters/chatgpt-web/mcp-server";
import { readFileSync } from "node:fs";

test("write_stdin polling remains below the MCP invocation deadline", () => {
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBe(90_000);
  expect(CHATGPT_WEB_WRITE_STDIN_YIELD_MAX_MS).toBe(60_000);
  expect(chatGptWriteStdinYieldMs(undefined)).toBeUndefined();
  expect(chatGptWriteStdinYieldMs(30_000)).toBe(30_000);
  expect(chatGptWriteStdinYieldMs(300_000)).toBe(60_000);
  expect(WRITE_STDIN_TRANSPORT_RULE).toContain("60 seconds");
  expect(CHATGPT_NATIVE_MCP_INSTRUCTIONS).toContain(WRITE_STDIN_TRANSPORT_RULE);

  const source = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  expect(source).toContain("max(CHATGPT_WEB_WRITE_STDIN_YIELD_MAX_MS)");
  expect(source).toContain("normalizeStructuredToolArguments(wire_name");
});

test("parallel command bridge preserves single-purpose command safety", () => {
  expect(PARALLEL_COMMAND_RULE).toContain("codex_parallel_exec");
  expect(PARALLEL_COMMAND_RULE).toContain("never by joining commands");
  expect(CHATGPT_NATIVE_MCP_INSTRUCTIONS).toContain(PARALLEL_COMMAND_RULE);

  const source = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  const startMatch = /server\.registerTool\(\r?\n\s*"codex_parallel_exec"/.exec(source);
  expect(startMatch?.index ?? -1).toBeGreaterThan(0);
  const start = startMatch!.index;
  const remainder = source.slice(start);
  const endMatch = /server\.registerTool\(\r?\n\s*"codex_write_stdin"/.exec(remainder);
  expect(endMatch?.index ?? -1).toBeGreaterThan(0);
  const parallelBlock = remainder.slice(0, endMatch!.index);
  expect(parallelBlock).toContain("z.array(z.object({");
  expect(parallelBlock).toContain("})).min(2).max(8)");
  expect(parallelBlock).toContain("Promise.all(input.commands.map");
  expect(parallelBlock).toContain("Parallel calls always use the default sandbox");
  expect(parallelBlock).not.toContain("require_escalated");
  expect(parallelBlock).not.toContain("sandbox_permissions");
});
