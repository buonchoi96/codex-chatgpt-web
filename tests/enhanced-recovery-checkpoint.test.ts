import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexMessage, CodexParsedRequest } from "../src/types";
import {
  EnhancedRecoveryCheckpointStore,
} from "../src/adapters/chatgpt-web/enhanced-recovery-checkpoint";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parsed(messages: CodexMessage[], overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    options: { reasoning: "high" },
    context: { messages },
    _chatgptModelFamily: "5.6",
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread-recovery",
          turn_id: "turn-current",
        }),
      },
    },
    ...overrides,
  } as CodexParsedRequest;
}

function completeHistory(task = "Preserve exact probe ASTRAL-KITE-381"): CodexMessage[] {
  return [
    { role: "developer", content: "Keep exact validation probes.", timestamp: 1 },
    { role: "user", content: task, timestamp: 2 },
    {
      role: "assistant",
      timestamp: 3,
      content: [{ type: "toolCall", id: "call-1", name: "inspect", arguments: { path: "repo" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "inspect",
      content: "verified result 167284",
      isError: false,
      timestamp: 4,
    },
  ];
}

test("durable recovery checkpoint applies only to its exact canonical prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "enhanced-recovery-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const source = parsed(completeHistory());
  const store = new EnhancedRecoveryCheckpointStore(path);

  expect(store.shouldCheckpoint(source, 1)).toBe(true);
  store.commit(source, [
    "Objective: continue the exact task.",
    "Evidence: ASTRAL-KITE-381 and 167284 were verified.",
    "Pending: finish remaining validation.",
  ].join("\n"));

  const applied = new EnhancedRecoveryCheckpointStore(path).apply(source);
  expect(applied.applied).toBe(true);
  expect(applied.parsed.context.messages.some(message => (
    message.role === "assistant"
    && message.content.some(part => part.type === "text"
      && part.text.includes("[Enhanced passive recovery checkpoint]")
      && part.text.includes("ASTRAL-KITE-381")
      && part.text.includes("167284"))
  ))).toBe(true);
  expect(applied.parsed.context.messages.some(message => message.role === "toolResult")).toBe(false);
  expect(applied.parsed.context.messages.some(message => (
    message.role === "user" && typeof message.content === "string"
    && message.content.includes("ASTRAL-KITE-381")
  ))).toBe(true);

  const tampered = parsed(completeHistory("Changed canonical user instruction"));
  const rejected = new EnhancedRecoveryCheckpointStore(path).apply(tampered);
  expect(rejected.applied).toBe(false);
  expect(rejected.reason).toContain("prefix mismatch");

  const wrongModel = parsed(completeHistory(), { modelId: "gpt-6-sol" });
  const modelRejected = new EnhancedRecoveryCheckpointStore(path).apply(wrongModel);
  expect(modelRejected.applied).toBe(false);
  expect(modelRejected.reason).toContain("model identity mismatch");
});

test("recovery checkpoint is never created across an incomplete tool boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "enhanced-recovery-"));
  roots.push(root);
  const store = new EnhancedRecoveryCheckpointStore(join(root, "checkpoints.json"));
  const incomplete = parsed([
    { role: "user", content: "Do the task.", timestamp: 1 },
    {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "toolCall", id: "call-pending", name: "mutate", arguments: {} }],
    },
  ]);
  expect(store.shouldCheckpoint(incomplete, 1)).toBe(false);
  expect(() => store.commit(incomplete, "This must not persist."))
    .toThrow("complete canonical tool-result boundary");
});

test("recovery and compaction one-shot control tokens cannot be cross-used", async () => {
  const transactions = new CompactionTransactionStore();
  const committed: string[] = [];
  const recovery = transactions.begin("trace_recovery", 30_000, summary => committed.push(summary));

  expect(() => transactions.submit(
    recovery.token,
    recovery.handoffId,
    "checkpoint",
    "compaction",
  )).toThrow("does not match its token");
  expect(committed).toEqual([]);

  transactions.submit(recovery.token, recovery.handoffId, " checkpoint ", "recovery");
  expect(committed).toEqual(["checkpoint"]);
  await expect(transactions.wait(recovery.token)).resolves.toBe("checkpoint");

  const compaction = transactions.begin("trace_compaction", 30_000);
  expect(() => transactions.submit(
    compaction.token,
    compaction.handoffId,
    "summary",
    "recovery",
  )).toThrow("does not match its token");
  transactions.abort(compaction.token);
});


test("passive recovery checkpoint never blocks the active tool observer", () => {
  const source = require("node:fs").readFileSync("src/adapters/chatgpt-web/index.ts", "utf8");
  const waitBlock = "await withAbort(Promise.race([\n                      structuredBroker.waitForCompactionHandoff";
  expect(source).not.toContain(waitBlock);
  expect(source).toContain("const armRecoveryCheckpoint = () => recoveryCheckpoint && structuredBroker");
  expect(source).toContain("...(nextRecoveryCheckpoint ? [nextRecoveryCheckpoint] : [])");
  expect(source).toContain("passive recovery checkpoint superseded by active tool");
  const nextTools = source.indexOf("let nextTools = armNextTools()");
  const checkpointRace = source.indexOf("let nextRecoveryCheckpoint = armRecoveryCheckpoint()");
  expect(nextTools).toBeGreaterThan(0);
  expect(checkpointRace).toBeGreaterThan(nextTools);
});
