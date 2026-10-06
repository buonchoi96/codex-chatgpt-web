import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnhancedRecoveryCheckpointStore } from "../src/adapters/chatgpt-web/enhanced-recovery-checkpoint";
import type { CodexParsedRequest } from "../src/types";

function request(): CodexParsedRequest {
  return { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" }, _chatgptModelFamily: "5.6",
    _compactionRequest: true, context: { systemPrompt: ["Preserve exact evidence"], messages: [
      { role: "user", content: "Inspect src/probe.ts; pending requirement PROBE_PENDING_A7", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read_file", arguments: { path: "src/probe.ts" } }], timestamp: 2 },
      { role: "toolResult", toolCallId: "read-1", toolName: "read_file", isError: false, timestamp: 3,
        content: JSON.stringify({ type: "file_read", path: "src/probe.ts", start_line: 11, end_line: 13,
          returned_line_count: 3, truncated: false, output: "EXACT_SENTINEL_8A 0f8c2aa37b" }) },
    ] }, _rawBody: { input: [
      { type: "message", role: "user", content: "Inspect src/probe.ts" },
      { type: "function_call", call_id: "read-1", name: "read_file", arguments: '{"path":"src/probe.ts"}' },
      { type: "function_call_output", call_id: "read-1", output: "EXACT_SENTINEL_8A 0f8c2aa37b" },
    ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "proof-thread", turn_id: "proof-turn" }) } },
  } as CodexParsedRequest;
}

test("delta proof preserves exact range, literals, requirements, and canonical tail", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-proof-"));
  try {
    const source = request();
    const store = new EnhancedRecoveryCheckpointStore(join(root, "cp.json"));
    store.commit(source, "Prior evidence: inspect complete; next validate pending probe.");
    const current = structuredClone(source);
    current.context.messages.push({ role: "user", content: "LATEST_REQUIREMENT_B9", timestamp: 4 });
    const prepared = store.prepareCompactionInput(current);
    expect(prepared.mode).toBe("delta");
    expect(prepared.prefixLength).toBe(3);
    const input = JSON.stringify(prepared.parsed.context.messages);
    expect(input).toContain("PROBE_PENDING_A7");
    expect(input).toContain("LATEST_REQUIREMENT_B9");
    expect(input).toContain("EXACT_SENTINEL_8A");
    expect(input).toContain("0f8c2aa37b");
    expect(input).toContain('\\"returnedLines\\":{\\"path\\":\\"src/probe.ts\\",\\"start\\":11,\\"end\\":13}');
    expect(input).not.toContain("fullyRead");
    expect(current.context.messages).toHaveLength(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prefix, raw evidence, identity, and epoch mismatches each force original full input", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-proof-"));
  try {
    const source = request(), path = join(root, "cp.json");
    new EnhancedRecoveryCheckpointStore(path).commit(source, "Prior evidence; continue validation.");
    const variants = [
      (p: CodexParsedRequest) => { p.context.messages[0] = { role: "user", content: "changed", timestamp: 1 }; },
      (p: CodexParsedRequest) => { (p._rawBody as any).input[2].output = "different raw result"; },
      (p: CodexParsedRequest) => { p.options.reasoning = "low"; },
      (p: CodexParsedRequest) => { p._chatgptModelFamily = "6"; },
      (p: CodexParsedRequest) => { p.modelId = "gpt-6-sol"; },
      (p: CodexParsedRequest) => { (p._rawBody as any).client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: "other-thread" }); },
      (p: CodexParsedRequest) => { (p._rawBody as any).input.push({ type: "compaction", encrypted_content: "new-epoch" }); },
    ];
    for (const mutate of variants) {
      const current = structuredClone(source);
      mutate(current);
      const prepared = new EnhancedRecoveryCheckpointStore(path).prepareCompactionInput(current);
      expect(prepared.mode).toBe("full");
      expect(prepared.parsed).toBe(current);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt and legacy durable checkpoints fail closed without blocking full compaction", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-proof-"));
  try {
    const path = join(root, "cp.json"), source = request();
    new EnhancedRecoveryCheckpointStore(path).commit(source, "Prior evidence; validate.");
    const original = JSON.parse(readFileSync(path, "utf8"));
    for (const corrupt of [
      (p: any) => { p.checkpoints[0].summary = "silently changed"; },
      (p: any) => { p.checkpoints[0].ledger.tools[0].returnedLines.end = 999; },
      (p: any) => { p.version = 1; },
    ]) {
      const changed = structuredClone(original);
      corrupt(changed);
      writeFileSync(path, JSON.stringify(changed));
      const prepared = new EnhancedRecoveryCheckpointStore(path).prepareCompactionInput(source);
      expect(prepared.mode).toBe("full");
      expect(prepared.parsed).toBe(source);
    }
    writeFileSync(path, "{broken json");
    expect(new EnhancedRecoveryCheckpointStore(path).prepareCompactionInput(source).mode).toBe("full");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
