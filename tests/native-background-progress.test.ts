import { expect, test } from "bun:test";
import { ChatGptExternalTurnProgress, chatGptExternalWorkBlocksRecovery } from "../src/adapters/chatgpt-web/turn-progress";

test("owned process and subagent receipts keep recovery suspended after tool return", () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordBackgroundResult("exec_command", {}, { session_id: 42 }, false);
  expect(progress.snapshot().activeNativeProcesses).toBe(1);
  expect(chatGptExternalWorkBlocksRecovery(progress.snapshot())).toBe(true);
  progress.recordBackgroundResult("write_stdin", { session_id: 42 }, { session_id: 42 }, false);
  expect(progress.snapshot().activeNativeProcesses).toBe(1);
  progress.recordBackgroundResult("write_stdin", { session_id: 42 }, { exit_code: 0 }, false);
  expect(progress.snapshot().activeNativeProcesses ?? 0).toBe(0);
  progress.recordBackgroundResult("multi_agent_v1__spawn_agent", {}, { agent_id: "agent-A" }, false);
  expect(progress.snapshot().activeSubagents).toBe(1);
  progress.recordBackgroundResult("multi_agent_v1__wait_agent", { targets: ["agent-A"] }, { status: { "agent-A": "running" }, timed_out: true }, false);
  expect(progress.snapshot().activeSubagents).toBe(1);
  progress.recordBackgroundResult("multi_agent_v1__wait_agent", { targets: ["agent-A"] }, { status: { "agent-A": { completed: "done" } }, timed_out: false }, false);
  expect(progress.snapshot().activeSubagents ?? 0).toBe(0);
  expect(chatGptExternalWorkBlocksRecovery(progress.snapshot())).toBe(false);
});

test("errors and unrelated receipts cannot clear a known owned background operation", () => {
  const progress = new ChatGptExternalTurnProgress();
  progress.recordBackgroundResult("exec_command", {}, { session_id: 42 }, false);
  progress.recordBackgroundResult("write_stdin", { session_id: 42 }, { exit_code: 0 }, true);
  progress.recordBackgroundResult("other_tool", { session_id: 42 }, { exit_code: 0 }, false);
  progress.recordBackgroundResult("write_stdin", { session_id: 99 }, { exit_code: 0 }, false);
  expect(progress.snapshot().activeNativeProcesses).toBe(1);
});

test("opaque native execution and scoped owned processes veto Stop until reconciled", () => {
  const opaque = new ChatGptExternalTurnProgress();
  opaque.recordBackgroundResult("exec", {}, {}, false);
  expect(chatGptExternalWorkBlocksRecovery(opaque.snapshot())).toBe(true);
  const progress = new ChatGptExternalTurnProgress();
  progress.recordBackgroundResult("mcp__computer_use_swift__swift_process_start", {}, { process: "process-A", status: "running" });
  expect(chatGptExternalWorkBlocksRecovery(progress.snapshot())).toBe(true);
  progress.recordBackgroundResult("mcp__computer_use_swift__swift_process_poll", { process: "process-A" }, { process: "process-A", status: "running" });
  expect(chatGptExternalWorkBlocksRecovery(progress.snapshot())).toBe(true);
  progress.recordBackgroundResult("mcp__computer_use_swift__swift_process_cancel", { process: "process-A" }, { process: "process-A", status: "cancelled" });
  expect(chatGptExternalWorkBlocksRecovery(progress.snapshot())).toBe(false);
});
test("failed launch-capable calls cannot certify background inactivity", () => {
  for (const name of ["exec", "exec_command", "multi_agent_v1__spawn_agent", "mcp__node_repl__js", "mcp__swift__swift_process_start"]) {
    const progress = new ChatGptExternalTurnProgress();
    progress.recordBackgroundResult(name, {}, undefined, true);
    expect(progress.snapshot().backgroundActivityUnverified).toBe(true);
  }
});
