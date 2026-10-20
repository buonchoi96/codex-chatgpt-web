import { expect, test } from "bun:test";
import { awaitFinalBrokerRetirement, pendingJournaledFinalAnswerSuffix } from "../src/adapters/chatgpt-web/finalization-gate";

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

test("a final /goal status line missing from the event journal is added before done", () => {
  const first = "Sakura vẫn online với SkriptMCP 0.6.0. Không chỉnh sửa world, restart server, triển khai plugin hay push Git. Tệp config/console-audit.jsonl được giữ nguyên.";
  const last = "\n\n/goal: ACTIVE. Phục hồi qua tiến trình độc lập đã được kiểm chứng offline, nhưng độ bền sau sự cố hệ điều hành, rollback toàn bộ trạng thái Paper và cannoning E2E vẫn chưa được xác minh.";
  const events = [
    { type: "text_delta" as const, phase: "commentary" as const, text: "Analyzing." },
    { type: "text_delta" as const, phase: "final_answer" as const, text: first },
  ];
  expect(pendingJournaledFinalAnswerSuffix(events, first + last)).toBe(last);
  expect(pendingJournaledFinalAnswerSuffix([
    ...events, { type: "text_delta" as const, phase: "final_answer" as const, text: last },
  ], first + last)).toBe("");
  expect(pendingJournaledFinalAnswerSuffix(events, first + last)).toBe(last);
});

test("final-answer reconciliation refuses a divergent or foreign journal prefix", () => {
  expect(() => pendingJournaledFinalAnswerSuffix([
    { type: "text_delta", phase: "final_answer", text: "Other task" },
  ], "Sakura goal completed")).toThrow("journal diverged");
});

test("both finalization paths journal the exact missing suffix before Responses done", () => {
  const source = require("node:fs").readFileSync("src/adapters/chatgpt-web/index.ts", "utf8") as string;
  expect(source).toContain("pendingJournaledFinalAnswerSuffix(session.roundEvents(roundKey), settled.answer)");
  expect(source).toContain("session.roundEvents(roundKey), completedOutcome.answer");
  const tail = source.indexOf("stage=final_answer_journal_verified");
  const done = source.indexOf("emitRoundBatch(buffer => emitBrowserCompletion(", tail);
  expect(tail).toBeGreaterThan(0);
  expect(done).toBeGreaterThan(tail);
});


test("tool-capable finalization refreshes the immutable final replay snapshot after the late answer suffix", () => {
  const { ChatGptTurnSession } = require("../src/adapters/chatgpt-web/turn-execution");
  const source = require("node:fs").readFileSync("src/adapters/chatgpt-web/index.ts", "utf8") as string;
  const from = source.indexOf("const finishBrowserOutcome =");
  const to = source.indexOf("const waitForTrace =", from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const finalizer = source.slice(from, to);
  const tail = finalizer.indexOf("const missingTail = pendingJournaledFinalAnswerSuffix(");
  const refresh = finalizer.lastIndexOf("session.setFinalEvents(session.roundEvents(roundKey))");
  const terminal = finalizer.indexOf("emitRoundBatch(buffer => emitBrowserCompletion(", tail);
  expect(tail).toBeGreaterThan(0);
  expect(refresh).toBeGreaterThan(tail);
  expect(terminal).toBeGreaterThan(refresh);

  // The real session clones final replay events, so a snapshot taken before
  // the last line is stale until it is explicitly refreshed.
  const session = Object.create(ChatGptTurnSession.prototype);
  session.rounds = new Map();
  session.appendRoundEvent("round-1", { type: "text_delta", phase: "final_answer", text: "First line.\\n" });
  session.setFinalEvents(session.roundEvents("round-1"));
  session.appendRoundEvent("round-1", { type: "text_delta", phase: "final_answer", text: "Final goal: PURSUING.\\n" });
  expect(session.eventsForFinalReplay().map((event: { text?: string }) => event.text ?? "").join(""))
    .toBe("First line.\\n");
  session.setFinalEvents(session.roundEvents("round-1"));
  expect(session.eventsForFinalReplay().map((event: { text?: string }) => event.text ?? "").join(""))
    .toBe("First line.\\nFinal goal: PURSUING.\\n");
});
