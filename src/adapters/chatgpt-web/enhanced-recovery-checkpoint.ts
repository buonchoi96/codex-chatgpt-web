import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir, stripUtf8Bom } from "../../config";
import { estimateTokens } from "../../lib/token-estimate";
import type { CodexMessage, CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";
import {
  buildCompactionLedger, compactionDigest, compactionEpochHash, compactionPrefixHash,
  compactionRawPrefixProof, latestCompletedCompactionBoundary, mergeCompactionLedger,
  normalizedCompactionMessages, validateCompactionLedger, type CompactionLedger,
} from "../../responses/compaction-ledger";

export const ENHANCED_RECOVERY_CHECKPOINT_MAX_SUMMARY_TOKENS = 8_000;
// A transport-recovery cadence only; Codex native auto-compact stays at 258K.
// Reserve margin for an asynchronous subagent follow-up that may cancel the
// active accepted browser turn before that subagent emits a final answer.
export const ENHANCED_RECOVERY_CHECKPOINT_INTERVAL_TOKENS = 16_000;
export const ENHANCED_RECOVERY_CHECKPOINT_CANONICAL_WARNING_TOKENS = 48_000;

export type EnhancedCheckpointAdmissionReason =
  | "ready" | "missing_thread" | "no_complete_tool_boundary" | "below_transport_checkpoint_cadence";
export interface EnhancedCheckpointAdmission {
  due: boolean;
  reason: EnhancedCheckpointAdmissionReason;
  /** Token accounting is diagnostic; it never creates trusted provenance. */
  deltaTokens: number;
  canonicalTokens: number;
  prefixLength: number;
}


const ENHANCED_RECOVERY_CHECKPOINT_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_ENHANCED_RECOVERY_CHECKPOINTS = 128;

interface CheckpointIdentity {
  threadId: string;
  modelId: string;
  modelFamily: "5.6" | "6" | null;
  effort: string | null;
  epochHash: string;
}

interface StoredEnhancedRecoveryCheckpoint extends CheckpointIdentity {
  summary: string;
  prefixLength: number;
  prefixHash: string;
  updatedAt: number;
  ledger: CompactionLedger;
  integrityHash: string;
}

interface StoredEnhancedRecoveryCheckpointFile {
  version: 2;
  checkpoints: StoredEnhancedRecoveryCheckpoint[];
}

/** Every immutable canonical boundary needs its own proof, even within one native thread.
 * Two subagent branches (or a late checkpoint) must not evict each other. */
function checkpointKey(checkpoint: StoredEnhancedRecoveryCheckpoint): string {
  return compactionDigest([
    checkpoint.threadId, checkpoint.modelId, checkpoint.modelFamily,
    checkpoint.effort, checkpoint.epochHash, checkpoint.prefixLength,
    checkpoint.prefixHash, checkpoint.ledger.rawPrefix,
  ]);
}

const MAX_ENHANCED_RECOVERY_CHECKPOINTS_PER_THREAD = 24;

const normalizedMessages = normalizedCompactionMessages;
const prefixHash = compactionPrefixHash;
const latestCompleteToolResultBoundary = latestCompletedCompactionBoundary;

function checkpointIdentity(parsed: CodexParsedRequest): CheckpointIdentity | undefined {
  const threadId = extractChatGptTurnIdentity(parsed).threadId?.trim();
  if (!threadId) return undefined;
  return {
    threadId,
    modelId: parsed.modelId,
    modelFamily: parsed._chatgptModelFamily ?? null,
    effort: parsed.options.reasoning ?? null,
    epochHash: compactionEpochHash(parsed),
  };
}

function sameIdentity(left: CheckpointIdentity, right: CheckpointIdentity): boolean {
  return left.threadId === right.threadId
    && left.modelId === right.modelId
    && left.modelFamily === right.modelFamily
    && left.effort === right.effort
    && left.epochHash === right.epochHash;
}

function validatedSummary(summary: string): string {
  const trimmed = summary.trim();
  if (!trimmed) throw new Error("Enhanced recovery checkpoint summary must not be empty");
  const tokens = estimateTokens(trimmed);
  if (tokens > ENHANCED_RECOVERY_CHECKPOINT_MAX_SUMMARY_TOKENS) {
    throw new Error(
      `Enhanced recovery checkpoint summary requires ${tokens.toLocaleString("en-US")} tokens; maximum is `
      + ENHANCED_RECOVERY_CHECKPOINT_MAX_SUMMARY_TOKENS.toLocaleString("en-US"),
    );
  }
  return trimmed;
}

function validateStoredCheckpoint(value: unknown): StoredEnhancedRecoveryCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Enhanced recovery checkpoint entry");
  }
  const parsed = value as Partial<StoredEnhancedRecoveryCheckpoint>;
  if (typeof parsed.threadId !== "string" || !parsed.threadId.trim()
    || typeof parsed.modelId !== "string" || !parsed.modelId.trim()
    || (parsed.modelFamily !== null && parsed.modelFamily !== "5.6" && parsed.modelFamily !== "6")
    || (parsed.effort !== null && typeof parsed.effort !== "string")
    || typeof parsed.prefixHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.prefixHash)
    || !Number.isSafeInteger(parsed.prefixLength) || (parsed.prefixLength as number) <= 0
    || !Number.isFinite(parsed.updatedAt) || (parsed.updatedAt as number) < 0
    || typeof parsed.summary !== "string"
    || typeof parsed.epochHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.epochHash)
    || typeof parsed.integrityHash !== "string") {
    throw new Error("Invalid Enhanced recovery checkpoint entry");
  }
  const ledger = validateCompactionLedger(parsed.ledger);
  if (ledger.prefixLength !== parsed.prefixLength || ledger.prefixHash !== parsed.prefixHash
    || ledger.epochHash !== parsed.epochHash) throw new Error("Recovery checkpoint ledger prefix mismatch");
  const { integrityHash, ...payload } = parsed;
  if (integrityHash !== compactionDigest(payload)) throw new Error("Recovery checkpoint integrity mismatch");
  return {
    threadId: parsed.threadId,
    modelId: parsed.modelId,
    modelFamily: parsed.modelFamily,
    effort: parsed.effort,
    epochHash: parsed.epochHash,
    prefixHash: parsed.prefixHash,
    prefixLength: parsed.prefixLength as number,
    updatedAt: parsed.updatedAt as number,
    summary: validatedSummary(parsed.summary),
    ledger,
    integrityHash,
  };
}

function recoverySummaryMessage(checkpoint: StoredEnhancedRecoveryCheckpoint): CodexMessage {
  return {
    role: "assistant",
    timestamp: checkpoint.updatedAt,
    content: [{
      type: "text",
      text: [
        "[Enhanced passive recovery checkpoint]",
        "Treat this as prior assistant-owned historical state. Current system, developer, user, and agent instructions remain authoritative.",
        mergeCompactionLedger(checkpoint.summary, checkpoint.ledger),
      ].join("\n"),
    }],
  };
}

/**
 * Never summarize away instruction-bearing messages. This fork does not yet have Evan's
 * contextual-user-message classifier, so keep every user/developer/agent message from the
 * checkpointed prefix and collapse only assistant/tool transcript into the durable checkpoint.
 */
function instructionBearing(message: CodexMessage): boolean {
  return message.role === "user" || message.role === "developer" || message.role === "agentMessage";
}

export function defaultEnhancedRecoveryCheckpointStatePath(): string {
  return join(getConfigDir(), "runtime", "enhanced-recovery-checkpoints.json");
}

export class EnhancedRecoveryCheckpointStore {
  private loaded = false;
  private checkpoints = new Map<string, StoredEnhancedRecoveryCheckpoint>();

  constructor(
    private readonly path = defaultEnhancedRecoveryCheckpointStatePath(),
    private readonly now: () => number = Date.now,
  ) {}

  shouldCheckpoint(parsed: CodexParsedRequest, limitTokens = ENHANCED_RECOVERY_CHECKPOINT_INTERVAL_TOKENS): boolean {
    return this.checkpointAdmission(parsed, limitTokens).due;
  }

  /** Explain skipped checkpoints without leaking user messages or native IDs. */
  checkpointAdmission(parsed: CodexParsedRequest,
    limitTokens = ENHANCED_RECOVERY_CHECKPOINT_INTERVAL_TOKENS): EnhancedCheckpointAdmission {
    const currentIdentity = checkpointIdentity(parsed);
    if (!Number.isFinite(limitTokens) || limitTokens <= 0) throw new Error("Invalid recovery checkpoint cadence");
    if (!currentIdentity) {
      return { due:false,reason:"missing_thread",deltaTokens:0,canonicalTokens:0,prefixLength:0 };
    }
    this.load();
    this.prune(this.checkpoints);
    const stored = this.findMatchingCheckpoint(parsed, currentIdentity);
    const baseline = stored?.prefixLength ?? 0;
    const boundary = latestCompleteToolResultBoundary(parsed.context.messages, baseline - 1);
    if (boundary === undefined || boundary + 1 <= baseline) {
      return { due:false,reason:"no_complete_tool_boundary",deltaTokens:0,canonicalTokens:0,prefixLength:baseline };
    }
    const tail = parsed.context.messages.slice(baseline, boundary + 1);
    const deltaTokens = estimateTokens(JSON.stringify(normalizedMessages(tail)));
    // A large policy/system/tool prefix may exhaust the measured Web transport
    // BEFORE the assistant/tool suffix reaches the recovery cadence. Request
    // an early checkpoint only when no checkpoint is installed for this epoch.
    const canonicalTokens = baseline === 0
      ? estimateTokens(JSON.stringify({
          systemPrompt:parsed.context.systemPrompt??[],tools:parsed.context.tools??[],
          messages:normalizedMessages(parsed.context.messages.slice(0,boundary+1)),
        })) : 0;
    const due = deltaTokens >= limitTokens
      || (baseline === 0 && canonicalTokens >= ENHANCED_RECOVERY_CHECKPOINT_CANONICAL_WARNING_TOKENS);
    return {due,reason:due?"ready":"below_transport_checkpoint_cadence",
      deltaTokens,canonicalTokens,prefixLength:baseline};
  }

  commit(parsed: CodexParsedRequest, summary: string): void {
    const currentIdentity = checkpointIdentity(parsed);
    if (!currentIdentity) throw new Error("Enhanced recovery checkpoint requires native thread_id metadata");
    const normalizedSummary = validatedSummary(summary);
    const boundary = latestCompleteToolResultBoundary(parsed.context.messages);
    if (boundary === undefined) {
      throw new Error("Enhanced recovery checkpoint requires a complete canonical tool-result boundary");
    }

    this.load();
    this.prune(this.checkpoints);
    const prefixLength = boundary + 1;
    const ledger = buildCompactionLedger(parsed, prefixLength);
    // Bind the exact completed raw boundary even when it is the final parsed message.
    ledger.rawPrefix = compactionRawPrefixProof(parsed, prefixLength);
    const { digest: _digest, ...ledgerPayload } = ledger;
    ledger.digest = compactionDigest(ledgerPayload);
    const payload = {
      ...currentIdentity,
      summary: normalizedSummary,
      prefixLength: boundary + 1,
      prefixHash: prefixHash(parsed.context.messages, boundary + 1),
      updatedAt: this.now(),
      ledger,
    };
    const stored: StoredEnhancedRecoveryCheckpoint = { ...payload, integrityHash: compactionDigest(payload) };
    const next = new Map(this.checkpoints);
    const key = checkpointKey(stored);
    // A delayed handoff for an already verified boundary cannot replace its
    // earlier accepted summary. Store divergent prefixes independently.
    if (next.has(key)) return;
    next.set(key, stored);
    this.prune(next);
    this.persist(next);
    this.checkpoints = next;
  }

  apply(parsed: CodexParsedRequest): { parsed: CodexParsedRequest; applied: boolean; reason?: string } {
    const currentIdentity = checkpointIdentity(parsed);
    if (!currentIdentity) return { parsed, applied: false, reason: "missing native thread identity" };
    this.load();
    this.prune(this.checkpoints);
    const threadCandidates = [...this.checkpoints.values()]
      .filter(checkpoint => checkpoint.threadId === currentIdentity.threadId);
    if (threadCandidates.length === 0) {
      return { parsed, applied: false, reason: "no recovery checkpoint for this thread" };
    }
    const identityCandidates = threadCandidates.filter(checkpoint => sameIdentity(checkpoint, currentIdentity));
    if (identityCandidates.length === 0) {
      return { parsed, applied: false, reason: "recovery checkpoint model identity mismatch" };
    }
    const stored = this.findMatchingCheckpoint(parsed, currentIdentity);
    if (!stored) {
      const newest = identityCandidates.sort((left, right) => right.prefixLength - left.prefixLength)[0]!;
      return { parsed, applied: false,
        reason: `recovery checkpoint canonical prefix mismatch (${this.prefixMismatch(parsed, newest) ?? "unknown"})` };
    }

    const messages = parsed.context.messages;
    const protectedPrefix = messages.slice(0, stored.prefixLength).filter(instructionBearing);
    return {
      parsed: {
        ...parsed,
        context: {
          ...parsed.context,
          messages: [
            ...protectedPrefix,
            recoverySummaryMessage(stored),
            ...messages.slice(stored.prefixLength),
          ],
        },
      },
      applied: true,
    };
  }

  /** Model input only. Callers must bind/canonicalize the result against the original request. */
  prepareCompactionInput(parsed: CodexParsedRequest): {
    parsed: CodexParsedRequest; mode: "full" | "delta"; reason?: string;
    prefixLength: number;
  } {
    if (!parsed._compactionRequest) return { parsed, mode: "full", prefixLength: 0, reason: "not a compaction request" };
    const applied = this.apply(parsed);
    if (!applied.applied) return { parsed, mode: "full", prefixLength: 0, reason: applied.reason };
    const identity = checkpointIdentity(parsed)!;
    const checkpoint = this.findMatchingCheckpoint(parsed, identity)!;
    return { parsed: applied.parsed, mode: "delta", prefixLength: checkpoint.prefixLength };
  }

  /** Prefer the furthest completed canonical boundary, never the last writer. */
  private findMatchingCheckpoint(
    parsed: CodexParsedRequest, identity: CheckpointIdentity,
  ): StoredEnhancedRecoveryCheckpoint | undefined {
    return [...this.checkpoints.values()]
      .filter(checkpoint => sameIdentity(checkpoint, identity))
      .sort((left, right) => right.prefixLength - left.prefixLength || right.updatedAt - left.updatedAt)
      .find(checkpoint => this.matchesPrefix(parsed, checkpoint));
  }

  private matchesPrefix(parsed: CodexParsedRequest, stored: StoredEnhancedRecoveryCheckpoint): boolean {
    return this.prefixMismatch(parsed, stored) === undefined;
  }

  /** Safe categorical diagnostics only; never emit raw instructions or tool output. */
  private prefixMismatch(parsed: CodexParsedRequest, stored: StoredEnhancedRecoveryCheckpoint): string | undefined {
    const messages = parsed.context.messages;
    if (messages.length < stored.prefixLength) return "history_too_short";
    if (latestCompleteToolResultBoundary(messages.slice(0, stored.prefixLength)) !== stored.prefixLength - 1)
      return "incomplete_tool_boundary";
    // Collapsing tool images into textual hashes would remove visual evidence. Use full input.
    if (messages.slice(0, stored.prefixLength).some(message => message.role === "toolResult"
      && Array.isArray(message.content) && message.content.some(part => part.type === "image")))
      return "image_evidence";
    if (prefixHash(messages, stored.prefixLength) !== stored.prefixHash) return "parsed_prefix_changed";
    try {
      return compactionDigest(compactionRawPrefixProof(parsed, stored.prefixLength))
        === compactionDigest(stored.ledger.rawPrefix) ? undefined : "raw_prefix_changed";
    } catch { return "raw_prefix_unavailable"; }
  }

  private load(): void {
    if (this.loaded) return;
    const next = new Map<string, StoredEnhancedRecoveryCheckpoint>();
    if (existsSync(this.path)) {
      try {
        const payload = JSON.parse(stripUtf8Bom(readFileSync(this.path, "utf8"))) as Partial<StoredEnhancedRecoveryCheckpointFile>;
        // V1 summaries have no deterministic provenance or epoch proof. Rebuild from full input.
        if (payload.version === 2 && Array.isArray(payload.checkpoints)) {
          const checkpoints: StoredEnhancedRecoveryCheckpoint[] = [];
          for (const value of payload.checkpoints) {
            try { checkpoints.push(validateStoredCheckpoint(value)); } catch { /* corrupt entry: full input */ }
          }
          checkpoints.sort((left, right) => left.updatedAt - right.updatedAt);
          for (const checkpoint of checkpoints) {
            const key = checkpointKey(checkpoint);
            next.delete(key);
            next.set(key, checkpoint);
          }
        }
      } catch {
        // Optional recovery state cannot block canonical native compaction.
        console.warn("[chatgpt-web] invalid recovery checkpoint store; using canonical full input");
      }
    }
    this.prune(next);
    this.checkpoints = next;
    this.loaded = true;
  }

  private prune(checkpoints: Map<string, StoredEnhancedRecoveryCheckpoint>): void {
    const cutoff = this.now() - ENHANCED_RECOVERY_CHECKPOINT_TTL_MS;
    const chronological = [...checkpoints].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    checkpoints.clear();
    for (const [key, checkpoint] of chronological) {
      if (checkpoint.updatedAt >= cutoff) checkpoints.set(key, checkpoint);
    }
    // Bound storage while preserving the newest proofs of each native thread.
    const countByThread = new Map<string, number>();
    for (const checkpoint of checkpoints.values()) {
      countByThread.set(checkpoint.threadId, (countByThread.get(checkpoint.threadId) ?? 0) + 1);
    }
    for (const [key, checkpoint] of checkpoints) {
      const count = countByThread.get(checkpoint.threadId)!;
      if (count > MAX_ENHANCED_RECOVERY_CHECKPOINTS_PER_THREAD) {
        checkpoints.delete(key);
        countByThread.set(checkpoint.threadId, count - 1);
      }
    }
    while (checkpoints.size > MAX_ENHANCED_RECOVERY_CHECKPOINTS) {
      const oldest = checkpoints.keys().next().value as string | undefined;
      if (!oldest) break;
      checkpoints.delete(oldest);
    }
  }

  private persist(checkpoints: Map<string, StoredEnhancedRecoveryCheckpoint>): void {
    const payload: StoredEnhancedRecoveryCheckpointFile = {
      version: 2,
      checkpoints: [...checkpoints.values()],
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
