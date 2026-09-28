import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Responses bridge records which side tears down a long Web stream", () => {
  const source = readFileSync("src/bridge.ts", "utf8");
  expect(source).toContain("[bridge] client_cancelled");
  expect(source).toContain("sinceLastEventMs=");
  expect(source).toContain("upstreamDone=");
  expect(source).toContain("[bridge] stream_pump_failed");
  expect(source).toContain("adapterEvents=");
});
