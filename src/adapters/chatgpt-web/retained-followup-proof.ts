import { createHash } from "node:crypto";
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

/** Canonical ancestry proof, separate from physical page proof. Cache loss means fresh full context. */
export class RetainedConversationProofStore {
  private readonly proofs = new Map<string, Proof>();
  constructor(private readonly now: () => number = Date.now) {}
  commit(key: string, parsed: CodexParsedRequest, answer: string): void {
    this.prune();
    this.proofs.delete(key);
    this.proofs.set(key, { prefixLength: parsed.context.messages.length,
      prefixHash: messagesHash(parsed.context.messages), policyHash: hash(parsed.context.systemPrompt ?? []),
      answerHash: hash(answer.replaceAll("\r\n", "\n").trimEnd()), at: this.now() });
    this.prune();
  }
  resume(key: string, parsed: CodexParsedRequest): CodexParsedRequest | undefined {
    this.prune();
    const proof = this.proofs.get(key);
    if (!proof || hash(parsed.context.systemPrompt ?? []) !== proof.policyHash) return undefined;
    const messages = parsed.context.messages;
    if (messages.length <= proof.prefixLength
      || messagesHash(messages.slice(0, proof.prefixLength)) !== proof.prefixHash) return undefined;
    const boundary = messages.findLastIndex(message => message.role === "assistant");
    // Everything before the terminal answer was committed from the final canonical tool round.
    // Skipping newly inserted messages could silently discard tool results or a foreign user turn.
    if (boundary !== proof.prefixLength || boundary === messages.length - 1) return undefined;
    const answer = answerText(messages[boundary]!);
    if (!answer || hash(answer) !== proof.answerHash) return undefined;
    return { ...parsed, context: { ...parsed.context, messages: messages.slice(boundary + 1) } };
  }
  private prune(): void {
    for (const [key, proof] of this.proofs) if (this.now() - proof.at > 30 * 60_000) this.proofs.delete(key);
    while (this.proofs.size > 512) this.proofs.delete(this.proofs.keys().next().value!);
  }
}
