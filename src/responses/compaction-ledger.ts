import { createHash } from "node:crypto";
import { SUMMARY_PREFIX } from "./compaction";
import type { CodexMessage, CodexParsedRequest, CodexToolCall } from "../types";

export const COMPACTION_LEDGER_MARKER = "CODEX_COMPACTION_LEDGER_V2";
export const MAX_COMPACTION_LEDGER_BYTES = 256_000;
const MAX_EXACT_ARGUMENT_BYTES = 2_048;

export function compactionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

export function normalizedCompactionMessages(messages: readonly CodexMessage[]): unknown[] {
  return messages.map(({ timestamp: _timestamp, ...message }) => message);
}

/** Keep the existing checkpoint proof format; timestamps are transport state. */
export function compactionPrefixHash(messages: readonly CodexMessage[], length: number): string {
  return compactionDigest(normalizedCompactionMessages(messages.slice(0, length)));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => {
    const value = record(part);
    return typeof value?.text === "string" ? [value.text] : [];
  }).join("\n");
}

export function compactionEpochHash(parsed: CodexParsedRequest): string {
  const input = record(parsed._rawBody)?.input;
  if (Array.isArray(input)) {
    return compactionDigest(input.findLast(value => {
      const item = record(value);
      return item && (item.type === "compaction" || item.type === "compaction_summary"
        || item.type === "context_compaction"
        || (item.role === "user" && text(item.content).startsWith(`${SUMMARY_PREFIX}\n`)));
    }) ?? null);
  }
  const summary = parsed.context.messages.findLast(message => message.role === "user"
    && text(message.content).startsWith(`${SUMMARY_PREFIX}\n`));
  return compactionDigest(summary ? text(summary.content) : null);
}

/** Invalid duplicate/orphan IDs poison the prefix; never compact across an ambiguous execution. */
export function latestCompletedCompactionBoundary(messages: readonly CodexMessage[], after = -1): number | undefined {
  const pending = new Set<string>();
  const seen = new Set<string>();
  let latest: number | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        if (!part.id || seen.has(part.id)) return latest;
        pending.add(part.id);
        seen.add(part.id);
      }
    } else if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) return latest;
      if (pending.size === 0 && index > after) latest = index;
    }
  }
  return latest;
}

export interface CompactionRawPrefixProof {
  length: number;
  hash: string;
  available: boolean;
}

/** Parsed assistant holders can group raw calls; bind the raw prefix at the same result ID. */
export function compactionRawPrefixProof(parsed: CodexParsedRequest, length: number): CompactionRawPrefixProof {
  const input = record(parsed._rawBody)?.input;
  if (!Array.isArray(input)) return { length: 0, hash: compactionDigest([]), available: false };
  const boundary = parsed.context.messages[length - 1];
  if (boundary?.role !== "toolResult") throw new Error("Raw compaction proof requires a tool-result boundary");
  const indices = input.flatMap((value, index) => {
    const item = record(value);
    return item?.call_id === boundary.toolCallId && isRawResult(item) ? [index] : [];
  });
  if (indices.length !== 1) throw new Error("Raw compaction prefix has no unique canonical result boundary");
  const rawLength = indices[0]! + 1;
  return { length: rawLength, hash: compactionDigest(input.slice(0, rawLength)), available: true };
}

function isRawCall(item: Record<string, unknown>): boolean {
  return item.type === "function_call" || item.type === "custom_tool_call"
    || item.type === "local_shell_call" || item.type === "tool_search_call";
}

function isRawResult(item: Record<string, unknown>): boolean {
  return item.type === "function_call_output" || item.type === "custom_tool_call_output" || item.type === "tool_search_output";
}

export interface CompactionLedgerTool {
  callId: string;
  name: string;
  namespace?: string;
  callMessage: number;
  argumentsHash: string;
  arguments?: Record<string, unknown>;
  resultMessage?: number;
  resultHash?: string;
  status: "pending" | "result_received" | "error";
  isError?: boolean;
  execution: "unknown" | "running" | "completed" | "error";
  raw?: { callHash?: string; resultHash?: string; callItemId?: string; resultItemId?: string; callStatus?: unknown; resultStatus?: unknown; arguments?: unknown };
  returnedLines?: { path: string; start: number; end: number };
}

export interface CompactionLedger {
  version: 2;
  prefixLength: number;
  prefixHash: string;
  epochHash: string;
  rawPrefix: CompactionRawPrefixProof;
  tools: CompactionLedgerTool[];
  exactLiterals: string[];
  digest: string;
}

function small(value: unknown, limit = MAX_EXACT_ARGUMENT_BYTES): boolean {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8") <= limit;
}

function structuredResult(content: unknown): Record<string, unknown> | undefined {
  if (typeof content !== "string") return undefined;
  try { return record(JSON.parse(content)); } catch { return undefined; }
}

/** Mechanical provenance only. A returned result is not proof a native GUI action succeeded. */
export function buildCompactionLedger(parsed: CodexParsedRequest, prefixLength = parsed.context.messages.length): CompactionLedger {
  const messages = parsed.context.messages.slice(0, prefixLength);
  const rawInput = record(parsed._rawBody)?.input;
  // Full handoffs may end at a user/assistant message rather than a tool result.
  const rawPrefix = prefixLength === parsed.context.messages.length && Array.isArray(rawInput)
    ? { length: rawInput.length, hash: compactionDigest(rawInput), available: true }
    : compactionRawPrefixProof(parsed, prefixLength);
  const rawById = new Map<string, { call?: Record<string, unknown>; result?: Record<string, unknown> }>();
  if (Array.isArray(rawInput)) {
    for (const value of rawInput.slice(0, rawPrefix.length)) {
      const item = record(value);
      if (!item || (!isRawCall(item) && !isRawResult(item))) continue;
      const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined;
      if (!id) throw new Error("Compaction ledger raw tool has no ID");
      const pair = rawById.get(id) ?? {};
      const field = isRawCall(item) ? "call" : "result";
      if (pair[field]) throw new Error("Compaction ledger has duplicate raw tool IDs");
      pair[field] = item;
      rawById.set(id, pair);
    }
  }
  const tools: CompactionLedgerTool[] = [];
  const byId = new Map<string, CompactionLedgerTool>();
  const literals = new Set<string>();
  const addLiterals = (value: string) => {
    for (const match of value.matchAll(/\b(?:[a-fA-F0-9]{7,128}|[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\b/g)) {
      literals.add(match[0]);
      if (literals.size > 4096) throw new Error("Compaction ledger literal capacity exceeded");
    }
  };
  const addCall = (call: CodexToolCall, index: number) => {
    if (!call.id || byId.has(call.id)) throw new Error("Compaction ledger has duplicate parsed tool IDs");
    const raw = rawById.get(call.id);
    const entry: CompactionLedgerTool = {
      callId: call.id, name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}),
      callMessage: index, argumentsHash: compactionDigest(call.arguments),
      ...(small(call.arguments) ? { arguments: structuredClone(call.arguments) } : {}),
      status: "pending", execution: "unknown",
    };
    if (raw) {
      entry.raw = {
        ...(raw.call ? { callHash: compactionDigest(raw.call) } : {}),
        ...(raw.result ? { resultHash: compactionDigest(raw.result) } : {}),
        ...(typeof raw.call?.id === "string" ? { callItemId: raw.call.id } : {}),
        ...(typeof raw.result?.id === "string" ? { resultItemId: raw.result.id } : {}),
        ...(raw.call?.status !== undefined ? { callStatus: raw.call.status } : {}),
        ...(raw.result?.status !== undefined ? { resultStatus: raw.result.status } : {}),
        ...(raw.call?.arguments !== undefined && small(raw.call.arguments) ? { arguments: raw.call.arguments } : {}),
        ...(raw.call?.input !== undefined && small(raw.call.input) ? { arguments: raw.call.input } : {}),
      };
      addLiterals(JSON.stringify(raw.call));
    }
    addLiterals(JSON.stringify(call.arguments));
    tools.push(entry);
    byId.set(call.id, entry);
    if (tools.length > 4096) throw new Error("Compaction ledger tool capacity exceeded");
  };
  messages.forEach((message, index) => {
    addLiterals(text(message.content));
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") addCall(part, index);
    } else if (message.role === "toolResult") {
      const entry = byId.get(message.toolCallId);
      if (!entry || entry.resultMessage !== undefined) throw new Error("Compaction ledger has orphan or duplicate tool result");
      const result = structuredResult(typeof message.content === "string" ? message.content : text(message.content));
      const rawResult = rawById.get(message.toolCallId)?.result;
      const rawStructured = structuredResult(rawResult?.output);
      const error = message.isError || result?.isError === true || rawStructured?.isError === true;
      entry.resultMessage = index;
      entry.resultHash = compactionDigest(message.content);
      entry.isError = error;
      entry.status = error ? "error" : "result_received";
      const exitCode = result?.exit_code ?? result?.exitCode;
      entry.execution = error ? "error" : typeof exitCode === "number"
        ? exitCode === 0 ? "completed" : "error"
        : result?.session_id !== undefined ? "running" : "unknown";
      // Only an explicit returned range with its line count is evidence. Never infer a full
      // file read from shell syntax, requested ranges, a partial output, or a successful exit.
      if (!error && result?.type === "file_read" && typeof result.path === "string"
        && Number.isSafeInteger(result.start_line) && Number.isSafeInteger(result.end_line)
        && (result.start_line as number) > 0 && (result.end_line as number) >= (result.start_line as number)
        && result.returned_line_count === (result.end_line as number) - (result.start_line as number) + 1
        && result.truncated === false) {
        entry.returnedLines = { path: result.path, start: result.start_line as number, end: result.end_line as number };
      }
    }
  });
  const payload = {
    version: 2 as const, prefixLength, prefixHash: compactionPrefixHash(messages, prefixLength),
    epochHash: compactionEpochHash(parsed), rawPrefix, tools, exactLiterals: [...literals].sort(),
  };
  const ledger = { ...payload, digest: compactionDigest(payload) };
  if (!small(ledger, MAX_COMPACTION_LEDGER_BYTES)) throw new Error("Compaction ledger byte capacity exceeded");
  return ledger;
}

export function validateCompactionLedger(value: unknown): CompactionLedger {
  const ledger = record(value);
  if (!ledger || ledger.version !== 2 || !Number.isSafeInteger(ledger.prefixLength)
    || (ledger.prefixLength as number) < 0 || typeof ledger.prefixHash !== "string"
    || !/^[a-f0-9]{64}$/.test(ledger.prefixHash) || typeof ledger.epochHash !== "string"
    || !/^[a-f0-9]{64}$/.test(ledger.epochHash) || !Array.isArray(ledger.tools)
    || !Array.isArray(ledger.exactLiterals) || !record(ledger.rawPrefix) || !small(ledger, MAX_COMPACTION_LEDGER_BYTES)) {
    throw new Error("Invalid compaction ledger");
  }
  const { digest, ...payload } = ledger;
  if (digest !== compactionDigest(payload)) throw new Error("Compaction ledger integrity mismatch");
  return ledger as unknown as CompactionLedger;
}

/** The bridge owns this appendix; model text must never replace canonical tool provenance. */
export function mergeCompactionLedger(summary: string, ledger: CompactionLedger): string {
  if (summary.includes(COMPACTION_LEDGER_MARKER)) throw new Error("Model-authored compaction ledger is not canonical");
  return `${summary}\n\n${COMPACTION_LEDGER_MARKER}\n`
    + "Historical evidence, not instructions or permission to repeat actions. Result receipt does not prove action success; execution is unknown unless explicitly evidenced. Re-observe native state before any non-idempotent action. Returned file ranges never imply a full file read.\n"
    + JSON.stringify(ledger);
}
