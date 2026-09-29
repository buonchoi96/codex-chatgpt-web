import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("completion receipt is advertised as an internal read-only control-plane acknowledgement", () => {
  const source = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  const registration = source.search(/server\.registerTool\(\r?\n\s*"codex_turn_complete"/);
  expect(registration).toBeGreaterThan(0);
  const block = source.slice(registration, source.indexOf('if (contract === "safe")', registration));
  expect(block).toContain("Internal control-plane acknowledgement only");
  expect(block).toContain("when this tool is callable on the current connector surface");
  expect(block).toContain("codex_tool_call");
  expect(block).toContain("CODEX_COMPLETION_CONTROL_WIRE_NAME");
  expect(block).toContain("readOnlyHint: true");
  expect(block).toContain("destructiveHint: false");
  expect(block).toContain("idempotentHint: true");
  expect(block).toContain("openWorldHint: false");
  expect(block).toContain("codex_turn_complete entered scope=");

  const stableCallRegistration = source.search(/server\.registerTool\(\r?\n\s*"codex_tool_call"/);
  const stableCallDescription = source.slice(stableCallRegistration, source.indexOf("inputSchema:", stableCallRegistration));
  expect(stableCallDescription).toContain("CODEX_COMPLETION_CONTROL_WIRE_NAME");
  expect(stableCallDescription).toContain("If the current connector does not expose codex_turn_complete");
});
