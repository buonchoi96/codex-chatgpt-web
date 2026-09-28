import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CHATGPT_NATIVE_MCP_INSTRUCTIONS,
  COMPUTER_USE_FAST_PATH_RULE,
} from "../src/adapters/chatgpt-web/mcp-server";

test("Full Harness advertises a persistent low-latency Computer Use loop", () => {
  expect(COMPUTER_USE_FAST_PATH_RULE).toContain("persistent node_repl/@oai/sky session");
  expect(COMPUTER_USE_FAST_PATH_RULE).toContain("Prefer structured app/window/control state");
  expect(COMPUTER_USE_FAST_PATH_RULE).toContain("Do not re-describe or re-analyze an unchanged screen");
  expect(COMPUTER_USE_FAST_PATH_RULE).toContain("short deterministic sequence of low-risk UI actions");
  expect(CHATGPT_NATIVE_MCP_INSTRUCTIONS).toContain(COMPUTER_USE_FAST_PATH_RULE);

  const mcp = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  expect(mcp).toContain('name === "mcp__node_repl__js"');
  expect(mcp).toMatch(/browserToolDescription[\s\S]*COMPUTER_USE_FAST_PATH_RULE/);
  expect(mcp).toMatch(/gatewayToolDescription[\s\S]*COMPUTER_USE_FAST_PATH_RULE/);

  const prompt = readFileSync("src/adapters/chatgpt-web/prompt.ts", "utf8");
  expect(prompt).toContain("prefer structured app/window/control information over a fresh screenshot");
  expect(prompt).toContain("Do not re-describe an unchanged screen");
});
