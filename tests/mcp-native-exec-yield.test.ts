import { expect, test } from "bun:test";
import {
  CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
  CHATGPT_WEB_NATIVE_EXEC_DEFAULT_YIELD_MS,
  withShortNativeExecYield,
} from "../src/adapters/chatgpt-web/mcp-server";
import type { CodexTool } from "../src/types";

const tool = (name: string, properties: Record<string, unknown>): Pick<CodexTool, "name" | "parameters"> => ({
  name,
  parameters: { type: "object", properties },
});

test("native exec_command defaults to a short session yield only when advertised", () => {
  const exec = tool("exec_command", { cmd: {}, yield_time_ms: { type: "integer" } });
  const input = { arguments: { cmd: "a lengthy native process" } };
  const output = withShortNativeExecYield(exec, input);
  expect(output).toEqual({
    arguments: { cmd: "a lengthy native process", yield_time_ms: CHATGPT_WEB_NATIVE_EXEC_DEFAULT_YIELD_MS },
  });
  expect(input.arguments).not.toHaveProperty("yield_time_ms");
  expect(CHATGPT_WEB_NATIVE_EXEC_DEFAULT_YIELD_MS).toBe(1000);
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBe(90_000);
});

test("preserve explicit yield and do not invent arguments for unsupported native tools", () => {
  const exec = tool("exec_command", { cmd: {}, yield_time_ms: {} });
  const explicit = { arguments: { cmd: "native", yield_time_ms: 30_000 } };
  expect(withShortNativeExecYield(exec, explicit)).toBe(explicit);
  const unsupported = { arguments: { cmd: "native" } };
  expect(withShortNativeExecYield(tool("exec_command", { cmd: {} }), unsupported))
    .toBe(unsupported);
  expect(withShortNativeExecYield(tool("shell_command", { command: {}, timeout_ms: {} }), {
    arguments: { command: "long shell task" },
  })).toEqual({ arguments: { command: "long shell task" } });
  const freeform = { input: "do something" };
  expect(withShortNativeExecYield(tool("exec", { input: {} }), freeform)).toBe(freeform);
});

test("a submitted native exec is transformed before dispatch, not retried after dispatch", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8") as string;
  const fn = source.indexOf("const invoke = async (");
  const prepared = source.indexOf("payload = withShortNativeExecYield(tool, payload)", fn);
  const dispatch = source.indexOf('method: "invoke"', prepared);
  expect(fn).toBeGreaterThan(0);
  expect(prepared).toBeGreaterThan(fn);
  expect(dispatch).toBeGreaterThan(prepared);
  expect(source.slice(prepared, dispatch)).not.toMatch(/(?:callTurnBroker|replay|retry)\s*\(/);
});
