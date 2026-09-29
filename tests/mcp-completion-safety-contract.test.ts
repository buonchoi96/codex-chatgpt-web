import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("completion receipt is advertised as an internal read-only control-plane acknowledgement", () => {
  const source = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  const registration = source.indexOf('server.registerTool(\n      "codex_turn_complete"');
  expect(registration).toBeGreaterThan(0);
  const block = source.slice(registration, source.indexOf('if (contract === "safe")', registration));
  expect(block).toContain("Internal control-plane acknowledgement only");
  expect(block).toContain("readOnlyHint: true");
  expect(block).toContain("destructiveHint: false");
  expect(block).toContain("idempotentHint: true");
  expect(block).toContain("openWorldHint: false");
  expect(block).toContain("codex_turn_complete entered scope=");
});
