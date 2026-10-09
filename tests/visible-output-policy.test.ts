import { expect, test } from "bun:test";
import { showPublicReasoning } from "../src/adapters/chatgpt-web/visible-output-policy";

test("default output suppresses standalone activity statuses but preserves visible reasoning summaries", () => {
  for (const text of ["Preparing visual testing", "Finalized the benchmark", "Computer Use: Observe movement"]) {
    expect(showPublicReasoning({ kind: "commentary" }), text).toBe(false);
  }
  expect(showPublicReasoning({ kind: "reasoning" })).toBe(true);
  expect(showPublicReasoning({ kind: "reasoning" }, true)).toBe(false);
});
