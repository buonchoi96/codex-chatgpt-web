import { createHash } from "node:crypto";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

function messageText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

/** Native compaction remains part of the exact identity of a replayed Codex turn. */
function compactionEpoch(input: unknown[] | undefined): unknown {
  return input?.findLast(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.type === "compaction"
      || record.type === "compaction_summary"
      || record.type === "context_compaction"
      || (record.role === "user" && messageText(record)?.startsWith(`${SUMMARY_PREFIX}\n`));
  }) ?? null;
}

export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
    compaction: compactionEpoch(raw?.input),
  })).digest("hex");
}

/**
 * Luna normally uses a fresh ChatGPT surface per native turn so completed browser history does not
 * accumulate across native turns. A retry inside the SAME native turn is different: the retained
 * surface already owns the potentially large tool transcript for that active Codex turn.
 * Scope this recovery key to thread+turn so a transient browser failure can reuse only that exact
 * active turn, while the next user turn still starts from a fresh Luna surface.
 */
export function chatGptActiveTurnRecoveryConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) return undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    purpose: "active-turn-recovery",
    threadId: identity.threadId,
    turnId: identity.turnId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
  })).digest("hex");
}

/**
 * The retained browser conversation already owns the active Luna turn's complete task and tool
 * transcript. A physical retry therefore needs only a new transport capability, never a replay of
 * the canonical current-turn history that may already contain hundreds of tool results.
 */
export function retainedActiveTurnRecoveryRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest {
  return {
    ...parsed,
    context: {
      ...parsed.context,
      systemPrompt: [],
      messages: [],
    },
  };
}

/** Full history remains canonical; a retained epoch receives only the suffix after its last assistant reply. */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest | undefined {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  if (lastAssistant < 0 || lastAssistant === parsed.context.messages.length - 1) return undefined;
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: parsed.context.messages.slice(lastAssistant + 1),
    },
  };
}
