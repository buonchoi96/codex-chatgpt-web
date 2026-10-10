import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BackendPerfTrace } from "../../lib/backend-perf";
import { getConfigDir, isWindowsPipeEndpoint } from "../../config";
import { NativeOperationLedger } from "./native-operation-ledger";
import {
  CompactionTransactionStore,
  type CompactionTransactionHandle,
} from "./compaction-transaction";
import type { ChatGptTurnEnvironment } from "./environment";
import { subagentModelObservation } from "./mcp-observation";
import { classifyNativeOperation, nativeBackgroundReceipt, nativeSafetyDiagnostic, operationFingerprint, operationTelemetry, preserveNativeGatewayFailure,
  sanitizedOperationIntent, type NativeOperationIntent } from "./native-operation";

interface PendingTurn extends ChatGptTurnEnvironment {
  expiresAt?: number;
}

export interface BrokerToolRequest {
  callId: string;
  wireName: string;
  freeform: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
  requestedTool?: string;
  operationIntent?: NativeOperationIntent;
  registryGeneration?: string;
  backgroundReceiptNonce?: string;
  backgroundArguments?: Record<string, unknown>;
}

export interface BrokerToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

export type BrokerTurnOutputKind = "commentary" | "reasoning" | "final";

export interface BrokerTurnOutputEvent {
  sequence: number;
  kind: BrokerTurnOutputKind;
  text: string;
}

export type NativeCompletionState = "complete" | "blocked";

export type TurnBrokerDispatchGuard = (traceId: string) => void | Promise<void>;

export interface TurnBrokerDiagnosticIdentity {
  lane: string;
  connector: string;
  tunnelAlias: string | null;
  tunnelIdHash: string | null;
  brokerHash: string;
  responsesPort: number;
}

export interface NativeCompletionReceipt {
  state: NativeCompletionState;
  summary: string;
  completedRequirements: string[];
  blockedRequirements: string[];
  remainingActionableRequirements: string[];
  blocker?: string;
}

interface PendingInvocation {
  request: BrokerToolRequest;
  resolve: (result: BrokerToolResult) => void;
  reject: (error: Error) => void;
  /** The MCP response deadline elapsed after Codex had already received this call. */
  detached?: boolean;
  finishQueue?: () => void;
  finishNative?: () => void;
  perf?: BackendPerfTrace;
  startedAt: number;
  fingerprint: string;
  failureMarker?: string;
}

interface ToolWaiter {
  resolve: (requests: BrokerToolRequest[]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface OutputWaiter {
  afterSequence: number;
  resolve: (event: BrokerTurnOutputEvent) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export type SafeTurnState = "awaiting_start" | "running" | "completed" | "revoked";

interface SafeWaiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface SafeTurnControl {
  state: SafeTurnState;
  surfaceNonce: string;
  launcherSent: boolean;
  connectorStarted: boolean;
  finalAnswer?: string;
  sentWaiters: Set<SafeWaiter<void>>;
  startWaiters: Set<SafeWaiter<void>>;
  completionWaiters: Set<SafeWaiter<string>>;
}

interface TurnChannel {
  traceId: string;
  externalOwner: boolean;
  environment: PendingTurn;
  bindingId?: string;
  queuedCallIds: string[];
  deliveredCallIds: Set<string>;
  invocations: Map<string, PendingInvocation>;
  /** Completed results whose original MCP response timed out after delivery; must be explicitly consumed. */
  detachedResults: Map<string, BrokerToolResult>;
  /** Small replay window closes the race where completion lands exactly as the transport deadline fires. */
  recentToolResults: Map<string, BrokerToolResult>;
  rejectedOperations: Map<string, BrokerToolResult>;
  operationResults: Map<string, { callId: string; result: BrokerToolResult }>;
  operationResultsOverflow: boolean;
  recovering: boolean;
  recoveryDispatchPaused: boolean;
  waiters: Set<ToolWaiter>;
  toolCallsQueued: number;
  toolCallsCompleted: number;
  lastComputerUseCompletedAt?: number;
  lastComputerUseCompletedTool?: string;
  finishDecision?: () => void;
  requireNativeCompletionReceipt: boolean;
  pendingNativeCompletionReceipt?: { activityId: string; receipt: NativeCompletionReceipt };
  nativeCompletionReceipt?: { receipt: NativeCompletionReceipt; revision: number };
  compactionRequested: boolean;
  compactionResult?: BrokerToolResult;
  compactionDeliveryCount: number;
  safe?: SafeTurnControl;
  /** Every MCP request owns a lease from token claim until its handler has settled. */
  activities: Set<string>;
  /** Prevents a lost/retried or delayed claim from resurrecting activity after cleanup. */
  completedActivities: Set<string>;
  /** Monotonic across activity start/end so a completed request cannot disappear across a fence. */
  activityRevision: number;
  completionCommitted: boolean;
  completionRevision?: number;
  outputEvents: BrokerTurnOutputEvent[];
  outputChars: number;
  outputFinalSequence?: number;
  outputSealed: boolean;
  outputResumeAfter: number;
  outputWaiters: Set<OutputWaiter>;
  retirementWaiters: Set<SafeWaiter<void>>;
  batchTimer?: ReturnType<typeof setTimeout>;
}

interface BrokerRequest {
  id: string;
  method:
    | "claim"
    | "cancel_trace"
    | "resolve"
    | "release"
    | "invoke"
    | "cancel_invoke"
    | "invoke_status"
    | "owner_status"
    | "owner_register"
    | "owner_register_safe"
    | "owner_update"
    | "owner_safe_sent"
    | "owner_next"
    | "owner_complete"
    | "owner_completion_fence_begin"
    | "owner_prepare_recovery"
    | "owner_completion_fence_commit"
    | "owner_completion_receipt_status"
    | "owner_require_completion_receipt"
    | "owner_wait_retirement"
    | "owner_revoke"
    | "owner_safe_wait_start"
    | "owner_safe_wait_completion"
    | "owner_request_compaction"
    | "owner_compaction_delivery_count"
    | "safe_start"
    | "safe_complete"
    | "native_complete"
    | "activity_complete"
    | "submit_compaction_handoff"
    | "submit_recovery_checkpoint"
    | "submit_output"
    | "owner_next_output"
    | "owner_reset_output"
    | "owner_seal_output";
  token?: string;
  recoveryPhase?: "stop" | "submitted";
  bindingId?: string;
  wireName?: string;
  freeform?: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
  environment?: ChatGptTurnEnvironment;
  ttlMs?: number;
  traceId?: string;
  callId?: string;
  activityId?: string;
  revision?: number;
  toolResult?: BrokerToolResult;
  handoffId?: string;
  summary?: string;
  surfaceNonce?: string;
  finalAnswer?: string;
  completionState?: NativeCompletionState;
  reason?: string;
  completionSummary?: string;
  completedRequirements?: string[];
  blockedRequirements?: string[];
  remainingActionableRequirements?: string[];
  blocker?: string;
  outputKind?: BrokerTurnOutputKind;
  outputText?: string;
  afterSequence?: number;
  outputSequence?: number;
  expectedRevision?: number;
  contract?: "native" | "safe";
  requestedTool?: string;
  operationIntent?: NativeOperationIntent;
  operationFingerprint?: string;
  backgroundReceiptNonce?: string;
  backgroundArguments?: Record<string, unknown>;
  registryGeneration?: string;
  failureMarker?: string;
}

interface BrokerResponse {
  id: string;
  result?: unknown;
  error?: string;
}

const brokers = new Map<string, TurnBroker>();
const MAX_BROKER_LINE_CHARS = 67_108_864;
const MAX_RETIRED_TURN_HANDLES = 64;
const MAX_RETAINED_TOOL_RESULTS = 64;

export async function closeTurnBrokers(): Promise<void> {
  const active = [...brokers.values()];
  const results = await Promise.allSettled(active.map(broker => broker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT turn broker(s) failed to close`);
  }
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function handleFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function retiredTurnLabel(traceId: string): string {
  return traceId && traceId !== "unknown" ? `Codex turn ${traceId}` : "a Codex turn";
}

function textToolResult(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/**
 * A completed delivered call can outlive the MCP response that originally requested it. If
 * ChatGPT asks for another work tool before polling codex_tool_wait, surface the oldest retained
 * result at that new boundary instead of allowing detached results to accumulate indefinitely.
 *
 * The newly requested operation is deliberately NOT executed. The textual envelope binds the
 * canonical payload to its original call id so the model can consume it and then request the new
 * operation again only if it is still needed.
 */
function detachedToolReplayResult(
  originalCallId: string,
  requestedWireName: string,
  result: BrokerToolResult,
): BrokerToolResult {
  return {
    content: [
      textToolResult(
        `<codex_detached_tool_result call_id="${originalCallId}">\n`
        + `A previously delivered Codex Native operation completed after its MCP response deadline. `
        + `The newly requested tool "${requestedWireName}" was NOT executed. Consume the authoritative `
        + `result below for original call_id=${originalCallId}. Do not repeat that original operation. `
        + "After consuming it, request the new tool again only if it is still needed.",
      ),
      ...structuredClone(result.content),
      textToolResult("</codex_detached_tool_result>"),
    ],
    structuredContent: {
      code: "codex_detached_tool_result_replayed",
      original_call_id: originalCallId,
      requested_tool: requestedWireName,
      requested_tool_executed: false,
      original_is_error: result.isError === true,
      original_structured_content: result.structuredContent === undefined
        ? null
        : structuredClone(result.structuredContent),
    },
    // This envelope is control flow, not a failure of the newly requested operation: that operation
    // did not run. The original result's own error bit remains explicit in structured metadata.
    isError: false,
  };
}

/**
 * Automatic context compaction must never fail merely because completed detached results have not
 * yet been polled. Carry those canonical results through the compaction control boundary, then
 * clear the detached-result fence so the retained source can settle and produce its checkpoint.
 */
function compactionResultWithDetachedResults(
  base: BrokerToolResult,
  detached: Array<[string, BrokerToolResult]>,
): BrokerToolResult {
  if (detached.length === 0) return structuredClone(base);
  const content = structuredClone(base.content);
  content.push(textToolResult(
    `<codex_detached_results_before_compaction count="${detached.length}">\n`
    + "The following Codex Native operations already executed and completed after their original "
    + "MCP response deadlines. Consume these authoritative results while preparing the compaction "
    + "checkpoint. Do not retry the original operations.",
  ));
  for (const [callId, result] of detached) {
    content.push(textToolResult(`<codex_detached_result call_id="${callId}">`));
    content.push(...structuredClone(result.content));
    content.push(textToolResult(`</codex_detached_result>`));
  }
  content.push(textToolResult("</codex_detached_results_before_compaction>"));
  return {
    ...structuredClone(base),
    content,
    structuredContent: {
      code: "codex_compaction_carries_detached_results",
      base_structured_content: base.structuredContent === undefined
        ? null
        : structuredClone(base.structuredContent),
      detached_results: detached.map(([callId, result]) => ({
        call_id: callId,
        is_error: result.isError === true,
        structured_content: result.structuredContent === undefined
          ? null
          : structuredClone(result.structuredContent),
      })),
    },
  };
}


export interface BrokerToolResultDiagnostic {
  wireName: string;
  contentItems: number;
  textChars: number;
  structured: boolean;
  isError: boolean;
  waitPayloadParsed: boolean;
  timedOut?: boolean;
  statusEntries?: number;
  completedEntries?: number;
  completedWithMessage?: number;
  completedMessageChars?: number;
  erroredEntries?: number;
  notFoundEntries?: number;
  otherTerminalEntries?: number;
}

/**
 * Produce content-free telemetry for terminal multi-agent results.
 *
 * The exact child answer is deliberately never logged. Character/count metadata is enough to prove
 * whether Codex returned completed child payloads to the bridge while keeping subagent findings out
 * of launcher diagnostics.
 */
export function isComputerUseTelemetryTool(wireName: string): boolean {
  return wireName === "mcp__node_repl__js"
    || wireName === "node_repl__js"
    || wireName.startsWith("mcp__windows_computer_use__windows_computer_use_");
}

export function brokerToolResultDiagnostic(
  request: BrokerToolRequest,
  result: BrokerToolResult,
): BrokerToolResultDiagnostic | undefined {
  if (!/(?:^|__)wait_agent$/.test(request.wireName)) return undefined;
  const textBlocks = result.content
    .map(item => item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined)
    .filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text as string);
  const base: BrokerToolResultDiagnostic = {
    wireName: request.wireName,
    contentItems: result.content.length,
    textChars: textBlocks.reduce((sum, text) => sum + text.length, 0),
    structured: result.structuredContent !== undefined,
    isError: result.isError === true,
    waitPayloadParsed: false,
  };

  let payload: unknown = result.structuredContent;
  if ((!payload || typeof payload !== "object" || Array.isArray(payload)) && textBlocks.length === 1) {
    try { payload = JSON.parse(textBlocks[0]!); } catch { /* metadata-only diagnostics */ }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return base;
  const record = payload as Record<string, unknown>;
  const status = record.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return base;

  let completedEntries = 0;
  let completedWithMessage = 0;
  let completedMessageChars = 0;
  let erroredEntries = 0;
  let notFoundEntries = 0;
  let otherTerminalEntries = 0;
  for (const value of Object.values(status as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (value === "not_found") notFoundEntries += 1;
      else if (value === "shutdown" || value === "interrupted") otherTerminalEntries += 1;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const state = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(state, "completed")) {
      completedEntries += 1;
      if (typeof state.completed === "string") {
        completedWithMessage += 1;
        completedMessageChars += state.completed.length;
      }
    } else if (Object.prototype.hasOwnProperty.call(state, "errored")) {
      erroredEntries += 1;
    }
  }
  return {
    ...base,
    waitPayloadParsed: true,
    ...(typeof record.timed_out === "boolean" ? { timedOut: record.timed_out } : {}),
    statusEntries: Object.keys(status as Record<string, unknown>).length,
    completedEntries,
    completedWithMessage,
    completedMessageChars,
    erroredEntries,
    notFoundEntries,
    otherTerminalEntries,
  };
}

function environmentIdentity(environment: ChatGptTurnEnvironment): string {
  return JSON.stringify({
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    recoveryScope: environment.recoveryScope,
  });
}

function ownerEnvironment(value: unknown): ChatGptTurnEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("turn owner environment is invalid");
  const environment = value as Partial<ChatGptTurnEnvironment>;
  const paths = (candidate: unknown): candidate is string[] => Array.isArray(candidate)
    && candidate.length > 0
    && candidate.every(path => typeof path === "string" && isAbsolute(path));
  if (typeof environment.cwd !== "string" || !isAbsolute(environment.cwd)
    || (environment.recoveryScope !== undefined && !/^[a-f0-9]{64}$/.test(environment.recoveryScope))
    || !paths(environment.roots) || !Array.isArray(environment.writableRoots)
    || environment.writableRoots.some(path => typeof path !== "string" || !isAbsolute(path))
    || !environment.roots.some(root => {
      const nested = relative(resolve(root), resolve(environment.cwd!));
      return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
    })
    || !environment.sandboxPolicy || !["dangerFullAccess", "workspaceWrite", "readOnly"].includes(environment.sandboxPolicy.type)
    || !Array.isArray(environment.tools)
    || environment.tools.some(tool => !tool || typeof tool.name !== "string" || typeof tool.description !== "string"
      || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))) {
    throw new Error("turn owner environment is invalid");
  }
  return structuredClone(environment as ChatGptTurnEnvironment);
}

function assertSurfaceNonce(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,256}$/.test(value)) {
    throw new Error("Zero Risk local browser binding is invalid");
  }
}

export interface TurnBrokerOwner {
  register(environment: ChatGptTurnEnvironment, ttlMs?: number, traceId?: string): Promise<string>;
  registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId?: string,
  ): Promise<string>;
  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void | Promise<void>;
  confirmSafeTurnSent(
    token: string,
    surfaceNonce: string,
  ): { confirmed: true; duplicate: boolean } | Promise<{ confirmed: true; duplicate: boolean }>;
  nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]>;
  completeTool(token: string, callId: string, result: BrokerToolResult): void | Promise<void>;
  waitForSafeStart(token: string, signal?: AbortSignal): Promise<void>;
  waitForSafeCompletion(token: string, signal?: AbortSignal): Promise<string>;
  requestCompaction(token: string, queuedResult: BrokerToolResult): number | Promise<number>;
  compactionDeliveryCount(token: string): number | Promise<number>;
  beginCompletionFence(token: string): number | undefined | Promise<number | undefined>;
  prepareRecovery(token: string, phase?: "stop" | "submitted"): boolean | Promise<boolean>;
  commitCompletionFence(token: string, revision: number): boolean | Promise<boolean>;
  requireNativeCompletionReceipt(token: string): void | Promise<void>;
  nativeCompletionReceiptAccepted(token: string): boolean | Promise<boolean>;
  nextOutput(token: string, afterSequence: number, signal?: AbortSignal): Promise<BrokerTurnOutputEvent>;
  resetOutput(token: string, finalSequence: number): void | Promise<void>;
  sealOutput(token: string, afterSequence: number, expectedRevision: number): boolean | Promise<boolean>;
  waitForRetirement(token: string, signal?: AbortSignal): Promise<void>;
  revoke(token: string, reason?: Error): void | Promise<void>;
}

/**
 * Bytes available for a Unix socket path. Linux allows 108, macOS and the BSDs expose a 104-byte
 * sun_path including its terminating NUL; the smaller usable bound is used everywhere so a path
 * that works on one developer's machine is not silently unbindable on another's.
 */
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export class TurnBroker implements TurnBrokerOwner {
  static forSocket(path: string): TurnBroker {
    let broker = brokers.get(path);
    if (!broker) {
      broker = new TurnBroker(path);
      brokers.set(path, broker);
    }
    return broker;
  }

  private readonly channels = new Map<string, TurnChannel>();
  private readonly operationLedger = new NativeOperationLedger(() => join(getConfigDir(), "runtime", "native-operation-receipts.json"));
  private readonly pending = new Map<string, TurnChannel>();
  private readonly compactionTransactions = new CompactionTransactionStore();
  private readonly bindings = new Map<string, { token: string; channel: TurnChannel }>();
  // The Codex context replayed into ChatGPT still carries the handles of finished turns, so a model
  // can present one. Remembering which turn retired a handle is what separates "you are holding a
  // previous turn's handle" from "this handle never existed".
  private readonly retiredBindings = new Map<string, string>();
  private readonly retiredTokens = new Map<string, string>();
  private readonly traceAbortControllers = new Map<string, Set<AbortController>>();
  private acceptingExternalOwners = true;
  private dispatchGuard?: TurnBrokerDispatchGuard;
  private diagnosticIdentity?: TurnBrokerDiagnosticIdentity;
  private server?: Server;
  private startPromise?: Promise<void>;
  private socketIdentity?: { dev: number; ino: number };

  private constructor(readonly socketPath: string) {}

  configureDiagnosticIdentity(identity: TurnBrokerDiagnosticIdentity | undefined): void {
    this.diagnosticIdentity = identity ? { ...identity } : undefined;
  }

  private diagnosticSuffix(): string {
    return this.diagnosticIdentity
      ? ` identity=${JSON.stringify(this.diagnosticIdentity)}`
      : "";
  }

  setDispatchGuard(guard: TurnBrokerDispatchGuard | undefined): void {
    this.dispatchGuard = guard;
  }

  /**
   * A ChatGPT turn outlives the request that started it, and its Codex Native calls arrive from a
   * separate MCP process. Creating the socket only once a turn registers leaves that process
   * connecting to a path that does not exist yet, so an in-flight turn reports a filesystem error
   * instead of the broker's own answer. The endpoint belongs to the runtime's lifetime.
   */
  async listen(): Promise<void> {
    await this.start();
  }

  async register(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId = "unknown",
    externalOwner = false,
    handlePrefix = "turn",
  ): Promise<string> {
    await this.start();
    this.prune();
    if (externalOwner && !this.acceptingExternalOwners) {
      throw new Error("turn broker is draining and does not accept new external owners");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error("ChatGPT web turn broker TTL must be a positive finite number");
    }
    const token = opaqueId(handlePrefix);
    const channel: TurnChannel = {
      traceId,
      externalOwner,
      environment: {
        ...environment,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      },
      queuedCallIds: [],
      deliveredCallIds: new Set(),
      invocations: new Map(),
      detachedResults: new Map(),
      recentToolResults: new Map(),
      rejectedOperations: new Map(),
      operationResults: new Map(),
      operationResultsOverflow: false,
      recovering: false,
      recoveryDispatchPaused: false,
      waiters: new Set(),
      toolCallsQueued: 0,
      toolCallsCompleted: 0,
      requireNativeCompletionReceipt: false,
      compactionRequested: false,
      compactionDeliveryCount: 0,
      activities: new Set(),
      completedActivities: new Set(),
      activityRevision: 0,
      completionCommitted: false,
      outputEvents: [],
      outputChars: 0,
      outputSealed: false,
      outputResumeAfter: 0,
      outputWaiters: new Set(),
      retirementWaiters: new Set(),
    };
    this.channels.set(token, channel);
    this.pending.set(token, channel);
    console.info(`[chatgpt-web] broker trace=${traceId} registered tokenHash=${handleFingerprint(token)}${this.diagnosticSuffix()}`);
    return token;
  }

  async registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId = "unknown",
    externalOwner = false,
  ): Promise<string> {
    assertSurfaceNonce(surfaceNonce);
    const token = await this.register(environment, ttlMs, traceId, externalOwner, "request");
    const channel = this.channels.get(token);
    if (!channel) throw new Error("Zero Risk turn registration was revoked before initialization");
    channel.safe = {
      state: "awaiting_start",
      surfaceNonce,
      launcherSent: false,
      connectorStarted: false,
      sentWaiters: new Set(),
      startWaiters: new Set(),
      completionWaiters: new Set(),
    };
    return token;
  }

  async beginCompactionTransaction(
    traceId: string,
    ttlMs = 120_000,
  ): Promise<CompactionTransactionHandle> {
    await this.start();
    return this.compactionTransactions.begin(traceId, ttlMs);
  }

  async beginRecoveryCheckpoint(
    traceId: string,
    ttlMs: number,
    beforeAccept: (summary: string) => void,
  ): Promise<CompactionTransactionHandle> {
    await this.start();
    return this.compactionTransactions.begin(traceId, ttlMs, beforeAccept);
  }

  waitForCompactionHandoff(token: string, signal?: AbortSignal): Promise<string> {
    return this.compactionTransactions.wait(token, signal);
  }

  abortCompactionTransaction(token: string): void {
    this.compactionTransactions.abort(token);
  }

  revokeCompactionTransactions(traceId: string): void {
    this.compactionTransactions.abortTrace(traceId);
  }

  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    environment = { ...environment, ...(channel.environment.recoveryScope && environment.recoveryScope === undefined
      ? { recoveryScope: channel.environment.recoveryScope } : {}) };
    if (environmentIdentity(channel.environment) !== environmentIdentity(environment)) {
      throw new Error("Codex turn environment changed during an active ChatGPT tool loop");
    }
    if (channel.safe?.state === "revoked") throw new Error("Zero Risk turn is already terminal");
    // A no-tool Zero Risk answer can complete before its outer Responses observer reaches this owner
    // readback. The environment is already proven identical, so completion makes this a no-op.
    if (channel.safe?.state === "completed") return;
    channel.environment = {
      ...environment,
      ...(channel.environment.expiresAt !== undefined
        ? { expiresAt: channel.environment.expiresAt }
        : {}),
    };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    this.prune();
    let channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.safe?.state === "awaiting_start") {
      // The outer Codex adapter owns this wait. It crosses the start boundary only after the user
      // confirms in the Launcher that the copied prompt was sent in the visible ChatGPT tab.
      await this.waitForSafeStart(token, signal);
      this.prune();
      channel = this.channels.get(token);
      if (!channel) throw new Error("turn token is invalid or expired");
    }
    // This owner-only empty batch tells the adapter to consume the already accepted completion.
    // Public Zero Risk MCP calls remain fail-closed after the turn reaches its terminal state.
    if (channel.safe?.state === "completed") return [];
    this.assertSafeHarnessRunning(channel);
    if (channel.compactionRequested) {
      throw new Error("Codex context compaction superseded ordinary MCP tool delivery");
    }
    // Delivery is at-least-once until Codex returns the corresponding tool result. If the HTTP
    // observer disconnects after the broker handed off a batch but before the adapter journaled
    // it, the exact reconnect receives the same call ids instead of losing the model's invocation.
    const delivered = [...channel.deliveredCallIds]
      .map(id => channel.invocations.get(id)?.request)
      .filter((request): request is BrokerToolRequest => Boolean(request));
    if (delivered.length > 0) {
      this.logToolDelivery(channel, delivered, "replay");
      return delivered;
    }
    const ready = this.takeQueued(channel);
    if (ready.length > 0) {
      this.logToolDelivery(channel, ready, "immediate");
      return ready;
    }
    if (signal?.aborted) throw new DOMException("tool wait aborted", "AbortError");
    return new Promise<BrokerToolRequest[]>((resolveWait, rejectWait) => {
      const waiter: ToolWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          channel.waiters.delete(waiter);
          rejectWait(new DOMException("tool wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      channel.waiters.add(waiter);
    });
  }

  completeTool(token: string, callId: string, result: BrokerToolResult): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    this.assertSafeHarnessRunning(channel, true);
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new Error(`tool call is not pending: ${callId}`);
    if (!channel.deliveredCallIds.delete(callId)) {
      throw new Error(`tool call was completed before it was delivered: ${callId}`);
    }
    channel.invocations.delete(callId);
    invocation.finishNative?.();
    const surface = invocation.request.wireName.includes("windows_computer_use") ? "computer_use_cycle"
      : invocation.request.wireName.includes("cua_repl") ? "browser_use_cycle" : "tool_cycle";
    // One channel transition starts when the first result becomes available. Later
    // parallel completions must not discard that timer or shorten the reported interval.
    channel.finishDecision ??= invocation.perf?.start(surface);
    channel.toolCallsCompleted += 1;
    result = preserveNativeGatewayFailure(result, invocation.failureMarker);
    const backgroundReceipt = nativeBackgroundReceipt(result.content, invocation.request.backgroundReceiptNonce);
    if (backgroundReceipt) {
      const prefix = `codex-native-receipt:${invocation.request.backgroundReceiptNonce}:`;
      result = { ...result, content: result.content.flatMap(value => {
        const item = value as { type?: unknown; text?: unknown } | null;
        if (item?.type !== "text" || typeof item.text !== "string") return [value];
        const offset = item.text.indexOf(prefix);
        if (offset < 0) return [value];
        const end = item.text.indexOf("\n", offset);
        const text = item.text.slice(0, offset > 0 && item.text[offset - 1] === "\n" ? offset - 1 : offset)
          + (end < 0 ? "" : item.text.slice(end));
        return text ? [{ ...item, text }] : [];
      }) };
    }
    const safety = nativeSafetyDiagnostic(result);
    if (safety.result !== "not_reported") {
      result = { ...result, _meta: { ...(result._meta && typeof result._meta === "object" ? result._meta : {}), codexNativeSafety: safety } };
      channel.rejectedOperations.set(invocation.fingerprint, structuredClone(result));
    }
    console.info(`[native-operation] trace=${channel.traceId} ${operationTelemetry("completed", invocation.request, {
      safety, brokerDelivered: true, operationAlreadyDispatched: true, elapsedMs: Date.now() - invocation.startedAt,
    })}`);
    const retainedResult = structuredClone(result);
    if (!classifyNativeOperation(invocation.request.requestedTool ?? invocation.request.wireName, invocation.request.arguments).readOnly) {
      if (channel.environment.recoveryScope) {
        try { this.operationLedger.complete(channel.environment.recoveryScope, invocation.fingerprint, retainedResult); }
        catch { channel.operationResultsOverflow = true; }
      }
      if (channel.operationResults.size < MAX_RETAINED_TOOL_RESULTS || channel.operationResults.has(invocation.fingerprint)) {
        channel.operationResults.set(invocation.fingerprint, { callId, result: retainedResult });
      } else channel.operationResultsOverflow = true;
    }
    channel.recentToolResults.delete(callId);
    channel.recentToolResults.set(callId, retainedResult);
    while (channel.recentToolResults.size > MAX_RETAINED_TOOL_RESULTS) {
      const oldest = channel.recentToolResults.keys().next();
      if (oldest.done) break;
      channel.recentToolResults.delete(oldest.value);
    }
    if (invocation.detached) {
      channel.detachedResults.delete(callId);
      channel.detachedResults.set(callId, structuredClone(retainedResult));
      channel.activityRevision += 1;
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} retained detached tool result call=${callId.slice(0, 17)} pendingResults=${channel.detachedResults.size}`,
      );
    }
    console.info(
      `[chatgpt-web] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} pending=${channel.invocations.size} isError=${result.isError === true}${this.diagnosticSuffix()}`,
    );
    if (isComputerUseTelemetryTool(invocation.request.wireName)) {
      channel.lastComputerUseCompletedAt = Date.now();
      channel.lastComputerUseCompletedTool = invocation.request.wireName;
      console.info(
        `[computer-use] trace=${channel.traceId} toolComplete tool=${invocation.request.wireName}`,
      );
    }
    const diagnostic = brokerToolResultDiagnostic(invocation.request, result);
    if (diagnostic) {
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} wait_agent_result call=${callId.slice(0, 17)} metadata=${JSON.stringify(diagnostic)}`,
      );
    }
    invocation.resolve(result);
  }

  submitOutput(
    token: string,
    kind: BrokerTurnOutputKind,
    text: string,
  ): { accepted: true; sequence: number; duplicate: boolean } {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.safe) throw new Error("Zero Risk requests use the safe completion contract");
    if (kind !== "commentary" && kind !== "reasoning" && kind !== "final") {
      throw new Error("Codex Native output kind is invalid");
    }
    if (!text || (kind === "final" && !text.trim()) || text.length > 1_000_000) {
      throw new Error("Codex Native output text is invalid");
    }
    if (channel.outputSealed) throw new Error("Codex Native output arrived after DOM fallback was sealed");
    if (channel.outputFinalSequence !== undefined) {
      const previous = channel.outputEvents[channel.outputFinalSequence - 1];
      if (kind === "final" && previous?.text === text) {
        return { accepted: true, sequence: previous.sequence, duplicate: true };
      }
      throw new Error(kind === "final"
        ? "Codex Native output submitted conflicting final answers"
        : "Codex Native output arrived after the final answer");
    }
    if (channel.completionCommitted) throw new Error("Codex Native output arrived after turn completion");
    if (kind === "final" && (
      channel.activities.size > 0
      || channel.invocations.size > 0
      || channel.detachedResults.size > 0
    )) {
      throw new Error("Codex Native final output cannot be accepted while work tools or detached results are still active");
    }
    if (channel.outputEvents.length >= 10_000 || channel.outputChars + text.length > 5_000_000) {
      throw new Error("Codex Native output exceeds the per-turn limit");
    }
    const event: BrokerTurnOutputEvent = {
      sequence: channel.outputEvents.length + 1,
      kind,
      text,
    };
    channel.outputEvents.push(event);
    channel.outputChars += text.length;
    if (kind === "final") channel.outputFinalSequence = event.sequence;
    channel.activityRevision += 1;
    for (const waiter of [...channel.outputWaiters]) {
      if (event.sequence <= waiter.afterSequence) continue;
      channel.outputWaiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(event);
    }
    return { accepted: true, sequence: event.sequence, duplicate: false };
  }

  nextOutput(token: string, afterSequence: number, signal?: AbortSignal): Promise<BrokerTurnOutputEvent> {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) return Promise.reject(new Error("turn token is invalid or expired"));
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return Promise.reject(new Error("Codex Native output sequence is invalid"));
    }
    const effectiveAfter = Math.max(afterSequence, channel.outputResumeAfter);
    const ready = channel.outputEvents.find(event => event.sequence > effectiveAfter);
    if (ready) return Promise.resolve(ready);
    if (signal?.aborted) return Promise.reject(new DOMException("turn output wait aborted", "AbortError"));
    return new Promise((resolveOutput, rejectOutput) => {
      const waiter: OutputWaiter = {
        afterSequence: effectiveAfter,
        resolve: resolveOutput,
        reject: rejectOutput,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.onAbort = () => {
          channel.outputWaiters.delete(waiter);
          rejectOutput(new DOMException("turn output wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      channel.outputWaiters.add(waiter);
    });
  }

  resetOutput(token: string, finalSequence: number): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (!Number.isSafeInteger(finalSequence) || finalSequence < 1
      || channel.outputFinalSequence !== finalSequence) {
      throw new Error("Codex Native output reset does not match the pending final answer");
    }
    channel.outputFinalSequence = undefined;
    channel.outputResumeAfter = finalSequence;
    channel.activityRevision += 1;
  }

  sealOutput(token: string, afterSequence: number, expectedRevision: number): boolean {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Codex Native output seal arguments are invalid");
    }
    const latest = channel.outputEvents.at(-1)?.sequence ?? 0;
    if (latest !== afterSequence) return false;
    if (channel.activityRevision !== expectedRevision
      || channel.activities.size > 0
      || channel.invocations.size > 0
      || channel.detachedResults.size > 0) return false;
    channel.outputSealed = true;
    channel.activityRevision += 1;
    return true;
  }

  requireNativeCompletionReceipt(token: string): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.safe) throw new Error("Zero Risk uses its explicit completion contract");
    channel.requireNativeCompletionReceipt = true;
  }

  nativeCompletionReceiptAccepted(token: string): boolean {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    return !channel.requireNativeCompletionReceipt || channel.nativeCompletionReceipt !== undefined;
  }

  submitNativeCompletion(
    token: string,
    activityId: string,
    receipt: NativeCompletionReceipt,
  ): { accepted: true } {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.safe) throw new Error("Zero Risk completion must use its request_id contract");
    if (!channel.activities.has(activityId)) {
      throw new Error("Native completion receipt must be submitted from the active MCP completion call");
    }
    if (channel.invocations.size > 0 || channel.deliveredCallIds.size > 0 || channel.detachedResults.size > 0) {
      throw new Error("Completion rejected: Codex tool invocations or detached results are still pending");
    }
    if (receipt.remainingActionableRequirements.length > 0) {
      throw new Error(
        "Completion rejected: actionable requirements remain: "
        + receipt.remainingActionableRequirements.join("; "),
      );
    }
    if (receipt.state === "blocked") {
      if (!receipt.blocker?.trim()) {
        throw new Error("Completion rejected: blocked completion requires a concrete blocker");
      }
      if (receipt.blockedRequirements.length === 0) {
        throw new Error("Completion rejected: blocked completion must identify blocked requirements");
      }
    } else if (receipt.blocker !== undefined || receipt.blockedRequirements.length > 0) {
      throw new Error("Completion rejected: complete status cannot include blocked requirements");
    }
    if (!receipt.summary.trim()) throw new Error("Completion rejected: completion summary must not be empty");
    channel.pendingNativeCompletionReceipt = {
      activityId,
      receipt: structuredClone(receipt),
    };
    return { accepted: true };
  }

  prepareRecovery(token: string, phase?: "stop" | "submitted"): boolean {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    this.assertSafeHarnessRunning(channel, true);
    if (phase === "submitted") {
      if (!channel.recovering) return false;
      channel.recoveryDispatchPaused = false;
      return true;
    }
    if (channel.safe || channel.completionCommitted || channel.operationResultsOverflow
      || channel.activities.size > 0 || channel.invocations.size > 0 || channel.detachedResults.size > 0) return false;
    if (channel.environment.recoveryScope) {
      try { this.operationLedger.beginRecovery(channel.environment.recoveryScope); }
      catch { return false; }
    }
    channel.recovering = true;
    channel.recoveryDispatchPaused = phase === "stop";
    return true;
  }

  beginCompletionFence(token: string): number | undefined {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.completionCommitted) return channel.completionRevision;
    if (channel.activities.size > 0 || channel.invocations.size > 0 || channel.detachedResults.size > 0) return undefined;
    if (channel.requireNativeCompletionReceipt && !channel.nativeCompletionReceipt) return undefined;
    return channel.activityRevision;
  }

  commitCompletionFence(token: string, revision: number): boolean {
    this.prune();
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("turn completion fence revision is invalid");
    }
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.completionCommitted) return channel.completionRevision === revision;
    if (channel.requireNativeCompletionReceipt && !channel.nativeCompletionReceipt) return false;
    if (channel.activityRevision !== revision
      || channel.activities.size > 0
      || channel.invocations.size > 0
      || channel.detachedResults.size > 0) return false;
    channel.completionCommitted = true;
    channel.completionRevision = revision;
    console.info(
      `[chatgpt-web] broker trace=${channel.traceId} committed browser completion revision=${revision} toolsQueued=${channel.toolCallsQueued} toolsCompleted=${channel.toolCallsCompleted}${this.diagnosticSuffix()}`,
    );
    return true;
  }

  waitForRetirement(token: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) return Promise.resolve();
    return this.waitForSafeState(channel.retirementWaiters, signal, "turn retirement wait aborted");
  }

  requestCompaction(token: string, queuedResult: BrokerToolResult): number {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    this.assertSafeHarnessRunning(channel);
    if (channel.compactionRequested) {
      throw new Error("Codex context compaction was already requested for this turn");
    }
    const detached = [...channel.detachedResults.entries()];
    channel.compactionRequested = true;
    channel.compactionResult = compactionResultWithDetachedResults(queuedResult, detached);
    if (detached.length > 0) {
      channel.detachedResults.clear();
      channel.activityRevision += 1;
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} carried detached results into compaction count=${detached.length}`,
      );
    }
    if (channel.batchTimer) {
      clearTimeout(channel.batchTimer);
      channel.batchTimer = undefined;
    }
    const queued = channel.queuedCallIds.splice(0);
    for (const callId of queued) {
      const invocation = channel.invocations.get(callId);
      if (!invocation) continue;
      channel.invocations.delete(callId);
      channel.compactionDeliveryCount += 1;
      invocation.resolve(structuredClone(queuedResult));
    }
    if (queued.length > 0) {
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} interrupted queued calls=${queued.length} for context compaction`,
      );
    }
    return queued.length;
  }

  compactionDeliveryCount(token: string): number {
    const channel = this.channels.get(token);
    if (!channel) throw new Error("Cannot read compaction delivery after the turn capability retired");
    return channel.compactionDeliveryCount;
  }

  startSafeTurn(requestId: string): { started: true; duplicate: boolean } {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) throw new Error("Zero Risk request_id is invalid, expired, or revoked");
    const safe = channel.safe;
    if (!safe) throw new Error("request_id is not registered for Zero Risk browser interaction");
    if (safe.state === "completed" || safe.state === "revoked") {
      throw new Error("Zero Risk turn is already terminal");
    }
    if (safe.connectorStarted) return { started: true, duplicate: true };
    safe.connectorStarted = true;
    this.activateSafeTurn(channel, safe);
    return { started: true, duplicate: false };
  }

  confirmSafeTurnSent(requestId: string, surfaceNonce: string): { confirmed: true; duplicate: boolean } {
    this.prune();
    assertSurfaceNonce(surfaceNonce);
    const channel = this.channels.get(requestId);
    if (!channel) throw new Error("Zero Risk request_id is invalid, expired, or revoked");
    const safe = channel.safe;
    if (!safe) throw new Error("request_id is not registered for Zero Risk browser interaction");
    this.assertSafeNonce(safe, surfaceNonce);
    if (safe.state === "completed" || safe.state === "revoked") {
      throw new Error("Zero Risk turn is already terminal");
    }
    if (safe.launcherSent) return { confirmed: true, duplicate: true };
    safe.launcherSent = true;
    this.resolveSafeWaiters(safe.sentWaiters, undefined);
    this.activateSafeTurn(channel, safe);
    return { confirmed: true, duplicate: false };
  }

  completeSafeTurn(
    requestId: string,
    finalAnswer: string,
  ): { completed: true; duplicate: boolean } {
    this.prune();
    if (typeof finalAnswer !== "string" || finalAnswer.trim().length === 0) {
      throw new Error("Zero Risk turn final_answer must not be empty");
    }
    const channel = this.channels.get(requestId);
    if (!channel) throw new Error("Zero Risk request_id is invalid, expired, or revoked");
    const safe = channel.safe;
    if (!safe) throw new Error("request_id is not registered for Zero Risk browser interaction");
    if (safe.state === "completed") {
      if (safe.finalAnswer !== finalAnswer) {
        throw new Error("Zero Risk turn completion conflicts with the accepted final_answer");
      }
      return { completed: true, duplicate: true };
    }
    if (safe.state === "revoked") throw new Error("Zero Risk turn is already terminal");
    if (safe.state !== "running") throw new Error("Zero Risk turn has not started");
    if (channel.invocations.size > 0) {
      throw new Error(`Zero Risk turn cannot complete with ${channel.invocations.size} pending Codex tool invocation(s)`);
    }
    if (channel.detachedResults.size > 0) {
      throw new Error(`Zero Risk turn cannot complete with ${channel.detachedResults.size} unconsumed detached Codex tool result(s)`);
    }
    if (channel.activities.size > 0) {
      throw new Error(`Zero Risk turn cannot complete with ${channel.activities.size} active Codex MCP request(s)`);
    }
    safe.state = "completed";
    safe.finalAnswer = finalAnswer;
    this.resolveSafeWaiters(safe.completionWaiters, finalAnswer);
    console.info(`[chatgpt-web] broker trace=${channel.traceId} accepted safe completion`);
    return { completed: true, duplicate: false };
  }

  waitForSafeStart(requestId: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error("Zero Risk request_id is invalid, expired, or revoked"));
    const safe = channel.safe;
    if (!safe) return Promise.reject(new Error("request_id is not registered for Zero Risk browser interaction"));
    if (safe.state === "running" || safe.state === "completed") return Promise.resolve();
    if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
    return this.waitForSafeState(safe.startWaiters, signal, "Zero Risk turn start wait aborted");
  }

  private waitForSafeSent(requestId: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error("Zero Risk request_id is invalid, expired, or revoked"));
    const safe = channel.safe;
    if (!safe) return Promise.reject(new Error("request_id is not registered for Zero Risk browser interaction"));
    if (safe.launcherSent) return Promise.resolve();
    if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
    return this.waitForSafeState(safe.sentWaiters, signal, "Zero Risk turn Sent wait aborted");
  }

  waitForSafeCompletion(requestId: string, signal?: AbortSignal): Promise<string> {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error("Zero Risk request_id is invalid, expired, or revoked"));
    const safe = channel.safe;
    if (!safe) return Promise.reject(new Error("request_id is not registered for Zero Risk browser interaction"));
    if (safe.state === "completed" && safe.finalAnswer !== undefined) return Promise.resolve(safe.finalAnswer);
    if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
    return this.waitForSafeState(safe.completionWaiters, signal, "Zero Risk turn completion wait aborted");
  }

  revoke(token: string, reason = new Error("Codex turn binding was revoked")): void {
    const channel = this.channels.get(token);
    if (!channel) return;
    console.info(`[chatgpt-web] broker_retired ${JSON.stringify({
      traceId: channel.traceId,
      ...(this.diagnosticIdentity ? { identity: this.diagnosticIdentity } : {}),
      pendingTools: channel.invocations.size,
      queuedTools: channel.queuedCallIds.length,
      deliveredTools: channel.deliveredCallIds.size,
      activeMcpRequests: channel.activities.size,
      detachedToolResults: channel.detachedResults.size,
      completionCommitted: channel.completionCommitted,
    })}`);
    this.channels.delete(token);
    this.pending.delete(token);
    if (channel.bindingId) {
      this.bindings.delete(channel.bindingId);
      this.retire(this.retiredBindings, channel.bindingId, channel.traceId);
    }
    if (channel.safe) {
      channel.safe.state = "revoked";
      this.rejectSafeWaiters(channel.safe.sentWaiters, reason);
      this.rejectSafeWaiters(channel.safe.startWaiters, reason);
      this.rejectSafeWaiters(channel.safe.completionWaiters, reason);
    }
    this.retire(this.retiredTokens, token, channel.traceId);
    this.resolveSafeWaiters(channel.retirementWaiters, undefined);
    for (const waiter of channel.outputWaiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(reason);
    }
    channel.outputWaiters.clear();
    this.rejectChannel(channel, reason);
  }

  externalOwnerActiveCount(): number {
    this.prune();
    return [...this.channels.values()].filter(channel => channel.externalOwner).length;
  }

  revokeExternalOwners(): number {
    const tokens = [...this.channels]
      .filter(([, channel]) => channel.externalOwner)
      .map(([token]) => token);
    for (const token of tokens) this.revoke(token);
    return tokens.length;
  }

  revokeTrace(traceId: string, reason = new Error("Codex turn binding was revoked")): number {
    const tokens = [...this.channels]
      .filter(([, channel]) => channel.traceId === traceId)
      .map(([token]) => token);
    for (const token of tokens) this.revoke(token, reason);
    return tokens.length;
  }

  registerTraceAbortController(traceId: string, controller: AbortController): () => void {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw new Error("turn cancellation trace id is invalid");
    if (controller.signal.aborted) return () => {};
    let controllers = this.traceAbortControllers.get(traceId);
    if (!controllers) {
      controllers = new Set();
      this.traceAbortControllers.set(traceId, controllers);
    }
    controllers.add(controller);
    const unregister = (): void => {
      controller.signal.removeEventListener("abort", unregister);
      controllers!.delete(controller);
      if (controllers!.size === 0) this.traceAbortControllers.delete(traceId);
    };
    controller.signal.addEventListener("abort", unregister, { once: true });
    return unregister;
  }

  cancelTrace(traceId: string, reason = new Error("ChatGPT account-safety automation stop")):
    { cancelledResponses: number; revokedTurns: number } {
    const controllers = [...(this.traceAbortControllers.get(traceId) ?? [])];
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    const revokedTurns = this.revokeTrace(traceId, reason);
    return { cancelledResponses: controllers.length, revokedTurns };
  }

  setExternalOwnersAccepted(accepted: boolean): void {
    this.acceptingExternalOwners = accepted;
  }

  private retire(history: Map<string, string>, handle: string, traceId: string): void {
    history.delete(handle);
    history.set(handle, traceId);
    while (history.size > MAX_RETIRED_TURN_HANDLES) {
      const oldest = history.keys().next();
      if (oldest.done) return;
      history.delete(oldest.value);
    }
  }

  private assertSafeNonce(safe: SafeTurnControl, surfaceNonce: string): void {
    if (safe.surfaceNonce !== surfaceNonce) throw new Error("Zero Risk local browser binding does not match this turn");
  }

  private activateSafeTurn(channel: TurnChannel, safe: SafeTurnControl): void {
    if (safe.state !== "awaiting_start" || !safe.launcherSent || !safe.connectorStarted) return;
    safe.state = "running";
    // The setup window may be bounded, but a turn authorized by the user and bound by the
    // Zero Risk connector remains live until completion, cancellation, or runtime shutdown.
    delete channel.environment.expiresAt;
    this.resolveSafeWaiters(safe.startWaiters, undefined);
  }

  private assertSafeHarnessRunning(channel: TurnChannel, allowCompaction = false): void {
    const safe = channel.safe;
    if (!safe) return;
    if (safe.state === "awaiting_start") {
      if (!safe.launcherSent) throw new Error("Zero Risk turn is waiting for the user's Sent confirmation");
      throw new Error("Zero Risk request is not connected yet. Call codex_turn_start with its request_id first");
    }
    if (safe.state !== "running") throw new Error("Zero Risk turn is already terminal");
    if (channel.compactionRequested && !allowCompaction) {
      throw new Error("Zero Risk turn is awaiting completion for Codex context compaction");
    }
  }

  private waitForSafeState<T>(
    waiters: Set<SafeWaiter<T>>,
    signal: AbortSignal | undefined,
    abortMessage: string,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException(abortMessage, "AbortError"));
    return new Promise<T>((resolveWait, rejectWait) => {
      const waiter: SafeWaiter<T> = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          waiters.delete(waiter);
          rejectWait(new DOMException(abortMessage, "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      waiters.add(waiter);
    });
  }

  private resolveSafeWaiters<T>(waiters: Set<SafeWaiter<T>>, value: T): void {
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(value);
    }
    waiters.clear();
  }

  private rejectSafeWaiters<T>(waiters: Set<SafeWaiter<T>>, error: Error): void {
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    waiters.clear();
  }

  async close(): Promise<void> {
    this.compactionTransactions.close();
    for (const [traceId, controllers] of this.traceAbortControllers) {
      for (const controller of controllers) {
        if (!controller.signal.aborted) controller.abort(new Error("ChatGPT web turn broker closed"));
      }
      this.traceAbortControllers.delete(traceId);
    }
    for (const token of [...this.channels.keys()]) this.revoke(token);
    const server = this.server;
    this.server = undefined;
    this.startPromise = undefined;
    if (brokers.get(this.socketPath) === this) brokers.delete(this.socketPath);
    if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
        if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolveClose();
        else rejectClose(error);
      }));
    }
    const identity = this.socketIdentity;
    this.socketIdentity = undefined;
    if (identity && existsSync(this.socketPath)) {
      const current = lstatSync(this.socketPath);
      if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
        unlinkSync(this.socketPath);
      }
    }
  }

  private start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const attempt = new Promise<void>((resolveStart, rejectStart) => {
      const windowsPipe = isWindowsPipeEndpoint(this.socketPath);
      if (!windowsPipe) {
        // sun_path is a fixed-size field in the kernel, so an over-long path fails inside listen()
        // with nothing but "Failed to listen" and no hint that the length is the problem. Say so.
        const encodedLength = Buffer.byteLength(this.socketPath);
        if (encodedLength > MAX_UNIX_SOCKET_PATH_BYTES) {
          rejectStart(new Error(
            `ChatGPT web broker socket path is ${encodedLength} bytes, over the`
            + ` ${MAX_UNIX_SOCKET_PATH_BYTES}-byte limit this platform allows for a Unix socket:`
            + ` ${this.socketPath}. Choose a shorter runtime directory.`,
          ));
          return;
        }
        mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
      }
      const listen = () => {
        const server = createServer(socket => this.handleSocket(socket));
        this.server = server;
        server.once("error", rejectStart);
        server.on("error", error => {
          console.error(
            `[chatgpt-web] turn broker server error at ${this.socketPath}: ${errorOf(error).message}`,
          );
        });
        server.listen(this.socketPath, () => {
          server.off("error", rejectStart);
          if (!windowsPipe) {
            const { dev, ino } = lstatSync(this.socketPath);
            this.socketIdentity = { dev, ino };
            chmodSync(this.socketPath, 0o600);
          }
          resolveStart();
        });
      };

      if (windowsPipe) {
        listen();
        return;
      }
      if (!existsSync(this.socketPath)) {
        listen();
        return;
      }
      if (!lstatSync(this.socketPath).isSocket()) {
        rejectStart(new Error(`ChatGPT web broker path exists and is not a socket: ${this.socketPath}`));
        return;
      }
      const socketStat = lstatSync(this.socketPath);
      const getuid = process.getuid;
      if (typeof getuid === "function" && socketStat.uid !== getuid()) {
        rejectStart(new Error(`ChatGPT web broker socket is not owned by the current user: ${this.socketPath}`));
        return;
      }
      if ((socketStat.mode & 0o077) !== 0) {
        rejectStart(new Error(`ChatGPT web broker socket has unsafe permissions: ${this.socketPath}`));
        return;
      }
      const probe = createConnection(this.socketPath);
      let probeSettled = false;
      const finishProbe = (action: () => void) => {
        if (probeSettled) return;
        probeSettled = true;
        probe.destroy();
        action();
      };
      probe.setTimeout(2_000, () => finishProbe(() => {
        rejectStart(new Error(`Timed out while checking existing ChatGPT web broker socket: ${this.socketPath}`));
      }));
      probe.once("connect", () => {
        finishProbe(() => {
          rejectStart(new Error(`ChatGPT web broker socket is already owned by another process: ${this.socketPath}`));
        });
      });
      probe.once("error", error => {
        finishProbe(() => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ECONNREFUSED" && code !== "ENOENT") {
            rejectStart(new Error(
              `Could not verify existing ChatGPT web broker socket ${this.socketPath}: ${error.message}`,
            ));
            return;
          }
          try {
            if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
            listen();
          } catch (cleanupError) {
            rejectStart(errorOf(cleanupError));
          }
        });
      });
    });
    this.startPromise = attempt;
    // The daemon keeps serving after a failed startup bind, and the previous owner can release the
    // endpoint moments later. Forget the failed attempt so the next turn probes again instead of
    // inheriting a startup error for the rest of the process lifetime.
    attempt.catch(() => {
      if (this.startPromise !== attempt) return;
      this.startPromise = undefined;
      if (this.server && !this.server.listening) this.server = undefined;
    });
    return attempt;
  }

  private handleSocket(socket: Socket): void {
    let buffered = "";
    let handled = false;
    const disconnected = new AbortController();
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => disconnected.abort());
    socket.on("data", chunk => {
      if (handled) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS && !buffered.slice(0, MAX_BROKER_LINE_CHARS + 1).includes("\n")) {
        handled = true;
        this.writeSocketResponse(socket, { id: "unknown", error: "turn broker request exceeds size limit" });
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = buffered.slice(0, newline);
      let request: BrokerRequest | undefined;
      try {
        if (line.length > MAX_BROKER_LINE_CHARS) throw new Error("turn broker request exceeds size limit");
        request = JSON.parse(line) as BrokerRequest;
        this.validateRequest(request);
      } catch (error) {
        this.writeSocketResponse(socket, { id: request?.id ?? "unknown", error: errorOf(error).message });
        return;
      }
      void Promise.resolve().then(() => this.dispatch(request!, disconnected.signal)).then(
        result => this.writeSocketResponse(socket, { id: request!.id, result }),
        error => this.writeSocketResponse(socket, { id: request!.id, error: errorOf(error).message }),
      );
    });
  }

  private writeSocketResponse(socket: Socket, response: BrokerResponse): void {
    const line = `${JSON.stringify(response)}\n`;
    if (line.length > MAX_BROKER_LINE_CHARS) {
      socket.end(`${JSON.stringify({ id: response.id, error: "turn broker response exceeds size limit" } satisfies BrokerResponse)}\n`);
      return;
    }
    socket.end(line);
  }

  private validateRequest(request: BrokerRequest): void {
    if (!request || typeof request !== "object" || typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256) {
      throw new Error("turn broker request id is invalid");
    }
    if (!["claim", "cancel_trace", "resolve", "release", "invoke", "cancel_invoke", "invoke_status", "owner_status", "owner_register", "owner_register_safe", "owner_update", "owner_safe_sent", "owner_next", "owner_complete", "owner_completion_fence_begin", "owner_prepare_recovery", "owner_completion_fence_commit", "owner_completion_receipt_status", "owner_require_completion_receipt", "owner_wait_retirement", "owner_revoke", "owner_safe_wait_start", "owner_safe_wait_completion", "owner_request_compaction", "owner_compaction_delivery_count", "safe_start", "safe_complete", "native_complete", "activity_complete", "submit_compaction_handoff", "submit_recovery_checkpoint", "submit_output", "owner_next_output", "owner_reset_output", "owner_seal_output"].includes(request.method)) {
      throw new Error("turn broker method is invalid");
    }
  }

  private async dispatch(request: BrokerRequest, socketSignal?: AbortSignal): Promise<unknown> {
    this.prune();
    if (request.method === "cancel_trace") {
      const traceId = request.traceId;
      if (typeof traceId !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
        throw new Error("turn cancellation trace id is invalid");
      }
      if (request.reason !== "account_security") {
        throw new Error("turn cancellation reason is invalid");
      }
      const cancelled = this.cancelTrace(traceId, new Error("ChatGPT account-safety automation stop"));
      return {
        cancelled_responses: cancelled.cancelledResponses,
        revoked_turns: cancelled.revokedTurns,
      };
    }
    if (request.method === "safe_start") {
      if (!request.token) throw new Error("Zero Risk request_id is required");
      return this.startSafeTurn(request.token);
    }
    if (request.method === "safe_complete") {
      if (!request.token) throw new Error("Zero Risk request_id is required");
      if (typeof request.finalAnswer !== "string") throw new Error("Zero Risk turn final_answer is required");
      let channel = this.channels.get(request.token);
      if (channel?.safe?.state === "awaiting_start" && !channel.safe.launcherSent) {
        await this.waitForSafeSent(request.token, socketSignal);
        this.prune();
        channel = this.channels.get(request.token);
      }
      return this.completeSafeTurn(request.token, request.finalAnswer);
    }
    if (request.method === "native_complete") {
      if (!request.token) throw new Error("Native completion turn_token is required");
      if (typeof request.activityId !== "string") throw new Error("Native completion activity id is required");
      if (request.completionState !== "complete" && request.completionState !== "blocked") {
        throw new Error("Native completion state is invalid");
      }
      const strings = (value: unknown, name: string): string[] => {
        if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim().length === 0)) {
          throw new Error(`Native completion ${name} is invalid`);
        }
        return value;
      };
      return this.submitNativeCompletion(request.token, request.activityId, {
        state: request.completionState,
        summary: typeof request.completionSummary === "string" ? request.completionSummary : "",
        completedRequirements: strings(request.completedRequirements ?? [], "completed requirements"),
        blockedRequirements: strings(request.blockedRequirements ?? [], "blocked requirements"),
        remainingActionableRequirements: strings(
          request.remainingActionableRequirements ?? [],
          "remaining actionable requirements",
        ),
        ...(typeof request.blocker === "string" ? { blocker: request.blocker } : {}),
      });
    }
    if (request.method === "submit_compaction_handoff" || request.method === "submit_recovery_checkpoint") {
      if (typeof request.token !== "string" || request.token.length === 0) {
        throw new Error("compaction control token is required");
      }
      if (typeof request.handoffId !== "string" || request.handoffId.length === 0) {
        throw new Error("compaction handoff id is required");
      }
      if (typeof request.summary !== "string") {
        throw new Error("compaction handoff summary is required");
      }
      this.compactionTransactions.submit(
        request.token,
        request.handoffId,
        request.summary,
        request.method === "submit_recovery_checkpoint" ? "recovery" : "compaction",
      );
      return { submitted: true };
    }
    if (request.method === "submit_output") {
      if (!request.token) throw new Error("Codex Native output turn_token is required");
      if (request.outputKind !== "commentary" && request.outputKind !== "reasoning" && request.outputKind !== "final") {
        throw new Error("Codex Native output kind is invalid");
      }
      if (typeof request.outputText !== "string") throw new Error("Codex Native output text is required");
      return this.submitOutput(request.token, request.outputKind, request.outputText);
    }
    if (request.method === "owner_status") {
      return { protocolVersion: 6, acceptingExternalOwners: this.acceptingExternalOwners };
    }
    if (request.method === "owner_register") {
      const environment = ownerEnvironment(request.environment);
      if (request.traceId !== undefined && !/^[A-Za-z0-9_-]{6,128}$/.test(request.traceId)) {
        throw new Error("turn owner trace id is invalid");
      }
      return this.register(environment, request.ttlMs, request.traceId, true).then(token => ({ token }));
    }
    if (request.method === "owner_register_safe") {
      const environment = ownerEnvironment(request.environment);
      assertSurfaceNonce(request.surfaceNonce);
      if (request.traceId !== undefined && !/^[A-Za-z0-9_-]{6,128}$/.test(request.traceId)) {
        throw new Error("turn owner trace id is invalid");
      }
      return this.registerSafe(
        environment,
        request.surfaceNonce,
        request.ttlMs,
        request.traceId,
        true,
      ).then(token => ({ token }));
    }
    if (request.method === "owner_update") {
      if (!request.token) throw new Error("turn owner token is required");
      this.updateEnvironment(request.token, ownerEnvironment(request.environment));
      return { updated: true };
    }
    if (request.method === "owner_safe_sent") {
      if (!request.token) throw new Error("turn owner token is required");
      assertSurfaceNonce(request.surfaceNonce);
      return this.confirmSafeTurnSent(request.token, request.surfaceNonce);
    }
    if (request.method === "owner_next") {
      if (!request.token) throw new Error("turn owner token is required");
      return this.nextToolBatch(request.token, socketSignal).then(requests => ({ requests }));
    }
    if (request.method === "owner_complete") {
      if (!request.token) throw new Error("turn owner token is required");
      if (!request.callId) throw new Error("turn owner call id is required");
      if (!request.toolResult || !Array.isArray(request.toolResult.content)) {
        throw new Error("turn owner tool result is invalid");
      }
      this.completeTool(request.token, request.callId, request.toolResult);
      return { completed: true };
    }
    if (request.method === "owner_next_output") {
      if (!request.token) throw new Error("turn owner token is required");
      if (!Number.isSafeInteger(request.afterSequence) || request.afterSequence! < 0) {
        throw new Error("turn owner output sequence is invalid");
      }
      return this.nextOutput(request.token, request.afterSequence!, socketSignal).then(event => ({ event }));
    }
    if (request.method === "owner_reset_output") {
      if (!request.token) throw new Error("turn owner token is required");
      if (!Number.isSafeInteger(request.outputSequence) || request.outputSequence! < 1) {
        throw new Error("turn owner final output sequence is invalid");
      }
      this.resetOutput(request.token, request.outputSequence!);
      return { reset: true };
    }
    if (request.method === "owner_seal_output") {
      if (!request.token) throw new Error("turn owner token is required");
      if (!Number.isSafeInteger(request.afterSequence) || request.afterSequence! < 0
        || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision! < 0) {
        throw new Error("turn owner output seal arguments are invalid");
      }
      return { sealed: this.sealOutput(request.token, request.afterSequence!, request.expectedRevision!) };
    }
    if (request.method === "owner_completion_fence_begin") {
      if (!request.token) throw new Error("turn owner token is required");
      return { revision: this.beginCompletionFence(request.token) ?? null };
    }
    if (request.method === "owner_prepare_recovery") {
      if (!request.token) throw new Error("turn owner token is required");
      if (request.recoveryPhase !== undefined && !["stop", "submitted"].includes(request.recoveryPhase)) throw new Error("Invalid recovery phase");
      return { prepared: this.prepareRecovery(request.token, request.recoveryPhase) };
    }
    if (request.method === "owner_completion_fence_commit") {
      if (!request.token) throw new Error("turn owner token is required");
      if (!Number.isSafeInteger(request.revision) || request.revision! < 0) {
        throw new Error("turn completion fence revision is invalid");
      }
      return { committed: this.commitCompletionFence(request.token, request.revision!) };
    }
    if (request.method === "owner_require_completion_receipt") {
      if (!request.token) throw new Error("turn owner token is required");
      this.requireNativeCompletionReceipt(request.token);
      return { required: true };
    }
    if (request.method === "owner_completion_receipt_status") {
      if (!request.token) throw new Error("turn owner token is required");
      return { accepted: this.nativeCompletionReceiptAccepted(request.token) };
    }
    if (request.method === "owner_wait_retirement") {
      if (!request.token) throw new Error("turn owner token is required");
      return this.waitForRetirement(request.token, socketSignal).then(() => ({ retired: true }));
    }
    if (request.method === "owner_revoke") {
      if (!request.token) throw new Error("turn owner token is required");
      this.revoke(request.token);
      return { revoked: true };
    }
    if (request.method === "owner_safe_wait_start") {
      if (!request.token) throw new Error("turn owner token is required");
      return this.waitForSafeStart(request.token, socketSignal).then(() => ({ started: true }));
    }
    if (request.method === "owner_safe_wait_completion") {
      if (!request.token) throw new Error("turn owner token is required");
      return this.waitForSafeCompletion(request.token, socketSignal).then(finalAnswer => ({ finalAnswer }));
    }
    if (request.method === "owner_request_compaction") {
      if (!request.token) throw new Error("turn owner token is required");
      if (!request.toolResult || !Array.isArray(request.toolResult.content)) {
        throw new Error("turn owner compaction result is invalid");
      }
      return { interrupted: this.requestCompaction(request.token, request.toolResult) };
    }
    if (request.method === "owner_compaction_delivery_count") {
      if (!request.token) throw new Error("turn owner token is required");
      return { count: this.compactionDeliveryCount(request.token) };
    }
    if (request.method === "claim") {
      const contract = request.contract ?? "native";
      const token = request.token;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error(contract === "safe" ? "request id is required" : "turn token is required");
      }
      const channel = this.channels.get(token);
      let activeChannel = channel && !channel.completionCommitted ? channel : undefined;
      const retiredTurn = channel?.completionCommitted ? channel.traceId : this.retiredTokens.get(token);
      console.error(
        `[chatgpt-web] broker claim received (tokenChars=${token.length}, tokenHash=${handleFingerprint(token)}, valid=${Boolean(activeChannel)}`
        + `${activeChannel ? "" : `, retiredTurn=${retiredTurn ?? "unknown"}`})`,
      );
      if (!activeChannel) {
        throw new Error(retiredTurn !== undefined
          ? `${contract === "safe" ? "This request_id" : "This turn_token"} was issued for ${retiredTurnLabel(retiredTurn)}, which has already finished.`
          + " This Codex Native action can no longer run."
          : `${contract === "safe" ? "request id" : "turn token"} is invalid, expired, or revoked`);
      }
      if (activeChannel.safe) {
        if (contract !== "safe") throw new Error("Zero Risk request id requires the Zero Risk MCP contract");
        if (activeChannel.safe.state === "awaiting_start" && !activeChannel.safe.launcherSent) {
          // ChatGPT can issue its first Harness call in the brief interval between the user sending
          // the copied prompt and confirming Sent in the Launcher. Hold that call behind the local
          // authorization boundary, but still require codex_turn_start before it can run.
          await this.waitForSafeSent(token, socketSignal);
          this.prune();
          activeChannel = this.channels.get(token);
          if (!activeChannel || activeChannel.completionCommitted) {
            throw new Error("turn token is invalid, expired, or revoked");
          }
        }
        this.assertSafeHarnessRunning(activeChannel);
      } else if (contract === "safe") {
        throw new Error("Zero Risk MCP contract requires a Zero Risk request id");
      }
      if (typeof request.activityId !== "string" || !/^activity_[A-Za-z0-9_-]{16,128}$/.test(request.activityId)) {
        throw new Error("turn activity id is invalid");
      }
      const activityId = request.activityId;
      if (activeChannel.completedActivities.has(activityId)) {
        throw new Error("turn activity was already completed before this claim settled");
      }
      if (!activeChannel.activities.has(activityId)) {
        if (activeChannel.nativeCompletionReceipt) {
          activeChannel.nativeCompletionReceipt = undefined;
          console.info(`[chatgpt-web] broker trace=${activeChannel.traceId} invalidated native completion receipt after new MCP activity`);
        }
        if (activeChannel.pendingNativeCompletionReceipt
          && activeChannel.pendingNativeCompletionReceipt.activityId !== activityId) {
          activeChannel.pendingNativeCompletionReceipt = undefined;
        }
        activeChannel.activities.add(activityId);
        activeChannel.activityRevision += 1;
      }
      if (activeChannel.bindingId) {
        const existing = this.bindings.get(activeChannel.bindingId);
        if (!existing || existing.token !== token || existing.channel !== activeChannel) {
          throw new Error("turn token binding state is inconsistent");
        }
        return { bindingId: activeChannel.bindingId, activityId, environment: activeChannel.environment };
      }
      this.pending.delete(token);
      const bindingId = opaqueId("binding");
      activeChannel.bindingId = bindingId;
      this.bindings.set(bindingId, { token, channel: activeChannel });
      return { bindingId, activityId, environment: activeChannel.environment };
    }

    const bindingId = request.bindingId;
    if (request.method === "activity_complete") {
      const token = request.token;
      if (typeof token !== "string" || token.length === 0) throw new Error("turn token is required");
      if (typeof request.activityId !== "string" || !/^activity_[A-Za-z0-9_-]{16,128}$/.test(request.activityId)) {
        throw new Error("turn activity id is invalid");
      }
      const channel = this.channels.get(token);
      if (!channel) {
        return { completed: false, retired: this.retiredTokens.has(token) };
      }
      if (channel.completedActivities.has(request.activityId)) {
        return { completed: false, duplicate: true };
      }
      const wasActive = channel.activities.delete(request.activityId);
      channel.completedActivities.add(request.activityId);
      // A cleanup that overtakes an ambiguously delivered claim is still a causal event. Its
      // tombstone makes the delayed claim fail instead of resurrecting activity after a fence.
      channel.activityRevision += 1;
      if (channel.pendingNativeCompletionReceipt?.activityId === request.activityId) {
        channel.nativeCompletionReceipt = {
          receipt: channel.pendingNativeCompletionReceipt.receipt,
          revision: channel.activityRevision,
        };
        channel.pendingNativeCompletionReceipt = undefined;
        console.info(
          `[chatgpt-web] broker trace=${channel.traceId} accepted native completion receipt revision=${channel.activityRevision}`,
        );
      }
      return { completed: wasActive };
    }

    if (typeof bindingId !== "string" || bindingId.length === 0) throw new Error("binding id is required");
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      const retiredTurn = this.retiredBindings.get(bindingId);
      if (request.method === "release" && retiredTurn !== undefined) {
        return { released: true, duplicate: true };
      }
      console.error(
        `[chatgpt-web] broker rejected ${request.method} (binding=${bindingId.slice(0, 17)},`
        + ` retiredTurn=${retiredTurn ?? "unknown"})`,
      );
      throw new Error(retiredTurn !== undefined
        ? `${retiredTurnLabel(retiredTurn)} has already finished; this Codex Native action can no longer run.`
        : "internal Codex turn binding is invalid or expired");
    }
    if (request.method === "cancel_invoke") {
      const callId = request.callId?.trim();
      if (!callId || !/^call_[A-Za-z0-9_-]{16,128}$/.test(callId)) {
        throw new Error("turn broker invocation call id is invalid");
      }
      const invocation = binding.channel.invocations.get(callId);
      if (!invocation) {
        const completed = binding.channel.recentToolResults.get(callId);
        if (completed) {
          return {
            cancelled: false,
            delivered: true,
            pending: false,
            completed: true,
            toolResult: structuredClone(completed),
          };
        }
        return { cancelled: false, delivered: false, pending: false, completed: false };
      }
      if (binding.channel.deliveredCallIds.has(callId)) {
        // Once Codex has received the call it may already be executing a side effect. Detach only
        // the expired MCP response; keep the turn and native operation alive so its result can be
        // consumed later by invoke_status without duplicating the operation.
        if (!invocation.detached) {
          invocation.detached = true;
          binding.channel.activityRevision += 1;
        }
        return { cancelled: false, delivered: true, pending: true, completed: false };
      }
      binding.channel.invocations.delete(callId);
      binding.channel.queuedCallIds = binding.channel.queuedCallIds.filter(id => id !== callId);
      binding.channel.activityRevision += 1;
      invocation.reject(new Error("Codex Native invocation was abandoned before delivery"));
      console.info(
        `[chatgpt-web] broker trace=${binding.channel.traceId} abandoned queued call=${callId.slice(0, 17)} bindingRetained=true`,
      );
      return { cancelled: true, delivered: false, pending: false, completed: false };
    }
    if (request.method === "invoke_status") {
      const callId = request.callId?.trim();
      if (!callId || !/^call_[A-Za-z0-9_-]{16,128}$/.test(callId)) {
        throw new Error("turn broker invocation call id is invalid");
      }
      const pending = binding.channel.invocations.get(callId);
      if (pending) {
        return {
          state: "running",
          delivered: binding.channel.deliveredCallIds.has(callId),
          detached: pending.detached === true,
        };
      }
      const completed = binding.channel.detachedResults.get(callId);
      if (completed) {
        binding.channel.detachedResults.delete(callId);
        binding.channel.activityRevision += 1;
        return { state: "completed", toolResult: structuredClone(completed) };
      }
      if (binding.channel.recentToolResults.has(callId)) {
        return { state: "completed_elsewhere" };
      }
      return { state: "unknown" };
    }
    if (request.method === "release") {
      this.revoke(binding.token);
      return { released: true };
    }
    if (request.method === "resolve") return { environment: binding.channel.environment };
    this.assertSafeHarnessRunning(binding.channel);
    if (binding.channel.compactionRequested) {
      const result = binding.channel.compactionResult;
      if (!result) throw new Error("Codex context compaction control result is unavailable");
      binding.channel.compactionDeliveryCount += 1;
      console.info(
        `[chatgpt-web] broker trace=${binding.channel.traceId} intercepted a post-compaction MCP call`,
      );
      return structuredClone(result);
    }

    const wireName = request.wireName?.trim();
    if (!wireName) throw new Error("wire tool name is required");
    const requestedCallId = request.callId?.trim();
    if (requestedCallId !== undefined && !/^call_[A-Za-z0-9_-]{16,128}$/.test(requestedCallId)) {
      throw new Error("turn broker invocation call id is invalid");
    }
    const callId = requestedCallId ?? opaqueId("call");
    if (binding.channel.invocations.has(callId) || binding.channel.deliveredCallIds.has(callId)) {
      throw new Error("turn broker invocation call id is already active");
    }

    // Do not let a model that forgot to poll codex_tool_wait strand completed work until context
    // compaction. Any later work-tool boundary first drains the oldest detached result. The newly
    // requested tool is not dispatched, so side effects cannot be duplicated or reordered.
    const detached = binding.channel.detachedResults.entries().next();
    if (!detached.done) {
      const [originalCallId, retained] = detached.value;
      binding.channel.detachedResults.delete(originalCallId);
      binding.channel.activityRevision += 1;
      console.info(
        `[chatgpt-web] broker trace=${binding.channel.traceId} replayed detached result call=${originalCallId.slice(0, 17)} insteadOf=${wireName} remaining=${binding.channel.detachedResults.size}`,
      );
      return detachedToolReplayResult(originalCallId, wireName, retained);
    }

    await this.dispatchGuard?.(binding.channel.traceId);
    if (binding.channel.recoveryDispatchPaused) return { isError: true,
      content: [{ type: "text", text: "RECONCILIATION_REQUIRED: native dispatch is fenced until verified Stop/continuation submission; this operation was not dispatched." }],
      structuredContent: { code: "RECONCILIATION_REQUIRED", operationAlreadyDispatched: false } };
    if (socketSignal?.aborted) throw new Error("turn broker invocation was cancelled before dispatch");
    const fingerprint = typeof request.operationFingerprint === "string" && /^[a-f0-9]{64}$/.test(request.operationFingerprint)
      ? request.operationFingerprint : operationFingerprint(wireName, request.arguments, request.input);
    const toolRequest: BrokerToolRequest = {
      callId,
      wireName,
      freeform: request.freeform === true,
      ...(request.freeform === true ? { input: request.input ?? "" } : { arguments: request.arguments ?? {} }),
      ...(typeof request.requestedTool === "string" && /^[A-Za-z0-9_.-]{1,200}$/.test(request.requestedTool)
        ? { requestedTool: request.requestedTool } : {}),
      ...(sanitizedOperationIntent(request.operationIntent) ? { operationIntent: sanitizedOperationIntent(request.operationIntent) } : {}),
      ...(typeof request.registryGeneration === "string" && /^[a-f0-9]{12}$/.test(request.registryGeneration)
        ? { registryGeneration: request.registryGeneration } : {}),
      ...(typeof request.backgroundReceiptNonce === "string" && /^[a-f0-9]{48}$/.test(request.backgroundReceiptNonce)
        ? { backgroundReceiptNonce: request.backgroundReceiptNonce,
          backgroundArguments: Object.fromEntries(Object.entries(request.backgroundArguments ?? {})
            .filter(([key, value]) => ["session_id", "target", "process", "targets"].includes(key)
              && (typeof value === "string" || Number.isSafeInteger(value) || Array.isArray(value)))) } : {}),
    };
    const rejected = binding.channel.rejectedOperations.get(fingerprint);
    if (rejected) {
      console.info(`[native-operation] trace=${binding.channel.traceId} ${operationTelemetry("blocked_before_dispatch", toolRequest, {
        safety: nativeSafetyDiagnostic(rejected), brokerDelivered: false, operationAlreadyDispatched: false,
        retryAttempted: true, retryRepresentationChanged: false, elapsedMs: 0,
      })}`);
      return structuredClone(rejected);
    }
    const completed = binding.channel.recovering ? binding.channel.operationResults.get(fingerprint) : undefined;
    if (completed) return detachedToolReplayResult(completed.callId, wireName, structuredClone(completed.result));
    if (binding.channel.environment.recoveryScope && !classifyNativeOperation(toolRequest.requestedTool ?? wireName, toolRequest.arguments).readOnly) {
      this.operationLedger.begin(binding.channel.environment.recoveryScope, fingerprint);
    }
    binding.channel.finishDecision?.();
    binding.channel.finishDecision = undefined;
    if (binding.channel.lastComputerUseCompletedAt !== undefined) {
      const decisionLatencyMs = Math.max(0, Date.now() - binding.channel.lastComputerUseCompletedAt);
      console.info(
        `[computer-use] trace=${binding.channel.traceId} decisionLatencyMs=${decisionLatencyMs}`
        + ` previousTool=${binding.channel.lastComputerUseCompletedTool ?? "unknown"} nextTool=${wireName}`,
      );
      binding.channel.lastComputerUseCompletedAt = undefined;
      binding.channel.lastComputerUseCompletedTool = undefined;
    }
    return new Promise<BrokerToolResult>((resolveInvoke, rejectInvoke) => {
      const perf = new BackendPerfTrace(binding.channel.traceId);
      binding.channel.invocations.set(callId, { request: toolRequest, resolve: resolveInvoke, reject: rejectInvoke,
        startedAt: Date.now(), fingerprint,
        ...(typeof request.failureMarker === "string" && /^\{"__codex_native_failure_v1":"[a-f0-9]{48}"\}$/.test(request.failureMarker)
          ? { failureMarker: request.failureMarker } : {}),
        perf, finishQueue: perf.start("broker_queue") });
      binding.channel.queuedCallIds.push(callId);
      binding.channel.toolCallsQueued += 1;
      console.info(`[native-operation] trace=${binding.channel.traceId} ${operationTelemetry("queued", toolRequest, {
        brokerDelivered: false, operationAlreadyDispatched: false,
      })}`);
      console.info(
        `[chatgpt-web] broker trace=${binding.channel.traceId} queued call=${callId.slice(0, 17)} tool=${wireName} waiters=${binding.channel.waiters.size} toolsQueued=${binding.channel.toolCallsQueued}${this.diagnosticSuffix()}`,
      );
      const modelObservation = !toolRequest.freeform && subagentModelObservation(wireName, toolRequest.arguments);
      if (modelObservation) console.info(`[chatgpt-web] subagent_model_requested ${JSON.stringify({
        traceId: binding.channel.traceId, callId: callId.slice(0, 17), tool: wireName, ...modelObservation,
      })}`);
      this.scheduleToolWaiters(binding.channel);
    });
  }

  private takeQueued(channel: TurnChannel): BrokerToolRequest[] {
    const ids = channel.queuedCallIds.splice(0);
    for (const id of ids) {
      const invocation = channel.invocations.get(id);
      if (invocation) {
        channel.deliveredCallIds.add(id);
        invocation.finishQueue?.();
        invocation.finishNative = invocation.perf?.start("native_completion");
      }
    }
    return ids.map(id => channel.invocations.get(id)?.request).filter((request): request is BrokerToolRequest => Boolean(request));
  }

  private logToolDelivery(channel: TurnChannel, batch: BrokerToolRequest[], path: "immediate" | "waiter" | "replay"): void {
    for (const request of batch) {
      console.info(`[native-operation] trace=${channel.traceId} ${operationTelemetry("delivered", request, {
        brokerDelivered: true, nativeInvoked: "unknown", operationAlreadyDispatched: true, deliveryReplay: path === "replay",
      })}`);
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} delivered call=${request.callId.slice(0, 17)} path=${path} replay=${path === "replay"}${this.diagnosticSuffix()}`,
      );
    }
  }

  private scheduleToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    if (channel.batchTimer) return;
    channel.batchTimer = setTimeout(() => {
      channel.batchTimer = undefined;
      this.wakeToolWaiters(channel);
    }, 15);
  }

  private wakeToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    const batch = this.takeQueued(channel);
    this.logToolDelivery(channel, batch, "waiter");
    const waiters = [...channel.waiters];
    channel.waiters.clear();
    const first = waiters.shift();
    if (first) {
      if (first.signal && first.onAbort) first.signal.removeEventListener("abort", first.onAbort);
      first.resolve(batch);
    }
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("another adapter waiter already claimed the queued tool batch"));
    }
  }

  private rejectChannel(channel: TurnChannel, error: Error): void {
    if (channel.batchTimer) clearTimeout(channel.batchTimer);
    channel.batchTimer = undefined;
    for (const waiter of channel.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    channel.waiters.clear();
    for (const invocation of channel.invocations.values()) invocation.reject(error);
    channel.invocations.clear();
    channel.detachedResults.clear();
    channel.recentToolResults.clear();
    channel.operationResults.clear();
    channel.queuedCallIds = [];
    channel.deliveredCallIds.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, channel] of this.channels) {
      if (channel.environment.expiresAt === undefined || channel.environment.expiresAt > now) continue;
      this.revoke(token);
    }
  }
}

/**
 * A turn registered without a TTL has no deadline to bound its tool calls against, so a null
 * timeout waits for as long as the turn itself lives. Undefined keeps the bounded default, because
 * a caller that cannot compute a deadline must not silently inherit an unbounded wait. An
 * unbounded call still ends when the turn is revoked or the broker drops the connection.
 */
export class TurnBrokerTimeoutError extends Error {
  constructor() {
    super("ChatGPT web turn broker timed out");
    this.name = "TurnBrokerTimeoutError";
  }
}

export async function callTurnBroker<T>(
  socketPath: string,
  request: Omit<BrokerRequest, "id">,
  timeoutMs: number | null = 5_000,
  signal?: AbortSignal,
): Promise<T> {
  const id = opaqueId("request");
  const settleOnResponseFrame = timeoutMs === null;
  // The wire protocol requires a client-owned activity identity. Most callers never need to see
  // it; the MCP server supplies its own so it can retire an ambiguously delivered claim, while
  // lower-level diagnostics receive an equally client-generated identity here.
  const wireRequest = request.method === "claim" && request.activityId === undefined
    ? { ...request, activityId: opaqueId("activity") }
    : request;
  return new Promise<T>((resolveCall, rejectCall) => {
    const socket = createConnection(socketPath);
    let buffered = "";
    let settled = false;
    let response: BrokerResponse | undefined;
    const onAbort = () => finishError(new DOMException("ChatGPT web turn broker call aborted", "AbortError"));
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      socket.destroy();
      rejectCall(error);
    };
    const finishResponse = () => {
      if (settled) return;
      if (!response) {
        finishError(new Error("ChatGPT web turn broker closed the connection"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (response.error) rejectCall(new Error(response.error));
      else resolveCall(response.result as T);
    };
    const timer = timeoutMs === null
      ? undefined
      : setTimeout(() => finishError(new TurnBrokerTimeoutError()), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finishError(new DOMException("ChatGPT web turn broker call aborted", "AbortError"));
      return;
    }
    socket.setEncoding("utf8");
    socket.once("error", error => finishError(new Error(`ChatGPT web turn broker unavailable: ${error.message}`)));
    // The server owns response termination. Bounded calls wait for the pipe/socket to close
    // before their callers can advance the lifecycle while Bun drains named-pipe writes.
    socket.once("close", finishResponse);
    socket.once("end", () => {
      if (!response) finishResponse();
      else socket.end();
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, ...wireRequest })}\n`));
    socket.on("data", chunk => {
      if (settled || response) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS) {
        finishError(new Error("ChatGPT web turn broker response exceeds size limit"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let parsed: BrokerResponse;
      try {
        parsed = JSON.parse(buffered.slice(0, newline)) as BrokerResponse;
      } catch (error) {
        finishError(new Error(`ChatGPT web turn broker returned invalid JSON: ${errorOf(error).message}`));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || ("result" in parsed) === ("error" in parsed)
        || ("error" in parsed && (typeof parsed.error !== "string" || !parsed.error))) {
        finishError(new Error("ChatGPT web turn broker returned an invalid response frame"));
        return;
      }
      if (parsed.id !== id) {
        finishError(new Error("ChatGPT web turn broker response id mismatch"));
        return;
      }
      response = parsed;
      if (settleOnResponseFrame) {
        // Long-polls finish on the full frame; their peer can otherwise keep both halves open.
        finishResponse();
        socket.destroy();
      }
    });
  });
}

/**
 * Outer-harness client for a broker already owned by the live launcher runtime. It lets a
 * working-tree DEV driver exercise the production adapter and MCP connector without binding a
 * Responses port or replacing the active Codex route.
 */
export class RemoteTurnBroker implements TurnBrokerOwner {
  constructor(readonly socketPath: string) {}

  async assertCompatible(): Promise<void> {
    let status: { protocolVersion?: unknown; acceptingExternalOwners?: unknown };
    try {
      status = await callTurnBroker(this.socketPath, { method: "owner_status" });
    } catch (error) {
      throw new Error(
        "The running launcher runtime does not expose the DEV turn-owner protocol; update and restart Codex Web GPT once before using the working-tree DEV chat"
        + ` (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (status.protocolVersion !== 6) {
      throw new Error(`Unsupported DEV turn-owner protocol version: ${String(status.protocolVersion)}`);
    }
    if (status.acceptingExternalOwners !== true) {
      throw new Error("The running launcher runtime is draining and is not accepting DEV chat turns");
    }
  }

  async register(environment: ChatGptTurnEnvironment, ttlMs?: number, traceId = "unknown"): Promise<string> {
    const response = await callTurnBroker<{ token?: unknown }>(this.socketPath, {
      method: "owner_register",
      environment,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(traceId !== "unknown" ? { traceId } : {}),
    });
    if (typeof response.token !== "string" || !response.token.startsWith("turn_")) {
      throw new Error("DEV turn owner received an invalid broker token");
    }
    return response.token;
  }

  async registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId = "unknown",
  ): Promise<string> {
    assertSurfaceNonce(surfaceNonce);
    const response = await callTurnBroker<{ token?: unknown }>(this.socketPath, {
      method: "owner_register_safe",
      environment,
      surfaceNonce,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(traceId !== "unknown" ? { traceId } : {}),
    });
    if (typeof response.token !== "string" || !response.token.startsWith("request_")) {
      throw new Error("DEV Zero Risk turn owner received an invalid broker request id");
    }
    return response.token;
  }

  async updateEnvironment(token: string, environment: ChatGptTurnEnvironment): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_update", token, environment });
  }

  async confirmSafeTurnSent(
    token: string,
    surfaceNonce: string,
  ): Promise<{ confirmed: true; duplicate: boolean }> {
    const response = await callTurnBroker<{ confirmed?: unknown; duplicate?: unknown }>(this.socketPath, {
      method: "owner_safe_sent",
      token,
      surfaceNonce,
    });
    if (response.confirmed !== true || typeof response.duplicate !== "boolean") {
      throw new Error("DEV Zero Risk turn owner received an invalid Sent confirmation result");
    }
    return { confirmed: true, duplicate: response.duplicate };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    const response = await callTurnBroker<{ requests?: unknown }>(
      this.socketPath,
      { method: "owner_next", token },
      null,
      signal,
    );
    if (!Array.isArray(response.requests) || response.requests.some(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return true;
      const request = value as Partial<BrokerToolRequest>;
      return typeof request.callId !== "string" || typeof request.wireName !== "string"
        || typeof request.freeform !== "boolean"
        || (request.freeform
          ? typeof request.input !== "string"
          : !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments));
    })) throw new Error("DEV turn owner received an invalid tool batch");
    return response.requests as BrokerToolRequest[];
  }

  async completeTool(token: string, callId: string, result: BrokerToolResult): Promise<void> {
    await callTurnBroker(this.socketPath, {
      method: "owner_complete",
      token,
      callId,
      toolResult: result,
    }, null);
  }

  async nextOutput(token: string, afterSequence: number, signal?: AbortSignal): Promise<BrokerTurnOutputEvent> {
    const response = await callTurnBroker<{ event?: unknown }>(
      this.socketPath,
      { method: "owner_next_output", token, afterSequence },
      null,
      signal,
    );
    const event = response.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("DEV turn owner received an invalid Native output event");
    }
    const parsed = event as Partial<BrokerTurnOutputEvent>;
    if (!Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) < 1
      || (parsed.kind !== "commentary" && parsed.kind !== "reasoning" && parsed.kind !== "final")
      || typeof parsed.text !== "string") {
      throw new Error("DEV turn owner received an invalid Native output event");
    }
    return parsed as BrokerTurnOutputEvent;
  }

  async resetOutput(token: string, finalSequence: number): Promise<void> {
    const response = await callTurnBroker<{ reset?: unknown }>(this.socketPath, {
      method: "owner_reset_output", token, outputSequence: finalSequence,
    });
    if (response.reset !== true) throw new Error("DEV turn owner could not reset Native output");
  }

  async sealOutput(token: string, afterSequence: number, expectedRevision: number): Promise<boolean> {
    const response = await callTurnBroker<{ sealed?: unknown }>(this.socketPath, {
      method: "owner_seal_output", token, afterSequence, expectedRevision,
    });
    if (typeof response.sealed !== "boolean") {
      throw new Error("DEV turn owner received an invalid Native output seal result");
    }
    return response.sealed;
  }

  async waitForSafeStart(token: string, signal?: AbortSignal): Promise<void> {
    const response = await callTurnBroker<{ started?: unknown }>(
      this.socketPath,
      { method: "owner_safe_wait_start", token },
      null,
      signal,
    );
    if (response.started !== true) throw new Error("DEV Zero Risk turn owner received an invalid start result");
  }

  async waitForSafeCompletion(token: string, signal?: AbortSignal): Promise<string> {
    const response = await callTurnBroker<{ finalAnswer?: unknown }>(
      this.socketPath,
      { method: "owner_safe_wait_completion", token },
      null,
      signal,
    );
    if (typeof response.finalAnswer !== "string" || response.finalAnswer.trim().length === 0) {
      throw new Error("DEV Zero Risk turn owner received an invalid completion result");
    }
    return response.finalAnswer;
  }

  async requestCompaction(token: string, queuedResult: BrokerToolResult): Promise<number> {
    const response = await callTurnBroker<{ interrupted?: unknown }>(this.socketPath, {
      method: "owner_request_compaction",
      token,
      toolResult: queuedResult,
    }, null);
    if (!Number.isSafeInteger(response.interrupted) || Number(response.interrupted) < 0) {
      throw new Error("DEV Zero Risk turn owner received an invalid compaction interrupt count");
    }
    return Number(response.interrupted);
  }

  async compactionDeliveryCount(token: string): Promise<number> {
    const response = await callTurnBroker<{ count?: unknown }>(this.socketPath, {
      method: "owner_compaction_delivery_count",
      token,
    });
    if (!Number.isSafeInteger(response.count) || Number(response.count) < 0) {
      throw new Error("DEV Zero Risk turn owner received an invalid compaction delivery count");
    }
    return Number(response.count);
  }

  async beginCompletionFence(token: string): Promise<number | undefined> {
    const response = await callTurnBroker<{ revision?: unknown }>(this.socketPath, {
      method: "owner_completion_fence_begin",
      token,
    });
    if (response.revision === null) return undefined;
    if (!Number.isSafeInteger(response.revision) || (response.revision as number) < 0) {
      throw new Error("DEV turn owner received an invalid completion fence revision");
    }
    return response.revision as number;
  }

  async prepareRecovery(token: string, phase?: "stop" | "submitted"): Promise<boolean> {
    const response = await callTurnBroker<{ prepared?: unknown }>(this.socketPath, { method: "owner_prepare_recovery", token, recoveryPhase: phase });
    if (typeof response.prepared !== "boolean") throw new Error("DEV turn owner received an invalid recovery preparation result");
    return response.prepared;
  }

  async commitCompletionFence(token: string, revision: number): Promise<boolean> {
    const response = await callTurnBroker<{ committed?: unknown }>(this.socketPath, {
      method: "owner_completion_fence_commit",
      token,
      revision,
    });
    if (typeof response.committed !== "boolean") {
      throw new Error("DEV turn owner received an invalid completion fence result");
    }
    return response.committed;
  }

  async requireNativeCompletionReceipt(token: string): Promise<void> {
    const response = await callTurnBroker<{ required?: unknown }>(this.socketPath, {
      method: "owner_require_completion_receipt",
      token,
    });
    if (response.required !== true) throw new Error("DEV turn owner could not require native completion receipt");
  }

  async nativeCompletionReceiptAccepted(token: string): Promise<boolean> {
    const response = await callTurnBroker<{ accepted?: unknown }>(this.socketPath, {
      method: "owner_completion_receipt_status",
      token,
    });
    if (typeof response.accepted !== "boolean") {
      throw new Error("DEV turn owner received an invalid native completion receipt status");
    }
    return response.accepted;
  }

  async waitForRetirement(token: string, signal?: AbortSignal): Promise<void> {
    const response = await callTurnBroker<{ retired?: unknown }>(
      this.socketPath,
      { method: "owner_wait_retirement", token },
      null,
      signal,
    );
    if (response.retired !== true) throw new Error("DEV turn owner received an invalid retirement result");
  }

  async revoke(token: string, _reason?: Error): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_revoke", token });
  }
}
