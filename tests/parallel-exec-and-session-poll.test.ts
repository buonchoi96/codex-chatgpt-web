import { expect, test } from "bun:test";
import {
  CHATGPT_NATIVE_MCP_INSTRUCTIONS,
  CHATGPT_WEB_COMMAND_YIELD_MAX_MS,
  CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
  CHATGPT_WEB_WRITE_STDIN_YIELD_MAX_MS,
  COMMAND_SESSION_TRANSPORT_RULE,
  PARALLEL_COMMAND_STABLE_ABI_RULE,
  PARALLEL_COMMAND_RULE,
  WRITE_STDIN_TRANSPORT_RULE,
  chatGptCommandYieldMs,
  chatGptWriteStdinYieldMs,
} from "../src/adapters/chatgpt-web/mcp-server";
import { readFileSync } from "node:fs";

test("exec_command yields before the MCP invocation deadline", () => {
  expect(CHATGPT_WEB_COMMAND_YIELD_MAX_MS).toBe(30_000);
  expect(chatGptCommandYieldMs(undefined)).toBe(30_000);
  expect(chatGptCommandYieldMs(5_000)).toBe(5_000);
  expect(chatGptCommandYieldMs(300_000)).toBe(30_000);
  expect(COMMAND_SESSION_TRANSPORT_RULE).toContain("30 seconds");
  expect(CHATGPT_NATIVE_MCP_INSTRUCTIONS).toContain(COMMAND_SESSION_TRANSPORT_RULE);

  const source = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  expect(source).toContain("isExecCommandToolName(name)");
  expect(source).toContain("yield_time_ms: chatGptCommandYieldMs");
  expect(source).toContain("maximum: CHATGPT_WEB_COMMAND_YIELD_MAX_MS");
});
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
  expect(PARALLEL_COMMAND_STABLE_ABI_RULE).toContain("codex.control.parallel_exec");
  expect(PARALLEL_COMMAND_STABLE_ABI_RULE).toContain("Do not pass codex_parallel_exec as an ordinary native wire name");
  expect(CHATGPT_NATIVE_MCP_INSTRUCTIONS).toContain(PARALLEL_COMMAND_RULE);
  expect(CHATGPT_NATIVE_MCP_INSTRUCTIONS).toContain(PARALLEL_COMMAND_STABLE_ABI_RULE);
  expect(readFileSync("src/adapters/chatgpt-web/prompt.ts", "utf8")).toContain("codex.control.parallel_exec");

  const source = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  const startMatch = /server\.registerTool\(\r?\n\s*"codex_parallel_exec"/.exec(source);
  expect(startMatch?.index ?? -1).toBeGreaterThan(0);
  const start = startMatch!.index;
  const remainder = source.slice(start);
  const endMatch = /server\.registerTool\(\r?\n\s*"codex_write_stdin"/.exec(remainder);
  expect(endMatch?.index ?? -1).toBeGreaterThan(0);
  const parallelBlock = remainder.slice(0, endMatch!.index);
  expect(parallelBlock).toContain("parallelCommandBatchSchema.shape.commands");
  expect(parallelBlock).toContain("runParallelCommands(claimed, input.commands, extra.signal)");
  expect(source).toContain("Promise.all(commands.map");
  expect(parallelBlock).toContain("Parallel calls always use the default sandbox");
  expect(parallelBlock).not.toContain("require_escalated");
  expect(parallelBlock).not.toContain("sandbox_permissions");
});
