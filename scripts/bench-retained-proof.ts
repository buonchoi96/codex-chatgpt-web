import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RetainedConversationProofStore } from "../src/adapters/chatgpt-web/retained-followup-proof";
import type { CodexParsedRequest } from "../src/types";

const root = resolve(import.meta.dir, "..");
const baseline = process.argv[2] ?? "a91c58b";
const temporary = mkdtempSync(join(tmpdir(), "retained-proof-bench-"));
const results: unknown[] = [];
try {
  const build = await Bun.build({ entrypoints: [join(root, "src/adapters/chatgpt-web/retained-followup-proof.ts")], target: "bun", format: "esm",
    plugins: [{ name: "baseline-proof", setup(builder) {
      builder.onLoad({ filter: /retained-followup-proof\.ts$/ }, () => {
        const source = Bun.spawnSync(["git", "show", `${baseline}:src/adapters/chatgpt-web/retained-followup-proof.ts`], { cwd: root });
        assert.equal(source.exitCode, 0, source.stderr.toString());
        return { contents: source.stdout.toString(), loader: "ts" };
      });
    } }] });
  assert.ok(build.success);
  const entry = join(temporary, "baseline.mjs");
  await Bun.write(entry, await build.outputs[0]!.text());
  const Baseline = (await import(entry)).RetainedConversationProofStore;
  for (const messages of [64, 2048]) {
    const parsed: CodexParsedRequest = { modelId: "chatgpt-web/gpt-6-sol", stream: true, options: { reasoning: "high" },
      context: { systemPrompt: ["Synthetic benchmark policy"], messages: Array.from({ length: messages }, (_, index) =>
        ({ role: "user" as const, content: `${index}:` + "synthetic ".repeat(100), timestamp: index })) } };
    const next: CodexParsedRequest = { ...parsed, context: { ...parsed.context, messages: [...parsed.context.messages,
      { role: "assistant", content: [{ type: "text", text: "BENCHMARK_COMPLETE" }], timestamp: messages },
      { role: "user", content: "Follow up", timestamp: messages + 1 }] } };
    for (const mode of ["baseline-memory", "patch-durable"] as const) {
      const file = join(temporary, `${messages}.json`), key = "a".repeat(64);
      const store = mode === "baseline-memory" ? new Baseline() : new RetainedConversationProofStore(Date.now, () => file);
      const timings: number[] = [];
      store.commit(key, parsed, "BENCHMARK_COMPLETE");
      for (let sample = 0; sample < 100; ++sample) {
        const start = performance.now();
        const suffix = store.resume(key, next);
        timings.push(performance.now() - start);
        assert.equal(suffix?.context.messages.length, 1);
        assert.equal(suffix?.context.messages[0]?.content, "Follow up");
      }
      timings.sort((a, b) => a - b);
      results.push({ mode, messages, canonical_bytes: Buffer.byteLength(JSON.stringify(parsed.context)), samples: timings.length,
        p50_ms: timings[49], p95_ms: timings[94], ...(mode === "patch-durable" ? { ledger_bytes: statSync(file).size } : {}) });
    }
  }
  console.log(JSON.stringify({ boundary: "canonical-proof-resume-only", baseline, browser_model_zip_transport: "NOT MEASURED", results }, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
