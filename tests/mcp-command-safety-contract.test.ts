import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CHATGPT_NATIVE_MCP_INSTRUCTIONS,
  COMMAND_SAFETY_TRANSPORT_RULE,
} from "../src/adapters/chatgpt-web/mcp-server";

test("Full Harness teaches command-safety-compatible single-purpose shell calls", () => {
  expect(COMMAND_SAFETY_TRANSPORT_RULE).toContain("single-purpose");
  expect(COMMAND_SAFETY_TRANSPORT_RULE).toContain("Do not batch unrelated read-only probes");
  expect(COMMAND_SAFETY_TRANSPORT_RULE).toContain("split it into smaller read-only commands");
  expect(CHATGPT_NATIVE_MCP_INSTRUCTIONS).toContain(COMMAND_SAFETY_TRANSPORT_RULE);

  const source = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  expect(source).toContain('name === "exec_command"');
  expect(source).toContain('name === "shell_command"');
  expect(source).toContain('name.endsWith("__exec_command")');
  expect(source).toContain('name.endsWith("__shell_command")');
  expect(source).toMatch(/browserToolDescription[\s\S]*COMMAND_SAFETY_TRANSPORT_RULE/);
  expect(source).toMatch(/gatewayToolDescription[\s\S]*COMMAND_SAFETY_TRANSPORT_RULE/);
});
