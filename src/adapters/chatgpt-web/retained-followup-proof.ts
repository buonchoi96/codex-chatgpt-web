import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { atomicWriteFile, getConfigDir } from "../../config";
import { WEB_CONTEXT_POLICY_VERSION } from "../../web-context-policy";
import type { CodexMessage, CodexParsedRequest } from "../../types";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function messagesHash(messages: CodexMessage[]): string {
  // Parser timestamps are local arrival times, not canonical message identity.
  return hash(messages.map(({ timestamp: _timestamp, ...message }) => message));
}
function answerText(message: CodexMessage): string | undefined {
  if (message.role !== "assistant" || message.content.some(part => part.type === "toolCall")) return undefined;
  return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").replaceAll("\r\n", "\n").trimEnd();
}
const policyHash = (parsed: CodexParsedRequest): string => hash({
  model: parsed.modelId,
  options: parsed.options,
  family: parsed._chatgptModelFamily,
  system: parsed.context.systemPrompt,
  tools: parsed.context.tools,
  policy: WEB_CONTEXT_POLICY_VERSION,
});
export const retainedProofLedgerPath = () => join(getConfigDir(), "runtime", "retained-followup-proofs.json");
type Proof = { prefixLength: number; prefixHash: string; policyHash: string; answerHash: string; at: number };
export type RetainedReuseReason = "verified" | "proof_missing" | "ledger_invalid" | "ledger_io_failed" | "proof_expired"
  | "policy_changed" | "ancestry_changed" | "answer_boundary_changed" | "answer_changed";
type ReuseCheck = { reason: RetainedReuseReason; parsed?: CodexParsedRequest };
/** A verified retained browser tab can legitimately survive multi-hour Codex goal turns.
 * The launcher still verifies the exact surface on every reuse; expiration is
 * a bounded failsafe, not a substitute for canonical ancestry/owner proof. */
const TTL_MS = 24 * 60 * 60_000;
const digestPattern = /^[a-f0-9]{64}$/;

/** Hashes prove canonical ancestry; the launcher must independently prove its owned surface. */
export class RetainedConversationProofStore {
  private readonly proofs = new Map<string, Proof>();
  private persistenceFailed = false;
  constructor(private readonly now: () => number = Date.now, private readonly file?: () => string) {}
  private load(): boolean {
    if (!this.file) return true;
    this.proofs.clear();
    try {
      const file = this.file();
      if (!existsSync(file)) return true;
      if (statSync(file).size > 512 * 1024) return false;
      const ledger = JSON.parse(readFileSync(file, "utf8"));
      if (ledger.version !== 1 || !Array.isArray(ledger.proofs) || ledger.proofs.length > 512) return false;
      for (const entry of ledger.proofs) {
        const { key, integrity, ...proof } = entry;
        if (typeof key !== "string" || !digestPattern.test(key) || this.proofs.has(key)
          || !Number.isSafeInteger(proof.prefixLength) || proof.prefixLength <= 0
          || !Number.isFinite(proof.at) || proof.at < 0
          || ![proof.prefixHash, proof.policyHash, proof.answerHash].every(value => typeof value === "string" && digestPattern.test(value))
          || integrity !== hash({ key, ...proof })
          || Object.keys(proof).length !== 5) { this.proofs.clear(); return false; }
        this.proofs.set(key, proof);
      }
      return true;
    } catch { this.proofs.clear(); return false; }
  }
  private save(): boolean {
    if (!this.file) return true;
    try {
      atomicWriteFile(this.file(), JSON.stringify({ version: 1,
        proofs: [...this.proofs].map(([key, proof]) => ({ key, ...proof, integrity: hash({ key, ...proof }) })) }), { durable: true });
      this.persistenceFailed = false;
      return true;
    } catch {
      // A failed reuse optimization must not turn an accepted final answer into a replayable error.
      this.proofs.clear();
      this.persistenceFailed = true;
      return false;
    }
  }
  commit(key: string, parsed: CodexParsedRequest, answer: string): boolean {
    // A newly accepted canonical Web Send may repair an invalid old ledger;
    // only reusable ancestry needs a previously valid proof.
    this.load();
    this.prune();
    const messages = parsed.context.messages;
    const prefixLength = messages.length;
    const prefixHash = messagesHash(messages);
    const currentPolicyHash = policyHash(parsed);
    const answerHash = hash(answer.replaceAll("\r\n", "\n").trimEnd());
    const previous = this.proofs.get(key);
    if (previous && previous.policyHash === currentPolicyHash) {
      // Completion events can arrive after a newer /goal follow-up has already
      // committed. Never let a stale observer roll the retained browser head
      // back to an older canonical prefix, which would force an over-budget
      // cold bootstrap on the next turn.
      if (prefixLength < previous.prefixLength) return false;
      if (prefixLength === previous.prefixLength) {
        // An exact duplicate is idempotent; a competing answer or ancestry
        // must not displace the already committed browser response.
        if (prefixHash !== previous.prefixHash || answerHash !== previous.answerHash) return false;
        return this.save();
      }
      // A longer history must include the exact prior canonical input and
      // final reply at their original boundary. Do not accept an unrelated
      // branch merely because its message count increased.
      const priorAnswer = answerText(messages[previous.prefixLength]!);
      if (messagesHash(messages.slice(0, previous.prefixLength)) !== previous.prefixHash
        || !priorAnswer || hash(priorAnswer) !== previous.answerHash) return false;
    }
    // A policy change is a cold bootstrap, handled by launcher retirement.
    // That path explicitly invalidates the old proof before committing anew.
    this.proofs.delete(key);
    this.proofs.set(key, { prefixLength, prefixHash, policyHash: currentPolicyHash,
      answerHash, at: this.now() });
    this.prune();
    return this.save();
  }
  resume(key: string, parsed: CodexParsedRequest): CodexParsedRequest | undefined {
    return this.check(key, parsed).parsed;
  }
  invalidate(key: string): void {
    this.load();
    this.proofs.delete(key);
    this.save();
  }
  check(key: string, parsed: CodexParsedRequest): ReuseCheck {
    if (this.persistenceFailed) return { reason: "ledger_io_failed" };
    if (!this.load()) return { reason: "ledger_invalid" };
    const proof = this.proofs.get(key);
    if (proof && (this.now() < proof.at || this.now() - proof.at > TTL_MS)) {
      this.proofs.delete(key);
      return { reason: "proof_expired" };
    }
    this.prune();
    if (!proof) return { reason: "proof_missing" };
    if (policyHash(parsed) !== proof.policyHash) return { reason: "policy_changed" };
    const messages = parsed.context.messages;
    if (messages.length <= proof.prefixLength
      || messagesHash(messages.slice(0, proof.prefixLength)) !== proof.prefixHash) return { reason: "ancestry_changed" };
    // The accepted Web answer is anchored at the exact recorded prefix
    // boundary. Finding the LAST assistant anywhere in the new request is
    // incorrect: a later Codex tool/assistant round may append more messages.
    // Those later messages remain in the retained suffix, never omitted.
    const boundary = proof.prefixLength;
    if (boundary === messages.length - 1) return { reason: "answer_boundary_changed" };
    // An assistant tool call is not a final-answer boundary. Validate the
    // precise previously accepted answer, not a later uncommitted assistant.
    const terminal=messages[boundary]!;
    if (terminal.role !== "assistant" || terminal.content.some(part => part.type === "toolCall"))
      return { reason: "answer_boundary_changed" };
    const answer = answerText(terminal);
    if (!answer || hash(answer) !== proof.answerHash) return { reason: "answer_changed" };
    return { reason: "verified", parsed: { ...parsed, context: { ...parsed.context, messages: messages.slice(boundary + 1) } } };
  }
  private prune(): void {
    for (const [key, proof] of this.proofs) if (this.now() < proof.at || this.now() - proof.at > TTL_MS) this.proofs.delete(key);
    while (this.proofs.size > 512) this.proofs.delete(this.proofs.keys().next().value!);
  }
}

/** Durable optimization only; launcher ownership remains independently required. */
export const retainedConversationProofs = new RetainedConversationProofStore(Date.now, retainedProofLedgerPath);
