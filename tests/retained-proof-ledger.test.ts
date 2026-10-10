import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetainedConversationProofStore } from "../src/adapters/chatgpt-web/retained-followup-proof";
import type { CodexParsedRequest } from "../src/types";

const source: CodexParsedRequest = { modelId: "chatgpt-web/gpt-6-sol", stream: true, options: { reasoning: "high" },
  context: { systemPrompt: ["private policy"], messages: [{ role: "user", content: "private user text", timestamp: 1 }] } };
const next: CodexParsedRequest = { ...source, context: { ...source.context, messages: [...source.context.messages,
  { role: "assistant", content: [{ type: "text", text: "private answer" }], timestamp: 2 },
  { role: "user", content: "follow up", timestamp: 3 }] } };
const key = "a".repeat(64);

test("durable canonical proof survives restart with hashes only and typed invalidation", () => {
  const dir = mkdtempSync(join(tmpdir(), "retained-proof-")), file = join(dir, "proof.json");
  let now = 1000;
  try {
    const store = new RetainedConversationProofStore(() => now, () => file);
    store.commit(key, source, "private answer");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("private");
    expect(JSON.parse(raw).version).toBe(1);
    const restarted = new RetainedConversationProofStore(() => now, () => file);
    expect(restarted.check(key, next).reason).toBe("verified");
    expect(restarted.resume(key, next)?.context.messages).toEqual(next.context.messages.slice(2));
    restarted.invalidate(key);
    expect(new RetainedConversationProofStore(() => now, () => file).check(key, next).reason).toBe("proof_missing");
    store.commit(key, source, "private answer");
    now += 31 * 60_000;
    expect(new RetainedConversationProofStore(() => now, () => file).check(key, next).reason).toBe("proof_expired");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt/version-mismatched/future proof never authorizes a suffix", () => {
  const dir = mkdtempSync(join(tmpdir(), "retained-proof-")), file = join(dir, "proof.json");
  try {
    const store = new RetainedConversationProofStore(() => 1000, () => file);
    store.commit(key, source, "private answer");
    const valid = JSON.parse(readFileSync(file, "utf8"));
    for (const data of ["{", JSON.stringify({ ...valid, version: 99 }),
      JSON.stringify({ ...valid, proofs: valid.proofs.map((p: object) => ({ ...p, prefixLength: 0 })) })]) {
      writeFileSync(file, data);
      expect(new RetainedConversationProofStore(() => 1000, () => file).check(key, next).reason).toBe("ledger_invalid");
    }
    writeFileSync(file, JSON.stringify(valid));
    expect(new RetainedConversationProofStore(() => 1, () => file).check(key, next).reason).toBe("proof_expired");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ledger write failure preserves the completed answer and disables reuse", () => {
  const dir = mkdtempSync(join(tmpdir(), "retained-proof-"));
  try {
    const store = new RetainedConversationProofStore(() => 1000, () => dir);
    expect(store.commit(key, source, "private answer")).toBe(false);
    expect(store.check(key, next).reason).toBe("ledger_io_failed");
    expect(() => store.invalidate(key)).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
