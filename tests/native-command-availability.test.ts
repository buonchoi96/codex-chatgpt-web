import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { nativeCommandSurface } from "../src/adapters/chatgpt-web/native-command-surface";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexTool, CodexParsedRequest } from "../src/types";

const tool = (name: string, extra: Partial<CodexTool> = {}): CodexTool => ({
  name, description: "fixture", parameters: { type: "object" }, ...extra,
});

test("native command preflight accepts only directly advertised command tools or a freeform exec gateway", () => {
  expect(nativeCommandSurface([])).toBeUndefined();
  expect(nativeCommandSurface([tool("tool_search", { toolSearch: true })])).toBeUndefined();
  expect(nativeCommandSurface([tool("exec", { namespace: "other", freeform: true })])).toBeUndefined();
  expect(nativeCommandSurface([tool("exec")])).toBeUndefined();
  expect(nativeCommandSurface([tool("codex_exec", { namespace: "mcp__Codex_Native2" })])).toBeUndefined();
  expect(nativeCommandSurface([tool("exec_command")])).toBe("exec_command");
  expect(nativeCommandSurface([tool("shell_command")])).toBe("shell_command");
  expect(nativeCommandSurface([tool("exec", { freeform: true })])).toBe("exec");
});

test("tool-capable prompts warn about absent native commands without blocking independently advertised tools", () => {
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [{ role: "user", content: "inspect files", timestamp: 1 }],
      tools: [tool("custom_read")],
    },
    stream: true,
    options: { reasoning: "high" },
  };
  const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const token = "turn_12345678901234567890123456789012";
  const missing = compileChatGptWebPrompt(parsed, caps, token).text;
  expect(missing).toContain("CURRENT NATIVE COMMAND PREFLIGHT:");
  expect(missing).toContain("Do not call the command-running MCP operations");
  parsed.context.tools = [tool("exec", { freeform: true })];
  expect(compileChatGptWebPrompt(parsed, caps, token).text).not.toContain("CURRENT NATIVE COMMAND PREFLIGHT:");
});

test("missing native commands never abort the whole browser turn, but fail before command dispatch", () => {
  const adapter = readFileSync("src/adapters/chatgpt-web/index.ts", "utf8");
  const guard = adapter.indexOf("&& !nativeCommandSurface(environment.tools)");
  const runtime = adapter.indexOf("const nativeIdentity = extractChatGptTurnIdentity(parsed);");
  expect(guard).toBeGreaterThan(0);
  expect(runtime).toBeGreaterThan(guard);
  const compactionBoundary = adapter.indexOf("if (parsed._compactionRequest)", guard);
  expect(compactionBoundary).toBeGreaterThan(guard);
  const diagnostic = adapter.slice(guard, compactionBoundary);
  expect(diagnostic).toContain("raw_declared_tools:");
  expect(diagnostic).toContain("additional_tool_count:");
  expect(diagnostic).not.toContain('code: "native_command_unavailable"');
  expect(diagnostic).not.toContain('emit({');
  const server = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  const command = server.indexOf("const { cmd, workdir, yield_time_ms");
  const gateway = server.indexOf("const gateway = execGateway(bound);", command);
  const dispatch = server.indexOf("commandDispatched=true;", gateway);
  const missing = server.slice(gateway, dispatch);
  expect(missing).toContain('code: "native_command_unavailable"');
  expect(missing).toContain("command_dispatched: false");
});
