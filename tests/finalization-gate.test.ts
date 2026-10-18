import { expect, test } from "bun:test";
import { awaitFinalBrokerRetirement } from "../src/adapters/chatgpt-web/finalization-gate";

test("finalization waits for broker retirement confirmation", async () => {
  let release!: () => void;
  const retirement = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const task = awaitFinalBrokerRetirement(() => retirement, 300);
  void task.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await task;
  expect(settled).toBe(true);
});

test("nonresponsive broker retirement terminates with typed nonretryable failure", async () => {
  await expect(awaitFinalBrokerRetirement(() => new Promise<void>(() => {}), 15))
    .rejects.toMatchObject({ code: "final_broker_retirement_timeout", retryable: false });
});

test("synchronous retirement and rejected retirement keep original semantics", async () => {
  await expect(awaitFinalBrokerRetirement(() => {}, 50)).resolves.toBeUndefined();
  await expect(awaitFinalBrokerRetirement(() => Promise.reject(new Error("native owner failed")), 50))
    .rejects.toThrow("native owner failed");
});

test("adapter journals done only after bounded broker retirement", () => {
  const source = require("node:fs").readFileSync("src/adapters/chatgpt-web/index.ts", "utf8") as string;
  expect(source.indexOf("stage=broker_retirement_acknowledged")).toBeLessThan(
    source.indexOf("stage=adapter_done_journaled"));
  expect(source).toContain("await withAbort(awaitFinalBrokerRetirement(");
});
