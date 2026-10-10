import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { atomicWriteFile } from "../../config";
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
type Proof = { prefixLength: number; prefixHash: string; policyHash: string; answerHash: string; at: number };
export type RetainedReuseReason = "verified" | "proof_missing" | "ledger_invalid" | "ledger_io_failed" | "proof_expired"
  | "policy_changed" | "ancestry_changed" | "answer_boundary_changed" | "answer_changed";
type ReuseCheck = { reason: RetainedReuseReason; parsed?: CodexParsedRequest };
const TTL_MS = 30 * 60_000;
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
    this.load();
    this.prune();
    this.proofs.delete(key);
    this.proofs.set(key, { prefixLength: parsed.context.messages.length,
      prefixHash: messagesHash(parsed.context.messages), policyHash: hash(parsed.context.systemPrompt ?? []),
      answerHash: hash(answer.replaceAll("\r\n", "\n").trimEnd()), at: this.now() });
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
    if (hash(parsed.context.systemPrompt ?? []) !== proof.policyHash) return { reason: "policy_changed" };
    const messages = parsed.context.messages;
    if (messages.length <= proof.prefixLength
      || messagesHash(messages.slice(0, proof.prefixLength)) !== proof.prefixHash) return { reason: "ancestry_changed" };
    const boundary = messages.findLastIndex(message => message.role === "assistant");
    // Everything before the terminal answer was committed from the final canonical tool round.
    // Skipping newly inserted messages could silently discard tool results or a foreign user turn.
    if (boundary !== proof.prefixLength || boundary === messages.length - 1) return { reason: "answer_boundary_changed" };
    const answer = answerText(messages[boundary]!);
    if (!answer || hash(answer) !== proof.answerHash) return { reason: "answer_changed" };
    return { reason: "verified", parsed: { ...parsed, context: { ...parsed.context, messages: messages.slice(boundary + 1) } } };
  }
  private prune(): void {
    for (const [key, proof] of this.proofs) if (this.now() < proof.at || this.now() - proof.at > TTL_MS) this.proofs.delete(key);
    while (this.proofs.size > 512) this.proofs.delete(this.proofs.keys().next().value!);
  }
}
