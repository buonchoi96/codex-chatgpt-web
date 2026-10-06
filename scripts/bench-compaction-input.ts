import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, platform, cpus } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../src/lib/token-estimate";
import { EnhancedRecoveryCheckpointStore } from "../src/adapters/chatgpt-web/enhanced-recovery-checkpoint";
import { canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import type { CodexParsedRequest } from "../src/types";

// Synthetic canonical histories only. This measures model input size and local proof work,
// never ChatGPT generation, browser settlement, IPC or end-to-end compaction latency.
const root = mkdtempSync(join(tmpdir(), "cgb-cp-"));
const unit = "file evidence remains verified\n";
const unitTokens = estimateTokens(unit.repeat(1000)) / 1000;
const rows = [];
const percentile = (values: number[], q: number) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * q) - 1];
try {
  for (const target of [200_000, 500_000, 900_000]) {
    const source: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
      context: { messages: [{ role: "user", content: "Preserve EXACT_PROBE_A7 and validate all pending requirements.", timestamp: 1 }] },
      _rawBody: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserve EXACT_PROBE_A7 and validate all pending requirements." }] }],
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `bench-${target}`, turn_id: "source" }) } } };
    function append(id: string, tokens: number) {
      const output = unit.repeat(Math.floor(tokens / unitTokens));
      source.context.messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "read_file", arguments: { path: `src/${id}.ts` } }], timestamp: 2 },
        { role: "toolResult", toolCallId: id, toolName: "read_file", content: output, isError: false, timestamp: 3 });
      (source._rawBody as { input: unknown[] }).input.push({ type: "function_call", call_id: id, name: "read_file", arguments: JSON.stringify({ path: `src/${id}.ts` }) },
        { type: "function_call_output", call_id: id, output });
    }
    append("prefix", target * .9);
    const store = new EnhancedRecoveryCheckpointStore(join(root, `${target}.json`));
    store.commit(source, "Objective: preserve exact task. Previous evidence inspected; continue validation. Pending requirements remain.");
    append("delta", target * .1);
    source._compactionRequest = true;
    source.context.messages.push({ role: "user", content: "LATEST_PROBE_B8: complete remaining validation", timestamp: 5 });
    (source._rawBody as { input: unknown[] }).input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "LATEST_PROBE_B8: complete remaining validation" }],
      internal_chat_message_metadata_passthrough: { turn_id: "source" } }, { type: "compaction_trigger" });
    const durations = [];
    let prepared = store.prepareCompactionInput(source);
    for (let i = 0; i < 7; i++) { const start = performance.now(); prepared = store.prepareCompactionInput(source); durations.push(performance.now() - start); }
    if (prepared.mode !== "delta") throw Error("Synthetic checkpoint did not validate");
    const full = JSON.stringify(source.context), delta = JSON.stringify(prepared.parsed.context);
    const handoff = canonicalizeCompactionHandoff(source, "Continue all pending validation.");
    for (const literal of ["EXACT_PROBE_A7", "LATEST_PROBE_B8", '"callId":"prefix"', '"callId":"delta"', "src/prefix.ts"]) {
      if (!handoff.includes(literal)) throw Error("Canonical fidelity assertion failed");
    }
    rows.push({ targetTokens: target, fullBytes: Buffer.byteLength(full), deltaBytes: Buffer.byteLength(delta),
      fullTokens: estimateTokens(full), deltaTokens: estimateTokens(delta), ledgerHandoffBytes: Buffer.byteLength(handoff),
      proofP50Ms: percentile(durations, .5), proofP95Ms: percentile(durations, .95), samples: 7,
      mode: prepared.mode, preservedOpaqueProbes: 2, canonicalTools: 2 });
  }
  console.log(JSON.stringify({ benchmark: "synthetic-delta-compaction-input", baselineSha: "20296a5ac3b8327c6660e3607b992f91ee0c37c0",
    baselineBehavior: "full canonical input", after: "current workspace", platform: platform(), cpu: cpus()[0]?.model,
    bun: Bun.version, scope: "Input JSON sizing, token estimation and local canonical prefix proof only; no model or browser timing.", rows }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
