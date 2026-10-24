import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import {
  cancelLauncherManualTurn,
  endLauncherManualTurn,
  LauncherBrowserTurnCancelledError,
  LauncherManualTurnFailedError,
  LauncherManualTurnTimedOutError,
  markLauncherManualTurnStarted,
  releaseLauncherRetainedConversation,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
  type LauncherManualTurnEnd,
  type LauncherManualTurnOwner,
  type LauncherManualTurnStart,
} from "../../launcher-browser-host";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptWebAdapterError, ChatGptSteeringObserverSuperseded, chatGptSafetyStatusUnknownOrBlockedError, chatGptToolTimeoutError } from "./adapter-error";
import { ChatGptBrowserWorker, chatGptSuspensionClock, remainingStageBudgetMs } from "./browser-worker";
import {createArchiveReadProof} from './archive-read-proof';
import {validateContextArchive} from './context-archive';
import {BlockedOperationLedger} from './blocked-operation-ledger';
import {readBlockedOperationReview} from './blocked-operation-review';
import {waitForArchiveReadBounded} from './archive-read-budget';
import { extractChatGptCompactionSourceRevision, extractChatGptTurnEnvironment, extractChatGptTurnIdentity, priorChatGptAbortedTurnIds } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptInstructionLineage, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnRoundKey, chatGptTurnSessions, bindAcceptedCompactionSource, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "./compaction-handoff";
import {
  chatGptConversationKey,
} from "./conversation-key";
import { retainedConversationProofs, retainedResumeForCheckpoint } from './retained-followup-proof';
import { EnhancedRecoveryCheckpointStore, ENHANCED_RECOVERY_CHECKPOINT_INTERVAL_TOKENS } from './enhanced-recovery-checkpoint';
import { passiveRecoveryCheckpointInstruction } from './native-compaction-control';
import { createSameTabRecoveryDelta } from './same-tab-recovery-policy';
import { awaitFinalBrokerRetirement, pendingJournaledFinalAnswerSuffix } from './finalization-gate';
import {LiveSteering} from './live-steering';
import { nativeCommandSurface } from './native-command-surface';

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ChatGptWebAdapterError) return signal.reason;
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

class ChatGptObserverDisconnected extends DOMException {
  constructor(readonly cause: unknown) {
    super("The Codex response stream disconnected", "AbortError");
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function cancellableBrowserTurn(
  run: Promise<string>,
  controller: AbortController,
): { browser: Promise<string>; physicalSettlement: Promise<void>; cancel: (reason?: Error) => void } {
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationRejected = false;
  return {
    // Cancellation wins immediately even while the detached Playwright helper is still unwinding.
    // The helper keeps the same abort signal and remains responsible for its normal end/cleanup
    // handshake, but the Codex Responses turn no longer waits on that process cleanup.
    browser: Promise.race([run, cancellation]),
    // `browser` is the fast client-facing result. Replacement ownership must wait for the actual
    // worker promise, whose finally block completes the launcher /turn/end handshake.
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      // Explicit targeted cancellation ends the Codex Responses turn immediately. Generic
      // retirement (client disconnect or compaction replacement) still waits for the helper's
      // cleanup handshake before a replacement browser may start.
      if (reason && !cancellationRejected) {
        cancellationRejected = true;
        rejectCancellation(reason);
      }
    },
  };
}

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

const launcherZeroRiskManualControl: ChatGptZeroRiskManualControl = {
  start: startLauncherManualTurn,
  waitSent: waitForLauncherManualSent,
  waitTerminal: waitForLauncherManualTerminal,
  markStarted: markLauncherManualTurnStarted,
  end: endLauncherManualTurn,
  cancel: cancelLauncherManualTurn,
};

function safeManualAdapterError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof ChatGptWebAdapterError) return error;
  if (error instanceof LauncherManualTurnTimedOutError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 408,
      errorType: "invalid_request_error",
      code: "manual_handoff_timeout",
      retryable: false,
    });
  }
  if (error instanceof LauncherBrowserTurnCancelledError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  if (error instanceof LauncherManualTurnFailedError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 502,
      errorType: "server_error",
      code: "manual_launcher_failed",
      retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeManualTerminalError(status: "cancelled" | "failed"): ChatGptWebAdapterError {
  if (status === "cancelled") {
    return new ChatGptWebAdapterError("The Zero Risk browser turn was cancelled in the Launcher", {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  return new ChatGptWebAdapterError("The Zero Risk browser tab failed before ChatGPT completed the turn", {
    status: 502,
    errorType: "server_error",
    code: "manual_launcher_failed",
    retryable: false,
  });
}

export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  const namespace = chatGptWebExecutionNamespace(provider);
  // The logical response key survives compaction so a final answer that won the handoff race
  // can still be replayed. A new physical browser owner must instead belong to the new context
  // epoch; otherwise Zero Risk correctly rejects it against the previous owner's completion.
  const conversation = parsed._compactionRequest ? undefined : chatGptConversationKey(parsed, namespace);
  return createHash("sha256")
    .update(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)
    .update(conversation ? `:${conversation}` : "")
    .digest("hex")
    .slice(0, 12);
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMcpResultContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image" || value.type === "audio") {
    return typeof value.data === "string" && typeof value.mimeType === "string" && value.mimeType.length > 0;
  }
  if (value.type === "resource_link") {
    return typeof value.uri === "string" && typeof value.name === "string";
  }
  if (value.type === "resource" && isRecord(value.resource)) {
    return typeof value.resource.uri === "string"
      && (typeof value.resource.text === "string" || typeof value.resource.blob === "string");
  }
  return false;
}

function imageBlockKey(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "image"
    || typeof value.data !== "string" || typeof value.mimeType !== "string") return undefined;
  return `${value.mimeType}\0${value.data}`;
}

export function chatGptWebBrokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  // Native Responses history can carry an MCP CallToolResult as JSON text inside
  // function_call_output. Recover its actual error bit and receipts before this
  // result is relayed back through MCP; quoted text alone is never treated as an error.
  if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
    const envelope = structured as Record<string, unknown>;
    if (typeof envelope.isError === "boolean"
      && Array.isArray(envelope.content)
      && envelope.content.every(isMcpResultContentBlock)) {
      // Replace all serialized text fragments once at their first position. Images parsed
      // separately from native input_image blocks stay in source order, while equivalent
      // envelope images are deduplicated only by exact MIME type and bytes.
      const envelopeImageCounts = new Map<string, number>();
      for (const block of envelope.content) {
        const key = imageBlockKey(block);
        if (key) envelopeImageCounts.set(key, (envelopeImageCounts.get(key) ?? 0) + 1);
      }
      const expanded: unknown[] = [];
      let replacedEnvelopeText = false;
      for (const block of content) {
        const imageKey = imageBlockKey(block);
        const duplicateCount = imageKey ? envelopeImageCounts.get(imageKey) ?? 0 : 0;
        if (imageKey && duplicateCount > 0) {
          envelopeImageCounts.set(imageKey, duplicateCount - 1);
          continue;
        }
        if (isRecord(block) && block.type === "text") {
          if (!replacedEnvelopeText) {
            expanded.push(...envelope.content);
            replacedEnvelopeText = true;
          }
        } else {
          expanded.push(block);
        }
      }
      if (replacedEnvelopeText) {
        return {
          content: expanded,
          ...(envelope.structuredContent !== undefined ? { structuredContent: envelope.structuredContent } : {}),
          isError: message.isError || envelope.isError,
          ...(envelope._meta !== undefined ? { _meta: envelope._meta } : {}),
        };
      }
    }
  }
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    isError: message.isError,
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

export function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (normalized instanceof ChatGptWebAdapterError) return normalized;
  // A completed broker retirement can cancel the out-of-process browser with
  // a generic AbortError. Preserve the authoritative, same-turn native-tool
  // failure rather than incorrectly reporting that ChatGPT stopped responding.
  // A missing retirement receipt or unrelated cancellation never qualifies.
  const retirement = session.runtime.mode === "tools"
    ? session.runtime.externalProgress.retirementCause() : undefined;
  if (retirement instanceof ChatGptWebAdapterError) return retirement;
  const phase = session.runtime.submission?.phase;
  if (!phase || phase === "prepared") return normalized;
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing."
      : "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: {
    broker?: TurnBrokerOwner;
    zeroRiskManualControl?: ChatGptZeroRiskManualControl;
    blockedOperationLedger?:BlockedOperationLedger;
  } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const zeroRiskManualControl = dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl;
  const blockedOperationLedger=dependencies.blockedOperationLedger??new BlockedOperationLedger();
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  // Passive recovery is separate from native 272K/258K compaction. Checkpoints
  // only replace already-completed assistant/tool transcripts on fresh Web tabs.
  const enhancedRecoveryCheckpointStore = new EnhancedRecoveryCheckpointStore();
  const inFlightRecoveryCheckpoints = new Set<string>();
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalSkillAttachments = provider.chatgptWeb?.experimentalSkillAttachments;
  if (experimentalSkillAttachments !== undefined && typeof experimentalSkillAttachments !== "boolean") {
    throw new Error("ChatGPT skill attachments preference must be a boolean");
  }
  if (experimentalSkillAttachments && provider.chatgptWeb?.browserInteractionMode === "manual") {
    throw new Error("Skills as files is unavailable in Zero Risk mode");
  }
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const freshConversationPerTurn = provider.chatgptWeb?.experimentalFreshConversationPerTurn === true;
  if (provider.chatgptWeb?.experimentalFreshConversationPerTurn !== undefined
    && typeof provider.chatgptWeb.experimentalFreshConversationPerTurn !== "boolean") {
    throw new Error("ChatGPT fresh conversation preference must be a boolean");
  }
  if (freshConversationPerTurn && manualInteraction) {
    throw new Error("Fresh browser conversations per turn is available only in automatic mode");
  }
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
      ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
      : undefined;
  if (manualInteraction) {
    if (!configuredCapabilities.localToolsEnabled) {
      throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
    }
    if (!retainedLauncherDescriptor) {
      throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
    }
  }
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !experimentalBiggerContext && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: {
      onCompactionProgress?: (
        kind: "generation" | "submitted" | "multipart_acknowledged",
        part?: number,
      ) => void;
    } = {},
  ): ChatGptTurnRuntime => {
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) {
      throw new Error(
        manualInteraction
          ? "ChatGPT Zero Risk requires the Zero Risk Web model route"
          : "The Zero Risk Web model route requires ChatGPT Zero Risk interaction mode",
      );
    }
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !experimentalBiggerContext
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const captureEnhancedRecoveryCheckpoint = !manualRequest
      && mode.localTools && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest && structuredBroker !== undefined
      && retainedLauncherDescriptor !== undefined;
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : captureEnhancedRecoveryCheckpoint
        ? enhancedRecoveryCheckpointStore.apply(parsed)
        : { parsed, applied: false };
    if (captureEnhancedRecoveryCheckpoint && checkpointInput.applied) {
      console.info("[chatgpt-web] passive_recovery_verified " + JSON.stringify({
        checkpointApplied: true,
        canonicalMessages: parsed.context.messages.length,
        fallbackMessages: checkpointInput.parsed.context.messages.length,
      }));
    } else if (captureEnhancedRecoveryCheckpoint && parsed.context.messages.length >= 24) {
      console.info("[chatgpt-web] passive_recovery_not_applied " + JSON.stringify({
        reason: checkpointInput.reason ?? "unknown",
        canonicalMessages: parsed.context.messages.length,
      }));
    }
    const conversationKey = !parsed._compactionRequest
      && !freshConversationPerTurn
      && (parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID || experimentalBiggerContext)
      && retainedLauncherDescriptor
      ? chatGptConversationKey(checkpointInput.parsed, executionNamespace)
      : undefined;
    const retainedProof = conversationKey
      ? retainedConversationProofs.check(conversationKey, parsed)
      : undefined;
    // A durable, verified checkpoint supports a fresh canonical Web bootstrap;
    // an older browser tab is no longer required even if its ancestry proof remains.
    const resumeInput = retainedResumeForCheckpoint(checkpointInput.applied, retainedProof);
    if (checkpointInput.applied && retainedProof?.reason === "verified") {
      console.info("[chatgpt-web] retained_checkpoint_bootstrap mode=fresh_verified_checkpoint");
    }
    if (conversationKey && retainedProof && retainedProof.reason !== "verified") {
      // Bounded provenance telemetry, never request bodies or private task data.
      // Distinguishes goal-turn history churn from expiry, model rebind or a
      // process restart when a full canonical bootstrap subsequently exceeds
      // the measured browser input budget.
      console.info(`[chatgpt-web] retained_delta_unavailable ${JSON.stringify({
        reason: retainedProof.reason,
        checkpointApplied: checkpointInput.applied,
        checkpointReason: checkpointInput.applied ? undefined : checkpointInput.reason,
        canonicalMessages: parsed.context.messages.length,
        contextMessages: checkpointInput.parsed.context.messages.length,
      })}`);
    }
    const retainConversation = conversationKey !== undefined;
    const releaseRetainedConversation = conversationKey && retainedLauncherDescriptor
      ? async () => {
        retainedConversationProofs.invalidate(conversationKey);
        await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
      }
      : undefined;
    const reviewOptions=()=>environment?{blockedOperationReview:readBlockedOperationReview(blockedOperationLedger,environment)}:{};
    const compileOptionsFor = (input: CodexParsedRequest) => {
      const review=reviewOptions();
      if (manualRequest) return {manualControl:true as const,appName:worker.appName,...review};
      const experimentalMultipartParts = experimentalBiggerContext
        ? resolveBiggerContextMultipartParts(input, turnCapabilities, experimentalSkillAttachments,review,worker.appName)
        : undefined;
      return {
        ...review,
        appName: worker.appName,
        captureLunaCheckpoint,
        experimentalSkillAttachments,
        contextArchive: input === checkpointInput.parsed && !manualRequest && !captureLunaCheckpoint,
        retainedHistoryProven: resumeInput !== undefined && input === resumeInput,
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
      };
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    const archiveReadAbort=new AbortController();
    let browserOwnerSettled = false;
    const trackBrowserOwner = (browser: Promise<string>): Promise<string> => browser.finally(() => {
      browserOwnerSettled = true;
      archiveReadAbort.abort(new DOMException('Browser owner settled','AbortError'));
    });
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const onGenerationProgress = (): void => {
      trace.recordProgress();
      hooks.onCompactionProgress?.("generation");
    };
    const observedCapabilityTokens = new Set<string>();
    const rotatingCapabilities = new Set<string>();
    const observeCapabilityRetirement = (
      turnToken: string,
      externalProgress: ChatGptExternalTurnProgress,
    ): void => {
      if (observedCapabilityTokens.has(turnToken)) return;
      observedCapabilityTokens.add(turnToken);
      void broker.waitForRetirement(turnToken).then(
        failure => {
          if (rotatingCapabilities.delete(turnToken)) return;
          const retirement = failure?.code === "safety_status_unknown_or_blocked"
            ? chatGptSafetyStatusUnknownOrBlockedError(failure.tool)
            : failure?.code === "codex_tool_timeout"
              ? chatGptToolTimeoutError(failure.tool, failure.timeoutMs)
              : new Error("Codex Native retired the turn binding before its tool work completed");
          externalProgress.retire(retirement);
          if (!browserOwnerSettled && !browserAbort.signal.aborted) browserAbort.abort(retirement);
        },
        error => {
          const failure = new Error("ChatGPT could not observe Codex Native turn retirement", {
            cause: error,
          });
          externalProgress.retire(failure);
          if (!browserAbort.signal.aborted) browserAbort.abort(failure);
        },
      );
    };
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    const steering=conversationKey&&!manualRequest&&!captureLunaCheckpoint?new LiveSteering(parsed,conversationKey):undefined;
    // A canonical compaction request is side-effect free and remains safe to rebuild after an
    // ambiguous browser send. Normal task prompts must never be replayed after Send activation.
    const submissionLifecycle = {
      ...(!parsed._compactionRequest ? {
        onSendActivated: () => { submission.phase = "send_activated" as const; },
      } : {}),
      onSubmitted: () => {
        if (!parsed._compactionRequest) submission.phase = "accepted";
        hooks.onCompactionProgress?.("submitted");
      },
    };
    const multipartProgressLifecycle = hooks.onCompactionProgress
      ? { onMultipartStageAcknowledged: (part: number) => hooks.onCompactionProgress?.("multipart_acknowledged", part) }
      : {};
    if (manualRequest) {
      if (!environment) throw new Error("ChatGPT Zero Risk requires a trusted Codex environment");
      if (!retainedLauncherDescriptor) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
      const token = deferred<string>();
      const externalProgress = new ChatGptExternalTurnProgress();
      const surfaceNonce = randomBytes(32).toString("base64url");
      const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
      let tokenSettled = false;
      let activeToken: string | undefined;
      let launcherStarted = false;
      let launcherEnded = false;
      const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
        if (!launcherStarted || launcherEnded) return;
        await zeroRiskManualControl.end(retainedLauncherDescriptor, {
          ...owner,
          status,
          ...(status === "completed" && retainConversation ? { retain: true } : {}),
        });
        launcherEnded = true;
      };
      const runManual = async (): Promise<string> => {
        try {
          activeToken = await broker.registerSafe(environment, surfaceNonce, undefined, traceId);
          observeCapabilityRetirement(activeToken, externalProgress);
          const compiled = compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            activeToken,
            compileOptionsFor(checkpointInput.parsed),
          );
          const resumeCompiled = resumeInput
            ? compileChatGptWebPrompt(
              resumeInput,
              turnCapabilities,
              activeToken,
              compileOptionsFor(resumeInput),
            )
            : undefined;
          for (const candidate of [compiled, resumeCompiled]) {
            if (!candidate) continue;
            if (candidate.multipart) {
              throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
                status: 409,
                errorType: "invalid_request_error",
                code: "manual_multipart_unsupported",
                retryable: false,
              });
            }
          }
          tokenSettled = true;
          token.resolve(activeToken);
          if (!parsed._compactionRequest) {
            trace.push({
              kind: "commentary",
              text: "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the plugin shown in the launcher and the model you want, send the prompt, then confirm it was sent in the launcher.",
            });
          }
          await zeroRiskManualControl.start(retainedLauncherDescriptor, {
            ...owner,
            prompt: compiled.text,
            ...(resumeCompiled ? { resumePrompt: resumeCompiled.text } : {}),
            ...(conversationKey ? { conversationKey } : {}),
            ...(parsed._compactionRequest ? { compaction: true as const } : {}),
          });
          launcherStarted = true;
          await zeroRiskManualControl.waitSent(retainedLauncherDescriptor, owner, {
            abortSignal: browserAbort.signal,
          });
          await broker.confirmSafeTurnSent(activeToken, surfaceNonce);
          submission.phase = "accepted";
          if (!parsed._compactionRequest) trace.push({
            kind: "commentary",
            text: "> **Waiting for ChatGPT**\n>\n> The prompt is marked `Sent`. Waiting for the selected ChatGPT plugin to connect.",
          });
          const terminalAbort = new AbortController();
          const abortTerminal = () => terminalAbort.abort();
          browserAbort.signal.addEventListener("abort", abortTerminal, { once: true });
          const terminalFailure = zeroRiskManualControl.waitTerminal(
            retainedLauncherDescriptor,
            owner,
            { abortSignal: terminalAbort.signal },
          ).then(observed => Promise.reject(safeManualTerminalError(observed.status)))
            .catch(error => terminalAbort.signal.aborted
              ? new Promise<never>(() => {})
              : Promise.reject(error));
          let answer: string;
          try {
            await Promise.race([
              broker.waitForSafeStart(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
            await zeroRiskManualControl.markStarted(retainedLauncherDescriptor, owner);
            if (!parsed._compactionRequest) trace.push({
              kind: "commentary",
              text: "> **Zero Risk connected**\n>\n> The Zero Risk plugin is connected. ChatGPT is now working through the native Codex harness; progress remains visible in the launcher.",
            });
            answer = await Promise.race([
              broker.waitForSafeCompletion(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
          } finally {
            terminalAbort.abort();
            browserAbort.signal.removeEventListener("abort", abortTerminal);
          }
          text.push(answer);
          try {
            await finishLauncher("completed");
          } catch (controlError) {
            // The broker result is already authoritative. A launcher acknowledgement failure may
            // leave UI cleanup pending, but it must not replace a completed Codex answer with an
            // error or trigger a contradictory failed terminal mutation.
            console.error(
              `[chatgpt-web] completed Zero Risk turn but could not confirm launcher cleanup: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          return answer;
        } catch (error) {
          const normalized = safeManualAdapterError(error);
          // Capture the causal state before our own cleanup revokes the broker capability. The
          // retirement observer also aborts browserAbort, but that self-induced abort must not turn
          // an ordinary launcher/runtime failure into a user cancellation.
          const externallyAborted = browserAbort.signal.aborted;
          if (activeToken) await Promise.resolve(broker.revoke(activeToken, normalized)).catch(() => {});
          try {
            await finishLauncher(externallyAborted ? "aborted" : "failed");
          } catch (controlError) {
            console.error(
              `[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          throw normalized;
        }
      };
      const browserTurn = cancellableBrowserTurn(trackBrowserOwner(runManual()), browserAbort);
      void browserTurn.browser.catch(error => {
        if (tokenSettled) return;
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      });
      return {
        mode: "tools",
        token: token.promise,
        externalProgress,
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        manualControl: { surfaceNonce },
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        retireCapability: async () => {
          if (activeToken) await broker.revoke(activeToken);
        },
        submission,
        cancel: (reason?: Error) => {
          browserTurn.cancel(reason);
          if (activeToken) {
            void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
              console.error(`[chatgpt-web] failed to revoke cancelled Zero Risk request: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      };
    }
    if (!mode.localTools) {
      const prepareWith = async (input: CodexParsedRequest) => ({
        ...compileChatGptWebPrompt(input, turnCapabilities, undefined, compileOptionsFor(input)),
        release: () => {},
      });
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
        capabilities: turnCapabilities,
        prepare: () => prepareWith(checkpointInput.parsed),
        ...(resumeInput ? {
          prepareResume: () => prepareWith(resumeInput),
          requireRetainedConversation: true,
        } : {}),
        ...(steering?{
          steering,
          prepareRecovery:async(request?:{steering?:boolean})=>{
            if(request?.steering){
              const reserved=steering.prepare(submission.phase==='accepted');
              if(!reserved)throw new Error('No canonical steering delta is pending');
              return {...await prepareWith(reserved.parsed),steeringDeltaId:reserved.deltaId};
            }
            return {text:createSameTabRecoveryDelta(),images:[],release:()=>{}};
          },
          onSteeringSubmitted:(id:string)=>steering.acknowledge(id),
          externalProgress:new ChatGptExternalTurnProgress(),
          completionFence:{begin:async(recovery?:boolean)=>recovery||!steering.hasQueued()?steering.snapshot().revision:undefined,
            commit:async(revision:number)=>!steering.hasQueued()&&steering.snapshot().revision===revision},
        }:{}),
        ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => { text.push(delta); onGenerationProgress(); },
        onGenerationProgress,
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: checkpointInput.parsed,
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        submission,
        ...(steering?{enqueueSteering:(incoming:CodexParsedRequest,signal?:AbortSignal)=>{
          signal?.throwIfAborted();return !browserOwnerSettled&&steering.admit(incoming);
        },activateSteering:()=>steering.activateDelivery()}:{}),
        cancel:(reason?:Error)=>{steering?.cancel();browserTurn.cancel(reason);},
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    const externalProgress = new ChatGptExternalTurnProgress();
    let tokenSettled = false;
    let activeToken: string | undefined;
    let archiveReadToken:string|undefined,archiveReadSha:string|undefined,archiveReadWatchStarted=false;
    const prepareWith = async (input: CodexParsedRequest) => {
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
      );
      activeToken = turnToken;
      try {
        const compiled = compileChatGptWebPrompt(
          input,
          turnCapabilities,
          turnToken,
          compileOptionsFor(input),
        );
        if(compiled.contextArchive){
          if(!broker.requireArchiveRead||!broker.waitForArchiveRead)throw new ChatGptWebAdapterError(
            'This native broker cannot verify archive ingestion in the task response.',
            {status:409,errorType:'server_error',code:'context_archive_ingestion_unavailable',retryable:false});
          if(archiveReadToken&&archiveReadSha!==compiled.contextArchive.sha256)
            throw new Error('The native capability was already bound to another historical archive');
          if(!archiveReadToken){
            chatGptSuspensionClock.start();
            const files=validateContextArchive(Buffer.from(compiled.contextArchive.base64,'base64'),compiled.contextArchive.sha256);
            const images=Object.keys(files).filter(path=>path.startsWith('images/')).length;
            const skills=Object.keys(files).filter(path=>path.startsWith('skills/')).length;
            try{await broker.requireArchiveRead(turnToken,createArchiveReadProof(Buffer.from(files['context.txt']!).toString('utf8'),images,skills));}
            catch(error){throw new ChatGptWebAdapterError('The running native broker cannot install this archive read-proof transaction. Rebuild the isolated DEV runtime before submitting it.',
              {status:409,errorType:'server_error',code:'context_archive_ingestion_unavailable',retryable:false,cause:error});}
            archiveReadToken=turnToken;archiveReadSha=compiled.contextArchive.sha256;
          }
        }
        // Publish only after preparation succeeds: otherwise its failure revokes the token
        // before the response observer uses it and masks the cause as an expired capability.
        observeCapabilityRetirement(turnToken, externalProgress);
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    const prepareRecovery = broker.rotateRecoveryCapability ? async (request?:{steering?:boolean}) => {
      if (!activeToken || browserAbort.signal.aborted) throw new Error('Recovery requires an active authorized turn');
      const previous = activeToken;
      const reservation=request?.steering?steering?.prepare(submission.phase==='accepted'):undefined;
      if(request?.steering&&!reservation)throw new Error('No canonical steering delta is pending');
      rotatingCapabilities.add(previous);
      try {
        activeToken = await broker.rotateRecoveryCapability!(previous);
        observeCapabilityRetirement(activeToken, externalProgress);
        const delta: CodexParsedRequest = reservation?.parsed??{ ...parsed, context: { ...parsed.context,
          systemPrompt: [], messages: [{ role: 'user', content: createSameTabRecoveryDelta(), timestamp: Date.now() }] } };
        return { ...compileChatGptWebPrompt(delta, turnCapabilities, activeToken, {contextArchive:false,retainedHistoryProven:true,...reviewOptions()}),
          ...(reservation?{steeringDeltaId:reservation.deltaId}:{}), release: () => {} };
      } catch (error) {
        if (activeToken === previous) rotatingCapabilities.delete(previous);
        throw error;
      }
    } : undefined;
    const browserTurn = cancellableBrowserTurn(trackBrowserOwner(finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      capabilities: turnCapabilities,
      prepare: () => prepareWith(checkpointInput.parsed),
      ...(resumeInput ? {
        prepareResume: () => prepareWith(resumeInput),
        requireRetainedConversation: true,
      } : {}),
      ...(prepareRecovery ? { prepareRecovery } : {}),
      ...(steering&&broker.pauseForSteering?{steering,onSteeringSubmitted:(id:string)=>steering.acknowledge(id)}:{}),
      ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      ...submissionLifecycle,
      onSubmitted:()=>{
        submissionLifecycle.onSubmitted();
        if(archiveReadToken&&!archiveReadWatchStarted){
          archiveReadWatchStarted=true;
          const current=archiveReadToken;
          void waitForArchiveReadBounded(signal=>broker.waitForArchiveRead!(current,signal),
            AbortSignal.any([browserAbort.signal,archiveReadAbort.signal]),
            ()=>Date.now()-chatGptSuspensionClock.suspendedMs()).then(()=>{
              console.info(`[chatgpt-web] context_archive_ingested trace=${traceId} proof=native_control`);onGenerationProgress();
            },error=>{
              if(!browserOwnerSettled&&!browserAbort.signal.aborted)browserAbort.abort(error);
            });
        }
      },
      ...multipartProgressLifecycle,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => { text.push(delta); onGenerationProgress(); },
      onGenerationProgress,
      externalProgress,
      completionFence: {
        begin: async recovery => recovery||!steering?.hasQueued()?broker.beginCompletionFence(await token.promise):undefined,
        commit: async revision => !steering?.hasQueued()&&await broker.commitCompletionFence(await token.promise, revision),
      },
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    }))), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      externalProgress,
      browser: browserTurn.browser,
      physicalSettlement: browserTurn.physicalSettlement,
      trace,
      text,
      usageInput: checkpointInput.parsed,
      ...(conversationKey ? { conversationKey } : {}),
      ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
      retireCapability: async () => {
        if (activeToken) await broker.revoke(activeToken);
      },
      submission,
      ...(steering&&broker.pauseForSteering?{enqueueSteering:async(incoming:CodexParsedRequest,signal?:AbortSignal)=>{
        signal?.throwIfAborted();
        if(browserOwnerSettled)return false;
        // Preparation may still be attaching the initial prompt. Retain that physical owner
        // until its original capability exists; the queue separately forbids a delta Send
        // before the original submission is positively acknowledged.
        const currentToken=activeToken??await withAbort(token.promise,signal);
        if(browserOwnerSettled||browserAbort.signal.aborted)return false;
        return steering.admitAfterGate(incoming,()=>broker.pauseForSteering!(currentToken),signal);
      },activateSteering:()=>steering.activateDelivery()}:{}),
      cancel: (reason?: Error) => {
        steering?.cancel();
        browserTurn.cancel(reason);
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const observerAbort = new AbortController();
      incoming = {
        ...incoming,
        abortSignal: incoming.abortSignal
          ? AbortSignal.any([incoming.abortSignal, observerAbort.signal])
          : observerAbort.signal,
      };
      const write = emit;
      emit = event => {
        if (observerAbort.signal.aborted) throw observerAbort.signal.reason;
        try { write(event); }
        catch (cause) {
          // The response writer is an observer, not the owner of browser execution. Its
          // failure must follow the existing disconnect path even before HTTP signals abort.
          const error = new ChatGptObserverDisconnected(cause);
          observerAbort.abort(error);
          throw error;
        }
      };
      const runChatGptWebTurn = async (): Promise<void> => {
        const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
        if (manualRequest !== manualInteraction) {
          emit({
            type: "error",
            message: manualInteraction
              ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
              : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
            status: 409,
            errorType: "invalid_request_error",
            code: "browser_interaction_mode_mismatch",
            retryable: false,
          });
          return;
        }
        const turnCapabilities = parsed._compactionRequest && !manualRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = manualRequest
          ? { localTools: true }
          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
        if (mode.localTools) {
          try {
            environment = environmentStore.resolve(parsed);
          } catch (error) {
            const identity = extractChatGptTurnIdentity(parsed);
            console.warn(
              `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
            );
            throw error;
          }
        }
        // A native compaction continuation can omit command declarations even when
        // the task still has a valid browser/turn owner. A missing command surface
        // must NOT abort the entire browser turn or prevent steering/finalization.
        // Native command admission remains enforced at the MCP dispatch boundary.
        if (mode.localTools && !manualRequest && !parsed._compactionRequest && environment
          && !nativeCommandSurface(environment.tools)) {
          const rawBody = parsed._rawBody;
          const raw = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
            ? rawBody as Record<string, unknown> : {};
          const input = Array.isArray(raw.input) ? raw.input : [];
          const additionalToolItems = input.filter(item =>
            item !== null && typeof item === "object" && !Array.isArray(item)
            && (item as { type?: unknown }).type === "additional_tools");
          console.warn("[chatgpt-web] native_command_surface_missing " + JSON.stringify({
            parsed_tools: environment.tools.length,
            raw_declared_tools: Array.isArray(raw.tools) ? raw.tools.length : null,
            additional_tool_items: additionalToolItems.length,
            additional_tool_count: additionalToolItems.reduce((count, item) => {
              const tools = (item as { tools?: unknown }).tools;
              return count + (Array.isArray(tools) ? tools.length : 0);
            }, 0),
            previous_response_id: typeof raw.previous_response_id === "string",
            replay_prefix_items: parsed._replayPrefixLen ?? 0,
          }));
        }
        if (parsed._compactionRequest) {
          // This preflight also protects callers that invoke the adapter without the HTTP route.
          // Missing provenance must never trigger source retirement or a fresh browser fallback.
          bindAcceptedCompactionSource(parsed);
          extractChatGptCompactionSourceRevision(parsed);
          const structuredCompactionRequired = (parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID || experimentalBiggerContext)
            && configuredCapabilities.localToolsEnabled;
          if (structuredCompactionRequired
            && (!retainedLauncherDescriptor || (!manualRequest && !structuredBroker))) {
            emit({
              type: "error",
              message: manualRequest
                ? "Zero Risk could not resume the active ChatGPT conversation for context handoff. Retry the task from the Launcher."
                : "ChatGPT could not resume the active conversation for context handoff. Retry the task.",
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_control_unavailable",
              retryable: false,
            });
            return;
          }
          if (structuredCompactionRequired) {
            const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
            const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
            const handoffTraceId = createHash("sha256")
              .update(`${compactionExecutionKey}:handoff`)
              .digest("hex")
              .slice(0, 12);
            const compactionTraceId = createHash("sha256")
              .update(compactionExecutionKey)
              .digest("hex")
              .slice(0, 12);
            const freshCompactionTraceId = `${handoffTraceId}_${freshConversationPerTurn ? "fresh" : "fallback"}`;
            const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
            let sharedSummary = existingStructuredCompactionRun(compactionExecutionKey);
            if (!sharedSummary) {
              sharedSummary = runStructuredCompactionOnce(
                compactionExecutionKey,
                {
                  ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                  traceIds: [
                    compactionTraceId,
                    handoffTraceId,
                    freshCompactionTraceId,
                  ],
                  ...(compactionNativeIdentity.threadId
                    ? { nativeThreadId: compactionNativeIdentity.threadId }
                    : {}),
                  ...(compactionNativeIdentity.turnId
                    ? { nativeTurnId: compactionNativeIdentity.turnId }
                    : {}),
                },
                async (operatorSignal, retainOwnershipUntil) => {
                  const handoffTimeoutMs = Math.min(
                    timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                    MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                  );
                  const handoffDeadline = new AbortController();
                  const handoffTimeoutError = new ChatGptWebAdapterError(
                    `ChatGPT compaction had no observed activity for ${handoffTimeoutMs}ms`,
                    {
                      status: 409,
                      errorType: "invalid_request_error",
                      code: "compaction_handoff_timeout",
                      retryable: false,
                    },
                  );
                  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
                  let handoffPhase = "source_settlement";
                  chatGptSuspensionClock.start();
                  const handoffStartedAt = performance.now();
                  let acknowledgedParts = 0;
                  const armHandoffDeadline = (
                    lastActivity: "phase_started" | "source_activity" | "generation" | "submitted" | "multipart_acknowledged" = "phase_started",
                    part?: number,
                  ): void => {
                    if (handoffDeadline.signal.aborted) return;
                    if (handoffTimer) clearTimeout(handoffTimer);
                    if (part !== undefined) acknowledgedParts = part;
                    const activityAt = performance.now();
                    const suspendedAtActivity = chatGptSuspensionClock.suspendedMs();
                    const fireOrRearm = () => {
                      const suspendedMs = chatGptSuspensionClock.suspendedMs() - suspendedAtActivity;
                      const idleMs = performance.now() - activityAt;
                      const remaining = remainingStageBudgetMs(handoffTimeoutMs, idleMs, suspendedMs);
                      if (remaining > 0) {
                        console.info(`[chatgpt-web] compaction_budget_renewed ${JSON.stringify({
                          traceId: compactionTraceId, phase: handoffPhase,
                          remainingMs: Math.round(remaining), suspendedMs: Math.round(suspendedMs),
                        })}`);
                        handoffTimer = setTimeout(fireOrRearm, remaining);
                        handoffTimer.unref?.();
                        return;
                      }
                      console.warn(`[chatgpt-web] compaction_timeout ${JSON.stringify({
                        traceId: compactionTraceId, phase: handoffPhase, timeoutMs: handoffTimeoutMs,
                        lastActivity, acknowledgedParts,
                        elapsedMs: Math.round(performance.now() - handoffStartedAt),
                        idleMs: Math.round(idleMs), suspendedMs: Math.round(suspendedMs),
                        awakeIdleMs: Math.round(idleMs - suspendedMs),
                      })}`);
                      handoffDeadline.abort(handoffTimeoutError);
                    };
                    handoffTimer = setTimeout(fireOrRearm, handoffTimeoutMs);
                    handoffTimer.unref?.();
                  };
                  armHandoffDeadline();
                  const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
                  const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
                  const runFreshCompaction = async (reason: string): Promise<string> => {
                    handoffPhase = "fresh_compaction";
                    if (freshConversationPerTurn) console.info("[chatgpt-web] compaction uses configured fresh conversation mode");
                    else console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
                    // Fresh compaction is a bounded phase. Each exact multipart acknowledgement
                    // and the final accepted compact prompt re-arms the five-minute liveness budget;
                    // transport time cannot consume the model-generation window.
                    armHandoffDeadline();
                    const fallbackRuntime = startRuntime(
                      parsed,
                      manualRequest ? environment : undefined,
                      freshCompactionTraceId,
                      turnCapabilities,
                      { onCompactionProgress: armHandoffDeadline },
                    );
                    retainOwnershipUntil(fallbackRuntime.physicalSettlement);
                    try {
                      const rawSummary = await withAbort(fallbackRuntime.browser, operationSignal);
                      await withAbort(fallbackRuntime.physicalSettlement, operationSignal);
                      return canonicalizeCompactionHandoff(parsed, rawSummary);
                    } catch (error) {
                      fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                      // The shared owner retains physical settlement independently of this error.
                      // Neither a timeout nor operator cancellation can open a competing trace.
                      throw error;
                    }
                  };
                  let source: ChatGptTurnSession | undefined;
                  let stopSourceProgress: (() => void) | undefined;
                  let preserveFinalResponse = false;
                  try {
                    if (freshConversationPerTurn) {
                      // Full native history is the compaction input. Release an unfinished
                      // browser/tool owner before rebuilding it, but keep a committed final
                      // replayable if it won the native compaction race.
                      const previous = chatGptTurnSessions.find(compactedSourceExecutionKey);
                      const settlement = previous?.settledOutcome()?.type === "final"
                        ? previous.physicalSettlement
                        : chatGptTurnSessions.retireAndWait(compactedSourceExecutionKey).then(() => {});
                      retainOwnershipUntil(settlement);
                      await withAbort(settlement, operationSignal);
                      return await runFreshCompaction("configured_fresh_conversation");
                    }
                    // The previous compaction may already have detached the retained head while
                    // its browser/helper is still unwinding. Do not inspect that old epoch or
                    // decide to open a fresh fallback until physical release has completed.
                    if (sourceConversationKey) {
                      await chatGptTurnSessions.waitForConversationRetirement(
                        sourceConversationKey,
                        operationSignal,
                      );
                    }
                    source = sourceConversationKey
                      ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
                      : undefined;
                    preserveFinalResponse = !source?.isActive()
                      && source?.settledOutcome()?.type === "final";
                    const retainedKey = source?.conversationKey();
                    if (!source || !retainedKey) {
                      return await runFreshCompaction("source_unavailable_before_handoff");
                    }
                    // Renew only for observed source activity, never an idle helper heartbeat.
                    stopSourceProgress = source.runtime.trace.observeProgress(() => armHandoffDeadline("source_activity"));
                    let rawSummary: string;
                    if (manualRequest && source.isActive() && source.runtime.mode === "tools") {
                      const zeroRiskSummary = await settleActiveZeroRiskCompactionSource(
                        parsed,
                        source,
                        broker,
                        operationSignal,
                      );
                      if (zeroRiskSummary === undefined) {
                        preserveFinalResponse = true;
                        rawSummary = await runFreshCompaction("zero_risk_source_had_no_compaction_boundary");
                      } else {
                        rawSummary = zeroRiskSummary;
                      }
                    } else if (manualRequest) {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await runFreshCompaction("zero_risk_source_already_completed");
                    } else if (source.isActive() && source.runtime.mode === "tools") {
                      const settlement = await settleActiveCompactionSource(
                        parsed,
                        source,
                        structuredBroker!,
                        operationSignal,
                      );
                      preserveFinalResponse = !settlement.compactionInstructionDelivered;
                      // The previous response has physically settled. Its waiting time must not
                      // consume the independent, bounded request for the retained checkpoint.
                      stopSourceProgress?.();
                      handoffPhase = "retained_checkpoint";
                      armHandoffDeadline();
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    } else {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      stopSourceProgress?.();
                      handoffPhase = "retained_checkpoint";
                      armHandoffDeadline();
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    }
                    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
                    await withAbort(
                      preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                      operationSignal,
                    );
                    return summary;
                  } catch (error) {
                    const retainedKey = source?.conversationKey();
                    if (!retainedKey) throw error;
                    let handoffError = error instanceof Error ? error : new Error(String(error));
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_handoff_timeout"
                      && source?.isActive()) {
                      // A bounded wait has expired, but that alone cannot establish quiescence:
                      // pending native tools/approvals and browser reasoning still belong to the
                      // previous turn. Preserve the owner and surface a typed unresolved blocker.
                      // Retiring here would cancel the user's ongoing work after the deadline.
                      retainOwnershipUntil(source.physicalSettlement);
                      throw new ChatGptWebAdapterError(
                        "The retained ChatGPT source is still active when compaction timed out; no replay or competing browser compaction was started.",
                        { status: 409, errorType: "invalid_request_error", code: "COMPACTION_SOURCE_STALLED", retryable: false },
                      );
                    }
                    try {
                      // Operator cancellation ends the logical compaction, but cancel-all must not
                      // acknowledge until the retained browser/helper owner has physically retired.
                      // Cleanup must obey the same bounded compaction deadline.
                      // The retirement journal still owns physical settlement in
                      // the background and blocks a competing reused tab, but the
                      // native Codex observer must never wait indefinitely here.
                      await withAbort(
                        preserveFinalResponse
                          ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                            retainedKey,
                            source!,
                            compactedSourceExecutionKey,
                          )
                          : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                        operationSignal,
                      );
                    } catch (retirementError) {
                      handoffError = new AggregateError(
                        [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                        "Structured compaction failed and its retained conversation could not be retired",
                      );
                    }
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_source_unavailable") {
                      return await runFreshCompaction("source_disappeared_before_handoff");
                    }
                    throw handoffError;
                  } finally {
                    stopSourceProgress?.();
                    if (handoffTimer) clearTimeout(handoffTimer);
                  }
                },
              );
            }
            emit({ type: "heartbeat" });
            let summary: string;
            try {
              summary = await withAbort(sharedSummary, incoming.abortSignal);
            } catch (error) {
              if (incoming.abortSignal?.aborted
                && error instanceof DOMException
                && error.name === "AbortError") {
                // The observer detached; the shared exact compaction round continues and remains
                // available to a canonical reconnect without a second browser submission.
                throw error;
              }
              const handoffError = error instanceof Error ? error : new Error(String(error));
              console.error("[chatgpt-web] structured context handoff failed:", handoffError);
              const upstreamError = handoffError instanceof ChatGptWebAdapterError ? handoffError : undefined;
              emit({
                type: "error",
                message: upstreamError?.message ?? `ChatGPT did not complete the context handoff: ${handoffError.message}`,
                status: upstreamError?.status ?? 409,
                errorType: upstreamError?.errorType ?? "invalid_request_error",
                code: upstreamError?.code ?? "compaction_handoff_failed",
                // Compaction retry remains an explicit operator decision even when its source
                // failure was retryable; preserve the cause without opening a new retry loop.
                retryable: false,
              });
              return;
            }
            console.info("[chatgpt-web] native_compaction_result_ready " + JSON.stringify({
              implementation: "bounded-retirement-v1",
              summaryCharacters: summary.length,
            }));
            emit({ type: "text_delta", text: summary, phase: "final_answer" });
            emitBrowserCompletion(
              { type: "final", answer: summary },
              estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments, provider.chatgptWeb?.appName),
              emit,
            );
            console.info("[chatgpt-web] native_compaction_result_emitted");
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }
          const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
          const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
          if (sourceConversationKey && chatGptTurnSessions.findConversationHead(sourceConversationKey)) {
            await withAbort(chatGptTurnSessions.retireConversationAndWait(sourceConversationKey), incoming.abortSignal);
          } else {
            await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
          }
        }
        const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const ownerKey = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const nativeTurnId = nativeIdentity.turnId;
        if (!nativeTurnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser ownership");
        const abortedTurnIds = manualRequest ? new Set(priorChatGptAbortedTurnIds(parsed)) : undefined;
        if (abortedTurnIds?.size) {
          chatGptTurnSessions.retireAbortedOwnerTurns(ownerKey, abortedTurnIds, executionKey);
        }
        const traceId = chatGptWebTraceId(provider, parsed);
        const session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
          executionKey,
          ownerKey,
          () => startRuntime(parsed, environment, traceId, turnCapabilities),
          traceId,
          incoming.abortSignal,
          nativeTurnId,
          nativeIdentity.threadId,
          chatGptInstructionLineage(parsed),
          parsed,
        );
        const roundKey = chatGptTurnRoundKey(parsed);
        if(!session.roundCompleted(roundKey)){
          const observerSignal=session.observerSignal(executionKey);
          incoming={...incoming,abortSignal:incoming.abortSignal?AbortSignal.any([incoming.abortSignal,observerSignal]):observerSignal};
        }
        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {
          // Journal the complete synchronous event batch before touching the HTTP observer. If the
          // observer disconnects midway through emission, an exact reconnect can replay the entire
          // canonical batch instead of losing the already-drained tail.
          session.appendRoundEvents(roundKey, events);
          for (const event of events) emit(event);
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events);
        };
        const emitRoundEvent = (event: AdapterEvent): void => emitRoundEvents([event]);
        let awaitingRuntime = false;
        try {
          await session.runExclusive(async () => {
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            if (settled) {
              if (settled.type === "error") throw settled.error;
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drain();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                if (replay.length === 0 && !parsed._compactionRequest) {
                  emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
                }
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
                if (!bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas(completedTextDeltas, buffer));
                }
              }
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (session.runtime.conversationKey) retainedConversationProofs.commit(session.runtime.conversationKey, parsed, settled.answer);
              if (bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
              }
              const missingTail = pendingJournaledFinalAnswerSuffix(session.roundEvents(roundKey), settled.answer);
              if (missingTail) {
                // A drained feed is not a durable Responses delta. Journal this exact
                // suffix before the terminal event; no second browser Send is permitted.
                console.warn(`[chatgpt-web] final_answer_journal_tail trace=${traceId} chars=${missingTail.length}`);
                emitRoundBatch(buffer => emitTextDeltas([missingTail], buffer));
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments, provider.chatgptWeb?.appName),
                buffer,
              ));
              session.completeRound(roundKey);
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            let turnToken: string | undefined;
            if (session.runtime.mode === "tools") {
              turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
              await broker.updateEnvironment(turnToken, environment);

              const outstanding = session.outstanding();
              if (outstanding.length > 0) {
                const results = currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments, provider.chatgptWeb?.appName),
                    buffer,
                  ));
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                // Capture a cumulative recovery summary while the existing Web
                // response and its tool context are still authoritative. A tool
                // result is the only safe passive checkpoint boundary; /goal may
                // otherwise finish with >71K canonical tokens and no rebootstrap.
                const checkpointOwner = session.runtime.conversationKey;
                const checkpointEligible = !parsed._compactionRequest && !manualRequest
                  && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
                  && structuredBroker !== undefined && retainedLauncherDescriptor !== undefined
                  && checkpointOwner !== undefined;
                const checkpointAdmission = checkpointEligible
                  ? enhancedRecoveryCheckpointStore.checkpointAdmission(
                    parsed, ENHANCED_RECOVERY_CHECKPOINT_INTERVAL_TOKENS)
                  : undefined;
                const checkpointNeeded = checkpointEligible
                  && !inFlightRecoveryCheckpoints.has(checkpointOwner!)
                  && checkpointAdmission?.due === true;
                if (checkpointAdmission
                  && parsed.context.messages.length >= 24
                  && (checkpointAdmission.due || checkpointAdmission.reason === "no_complete_tool_boundary")) {
                  console.info("[chatgpt-web] passive_recovery_admission " + JSON.stringify({
                    reason: checkpointAdmission.reason,
                    deltaTokens: checkpointAdmission.deltaTokens,
                    canonicalTokens: checkpointAdmission.canonicalTokens,
                    checkpointAlreadyPresent: checkpointAdmission.prefixLength > 0,
                    inFlight: inFlightRecoveryCheckpoints.has(checkpointOwner!),
                    canonicalMessageCount: parsed.context.messages.length,
                  }));
                }
                let checkpoint: Awaited<ReturnType<TurnBroker["beginRecoveryCheckpoint"]>> | undefined;
                if (checkpointNeeded && structuredBroker) {
                  // Never stop work solely because passive recovery is unavailable.
                  try {
                    checkpoint = await structuredBroker.beginRecoveryCheckpoint(
                      traceId, 5 * 60_000,
                      summary => enhancedRecoveryCheckpointStore.commit(parsed, summary));
                    inFlightRecoveryCheckpoints.add(checkpointOwner!);
                  } catch (error) {
                    console.warn("[chatgpt-web] passive_recovery_unavailable " + JSON.stringify({
                      reason: error instanceof Error ? error.name : "unknown",
                    }));
                  }
                }
                try {
                  for (const [resultIndex, message] of results.entries()) {
                    const nativeResult=chatGptWebBrokerResult(message);
                    // Attach the one-shot recovery instruction after the last
                    // canonical tool result in the batch. No native tool is rerun.
                    const toolResult=checkpoint && resultIndex === results.length - 1
                      ? {...nativeResult,content:[...nativeResult.content,{
                          type:"text",text:passiveRecoveryCheckpointInstruction(checkpoint),
                        }]} : nativeResult;
                    await broker.completeTool(turnToken, message.toolCallId, toolResult);
                    session.runtime.externalProgress.recordToolResult();
                    session.runtime.trace.recordProgress();
                    session.markResultDelivered(message.toolCallId);
                  }
                } catch (error) {
                  if (checkpoint && structuredBroker) {
                    structuredBroker.abortCompactionTransaction(checkpoint.token);
                    inFlightRecoveryCheckpoints.delete(checkpointOwner!);
                  }
                  throw error;
                }
                if (checkpoint && structuredBroker) {
                  const ticket=checkpoint;
                  const owner=checkpointOwner!;
                  void structuredBroker.waitForCompactionHandoff(ticket.token).then(
                    () => console.info("[chatgpt-web] passive_recovery_durable " + JSON.stringify({
                      implementation: "archive-checkpoint-v2",
                      intervalTokens: ENHANCED_RECOVERY_CHECKPOINT_INTERVAL_TOKENS,
                    })),
                    error => console.warn("[chatgpt-web] passive_recovery_not_durable " + JSON.stringify({
                      reason: error instanceof Error ? error.name : "unknown",
                    })),
                  ).finally(() => inFlightRecoveryCheckpoints.delete(owner));
                }
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            session.runtime.activateSteering?.();
            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              const emitNewText = (deltas: string[]) => {
                if (!bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas(deltas, buffer));
              };
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              const externalProgress = session.runtime.mode === "tools"
                ? session.runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    const revision = externalProgress.recordToolBatch(requests.length);
                    session.runtime.trace.recordProgress();
                    if (!session.runtime.manualControl) {
                      // The browser outcome is in the same race below and owns the semantic DOM and
                      // renderer deadlines. A second fixed timer here can retire an accepted turn
                      // while its same-tab observer is still recovering. Keep the causal barrier —
                      // tools are not emitted until the browser captures their text boundary — but
                      // let browser settlement or request cancellation end the wait.
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        toolWaitAbort.signal,
                      );
                    }
                    externalProgress.assertToolBatchActive(revision);
                  }
                  return { type: "tools" as const, requests };
                }).catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error))
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              const finishBrowserOutcome = async (completedOutcome: ChatGptBrowserOutcome): Promise<void> => {
                // Zero Risk completion and its owner-only empty-batch signal are resolved by the
                // same broker transition. Drain once more so the accepted final answer cannot be
                // overtaken by the terminal owner notification.
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                // Web completion is not native Responses completion. A remote
                // broker owner may acknowledge retirement late or never close
                // its transport; never leave a partially streamed Codex answer
                // in Working indefinitely. Failure is terminal, not replayable.
                console.info(`[chatgpt-web] finalization trace=${traceId} stage=broker_retirement_started`);
                if (turnToken) {
                  await withAbort(awaitFinalBrokerRetirement(
                    () => broker.revoke(turnToken), 20_000), incoming.abortSignal);
                }
                console.info(`[chatgpt-web] finalization trace=${traceId} stage=broker_retirement_acknowledged`);
                if (completedOutcome.type === "error") throw completedOutcome.error;
                if (session.runtime.text.value() !== completedOutcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                structuredOutputValidator?.(completedOutcome.answer);
                if (session.runtime.conversationKey) retainedConversationProofs.commit(session.runtime.conversationKey, parsed, completedOutcome.answer);
                if (bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas([completedOutcome.answer], buffer));
                }
                const missingTail = pendingJournaledFinalAnswerSuffix(
                  session.roundEvents(roundKey), completedOutcome.answer,
                );
                if (missingTail) {
                  // Preserve an accepted final line that was drained by the helper
                  // but not yet journaled as final_answer on this HTTP round.
                  console.warn(`[chatgpt-web] final_answer_journal_tail trace=${traceId} chars=${missingTail.length}`);
                  emitRoundBatch(buffer => emitTextDeltas([missingTail], buffer));
                }
                // setFinalEvents clones the array. A pre-retirement snapshot omits
                // any late accepted final-answer suffix journaled above. Refresh it
                // before terminal so a reconnect replays the *complete* final text.
                session.setFinalEvents(session.roundEvents(roundKey));
                console.info(`[chatgpt-web] finalization trace=${traceId} stage=final_answer_journal_verified chars=${completedOutcome.answer.length}`);
                emitRoundBatch(buffer => emitBrowserCompletion(
                  completedOutcome,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments, provider.chatgptWeb?.appName),
                  buffer,
                ));
                console.info(`[chatgpt-web] finalization trace=${traceId} stage=adapter_done_journaled`);
                session.completeRound(roundKey);
                chatGptWebTurnRetryPolicy.clear(retryKey);
              };
              const waitForTrace = () => session.runtime.trace.wait(toolWaitAbort.signal)
                .then(() => ({ type: "trace" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              const waitForText = () => session.runtime.text.wait(toolWaitAbort.signal)
                .then(() => ({ type: "text" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              let nextTrace = waitForTrace();
              let nextText = waitForText();
              for (;;) {
                awaitingRuntime = true;
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    nextTrace,
                    nextText,
                  ]),
                  incoming.abortSignal,
                );
                awaitingRuntime = false;
                if (next.type === "trace") {
                  emitNewTrace(session.runtime.trace.drain());
                  nextTrace = waitForTrace();
                  continue;
                }
                if (next.type === "text") {
                  emitNewText(session.runtime.text.drain());
                  nextText = waitForText();
                  continue;
                }
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                if (next.type === "browser") {
                  await finishBrowserOutcome(next.outcome);
                  return;
                }
                if (!turnToken || session.runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) {
                  if (!session.runtime.manualControl) {
                    throw new Error("ChatGPT tool bridge returned an empty batch");
                  }
                  await finishBrowserOutcome(await session.browserOutcome);
                  return;
                }
                validateBatchTools(parsed, next.requests);
                session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments, provider.chatgptWeb?.appName),
                  buffer,
                ));
                session.completeRound(roundKey);
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
          });
        } catch (error) {
          if (incoming.abortSignal?.aborted && error === incoming.abortSignal.reason
            && error instanceof ChatGptSteeringObserverSuperseded) {
            // Steering transfers only observation. A terminal old-observer receipt must not
            // cancel or revoke the physical browser/capability now owned by the newer revision.
            emitRoundEvent({type:'error',message:error.message,status:error.status,errorType:error.errorType,
              code:error.code,retryable:false});
            session.completeRound(roundKey);chatGptWebTurnRetryPolicy.clear(retryKey);return;
          }
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            if (session.runtime.manualControl) {
              // Zero Risk is user-driven and has no DOM observer that can distinguish continued
              // work from a stopped native turn. A closed Responses stream is therefore terminal:
              // revoke the MCP capability and release the Launcher tab instead of leaving a task
              // that Codex already shows as stopped waiting forever.
              chatGptTurnSessions.retire(executionKey, session);
            }
            // Automatic browser turns keep their exact execution and journal for reconnect. Their
            // owned DOM observer can continue proving the same accepted ChatGPT submission.
            throw error;
          }
          // Browser failure can retire tools before their next wait starts. Once that exact
          // browser has failed, its cause takes precedence over the cleanup's token error.
          // Validation and result-delivery failures never enter this branch.
          const settled = awaitingRuntime ? session.settledOutcome() : undefined;
          if (settled?.type === "error") error = settled.error;
          const turnError = submittedTurnFailure(session, error);
          const autoCompactTransportFailure = turnError instanceof ChatGptWebAdapterError
            && (turnError.code === "browser_prompt_too_long"
              || turnError.code === "message_length_exceeds_limit");
          const handledError = turnError instanceof ChatGptWebAdapterError
            && turnError.retryable
            && !autoCompactTransportFailure
            ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError)
            : turnError;
          if (autoCompactTransportFailure
            || !(turnError instanceof ChatGptWebAdapterError && turnError.retryable)) {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          if (handledError instanceof ChatGptWebAdapterError
            && !handledError.retryable
            && !autoCompactTransportFailure) {
            // A deterministic request failure remains replayable so a native reconnect cannot burn
            // another browser attempt. Prompt-size failures are different: the server owns their
            // one-shot compact+retry recovery and therefore needs a fresh browser session.
            session.cancel();
          } else {
            chatGptTurnSessions.retire(executionKey, session);
          }
          if (session.runtime.mode === "tools") {
            void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
          }
          if (handledError instanceof ChatGptWebAdapterError) {
            emitRoundEvent({
              type: "error",
              message: handledError.message,
              status: handledError.status,
              errorType: handledError.errorType,
              code: handledError.code,
              retryable: handledError.retryable,
            });
            session.completeRound(roundKey);
            return;
          }
          session.failRound(roundKey, turnError);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        }
      };

      // Arm this before any awaited work, including environment lookup and owner retirement.
      const heartbeat = setInterval(
        () => {
          try { emit({ type: "heartbeat" }); }
          catch { /* emit detached the observer and wakes its pending awaits. */ }
        },
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      try {
        emit({ type: "heartbeat" });
        await runChatGptWebTurn();
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
