export interface ChatGptExternalTurnProgressSnapshot {
  revision: number;
  lastToolBatchRevision: number;
  activeToolCalls: number;
  activeNativeProcesses?: number;
  activeSubagents?: number;
  backgroundActivityUnverified?: boolean;
  lastProgressAt?: number;
  /** The active browser response has been superseded by native context compaction. */
  compactionRequested?: boolean;
}

interface ProgressWaiter {
  afterRevision: number;
  resolve: (snapshot: ChatGptExternalTurnProgressSnapshot) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ToolBatchObservationWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * The read surface the browser worker depends on.
 *
 * The worker never records activity; it observes the daemon's progress and acknowledges only the
 * pre-dispatch answer boundary it captured. Declaring the dependency as this interface lets the
 * launcher helper process mirror the same causal contract without owning the recording side.
 */
export interface ChatGptTurnProgressReader {
  snapshot(): ChatGptExternalTurnProgressSnapshot;
  waitForChange(afterRevision: number, signal?: AbortSignal): Promise<ChatGptExternalTurnProgressSnapshot>;
  /** Confirm that the browser captured its answer projection before this batch was dispatched. */
  acknowledgeToolBatch(revision: number): Promise<void>;
}

/**
 * Carries only proven Codex MCP activity into the browser worker.
 *
 * It is deliberately not a completion channel: browser-visible text and terminal state remain
 * owned by the ChatGPT DOM. A valid current-turn tool request only proves that submission was
 * accepted and that the model is still making progress while its DOM is temporarily unavailable.
 */
abstract class ChatGptTurnProgressBroadcaster implements ChatGptTurnProgressReader {
  private readonly waiters = new Set<ProgressWaiter>();

  abstract snapshot(): ChatGptExternalTurnProgressSnapshot;
  abstract acknowledgeToolBatch(revision: number): Promise<void>;

  waitForChange(afterRevision: number, signal?: AbortSignal): Promise<ChatGptExternalTurnProgressSnapshot> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new Error("ChatGPT external progress revision must be a non-negative safe integer");
    }
    const current = this.snapshot();
    if (current.revision > afterRevision) return Promise.resolve(current);
    if (signal?.aborted) {
      return Promise.reject(new DOMException("ChatGPT external progress wait aborted", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const waiter: ProgressWaiter = { afterRevision, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          reject(new DOMException("ChatGPT external progress wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  protected notify(snapshot: ChatGptExternalTurnProgressSnapshot): void {
    for (const waiter of [...this.waiters]) {
      if (snapshot.revision <= waiter.afterRevision) continue;
      this.waiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(snapshot);
    }
  }
}

export class ChatGptExternalTurnProgress extends ChatGptTurnProgressBroadcaster {
  private readonly nativeProcesses = new Set<number>();
  private readonly scopedProcesses = new Set<string>();
  private readonly subagents = new Set<string>();
  private backgroundActivityUnverified = false;
  private revision = 0;
  private lastToolBatchRevision = 0;
  private observedToolBatchRevision = 0;
  private activeToolCalls = 0;
  private lastProgressAt?: number;
  private compactionRequested = false;
  private retirementError?: Error;
  private readonly toolBatchObservationWaiters = new Set<ToolBatchObservationWaiter>();

  snapshot(): ChatGptExternalTurnProgressSnapshot {
    return {
      revision: this.revision,
      lastToolBatchRevision: this.lastToolBatchRevision,
      activeToolCalls: this.activeToolCalls,
      ...(this.nativeProcesses.size + this.scopedProcesses.size ? { activeNativeProcesses: this.nativeProcesses.size + this.scopedProcesses.size } : {}),
      ...(this.subagents.size ? { activeSubagents: this.subagents.size } : {}),
      ...(this.backgroundActivityUnverified ? { backgroundActivityUnverified: true } : {}),
      ...(this.lastProgressAt !== undefined ? { lastProgressAt: this.lastProgressAt } : {}),
      ...(this.compactionRequested ? { compactionRequested: true } : {}),
    };
  }

  /** Only typed native envelopes may reconcile work; command stdout is never a receipt. */
  recordBackgroundResult(name: string, args: Record<string, unknown> = {}, result: unknown, isError = false): void {
    const tool = name.replace(/^(?:functions|tools)__/, "");
    if (isError) {
      if (tool === "exec" || tool === "exec_command" || tool === "multi_agent_v1__spawn_agent"
        || /node_repl|cua_repl|(?:^|__)swift_process_start$/.test(tool)) this.backgroundActivityUnverified = true;
      return;
    }
    if (tool === "exec" || /node_repl|cua_repl/.test(tool)) {
      this.backgroundActivityUnverified = true;
      return;
    }
    const process = tool === "exec_command" || tool === "write_stdin";
    const scoped = /(?:^|__)swift_process_(?:start|poll|cancel)$/.test(tool);
    const spawn = tool === "multi_agent_v1__spawn_agent";
    const wait = tool === "multi_agent_v1__wait_agent";
    const close = tool === "multi_agent_v1__close_agent";
    if (!process && !scoped && !spawn && !wait && !close) return;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      this.backgroundActivityUnverified = true;
      return;
    }
    const receipt = result as Record<string, unknown>;
    if (scoped) {
      if (typeof receipt.process !== "string") this.backgroundActivityUnverified = true;
      else if (receipt.status === "running") this.scopedProcesses.add(receipt.process);
      else if (["completed", "cancelled", "timeout", "user_aborted", "output_limit"].includes(receipt.status as string)) this.scopedProcesses.delete(receipt.process);
      else this.backgroundActivityUnverified = true;
    }
    if (process) {
      if (Number.isSafeInteger(receipt.session_id) && (receipt.session_id as number) >= 0) {
        this.nativeProcesses.add(receipt.session_id as number);
      } else if (tool === "write_stdin" && Number.isSafeInteger(args.session_id) && Number.isSafeInteger(receipt.exit_code)) {
        this.nativeProcesses.delete(args.session_id as number);
      } else if (!Number.isSafeInteger(receipt.exit_code)) this.backgroundActivityUnverified = true;
    }
    if (spawn) {
      if (typeof receipt.agent_id === "string") this.subagents.add(receipt.agent_id);
      else this.backgroundActivityUnverified = true;
    }
    if (wait && receipt.status && typeof receipt.status === "object" && !Array.isArray(receipt.status)) {
      for (const [id, status] of Object.entries(receipt.status)) {
        if (["shutdown", "not_found"].includes(status as string)
          || status && typeof status === "object" && ("completed" in status || "errored" in status)) this.subagents.delete(id);
      }
    }
    if (wait && (!receipt.status || typeof receipt.status !== "object" || Array.isArray(receipt.status))) this.backgroundActivityUnverified = true;
    if (close && typeof args.target === "string") {
      const status = receipt.previous_status;
      if (["shutdown", "not_found"].includes(status as string)
        || status && typeof status === "object" && ("completed" in status || "errored" in status)) this.subagents.delete(args.target);
    }
  }

  recordToolBatch(count: number, now = Date.now()): number {
    this.assertNotRetired();
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("ChatGPT external progress requires a non-empty tool batch");
    }
    this.activeToolCalls += count;
    this.advance(now, "tool_batch");
    return this.lastToolBatchRevision;
  }

  async acknowledgeToolBatch(revision: number): Promise<void> {
    this.assertToolBatchRevision(revision);
    this.assertNotRetired();
    if (revision <= this.observedToolBatchRevision) return;
    this.observedToolBatchRevision = revision;
    for (const waiter of [...this.toolBatchObservationWaiters]) {
      if (waiter.revision > revision) continue;
      this.toolBatchObservationWaiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }

  waitForToolBatchObservation(revision: number, signal?: AbortSignal): Promise<void> {
    this.assertToolBatchRevision(revision);
    if (this.retirementError) return Promise.reject(this.retirementError);
    if (this.observedToolBatchRevision >= revision) return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(new DOMException("ChatGPT tool-boundary observation aborted", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const waiter: ToolBatchObservationWaiter = { revision, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.toolBatchObservationWaiters.delete(waiter);
          reject(new DOMException("ChatGPT tool-boundary observation aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.toolBatchObservationWaiters.add(waiter);
    });
  }

  recordToolResult(now = Date.now()): void {
    this.assertNotRetired();
    if (this.activeToolCalls <= 0) {
      throw new Error("ChatGPT external progress received a tool result without an active call");
    }
    this.activeToolCalls -= 1;
    this.advance(now, "tool_result");
  }

  /**
   * Mark the current browser response as superseded by native context compaction.
   *
   * This advances only the transport revision so the launcher helper receives the state change;
   * it deliberately does not stamp lastProgressAt because compaction is not model/tool progress.
   */
  markCompactionRequested(): boolean {
    this.assertNotRetired();
    if (this.compactionRequested) return false;
    this.compactionRequested = true;
    this.revision += 1;
    this.notify(this.snapshot());
    return true;
  }

  /** Retire every unresolved batch when the broker capability can no longer accept its result. */
  retire(error: Error): boolean {
    if (!(error instanceof Error)) throw new Error("ChatGPT external progress retirement requires an error");
    if (this.retirementError) return false;
    this.retirementError = error;
    for (const waiter of this.toolBatchObservationWaiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    this.toolBatchObservationWaiters.clear();
    if (this.activeToolCalls === 0) return true;
    this.activeToolCalls = 0;
    // Retirement is not fresh model progress. Advance the transport revision so the browser mirror
    // drops its completion veto, while preserving the timestamp of the last proven MCP activity.
    this.revision += 1;
    this.notify(this.snapshot());
    return true;
  }

  assertToolBatchActive(revision: number): void {
    this.assertToolBatchRevision(revision);
    this.assertNotRetired();
  }

  private advance(now: number, event: "tool_batch" | "tool_result"): void {
    if (!Number.isFinite(now)) throw new Error("ChatGPT external progress timestamp must be finite");
    this.revision += 1;
    if (event === "tool_batch") this.lastToolBatchRevision = this.revision;
    this.lastProgressAt = now;
    this.notify(this.snapshot());
  }

  private assertToolBatchRevision(revision: number): void {
    if (!Number.isSafeInteger(revision)
      || revision <= 0
      || revision > this.lastToolBatchRevision) {
      throw new Error("ChatGPT tool-boundary acknowledgement has an invalid batch revision");
    }
  }

  private assertNotRetired(): void {
    if (this.retirementError) throw this.retirementError;
  }
}

/**
 * Replays daemon-recorded progress inside the launcher browser helper process.
 *
 * The browser worker runs out of process from the Codex MCP broker, so the recording instance
 * cannot be shared with it. Without a mirror the worker observes no progress at all and its
 * liveness guards silently degrade to "never live", which lets a turn be cancelled while its tool
 * calls are still completing.
 */
export class ChatGptMirroredTurnProgress extends ChatGptTurnProgressBroadcaster {
  private current: ChatGptExternalTurnProgressSnapshot = {
    revision: 0,
    lastToolBatchRevision: 0,
    activeToolCalls: 0,
  };
  private observedToolBatchRevision = 0;

  constructor(
    private readonly onToolBatchObserved?: (revision: number) => Promise<void> | void,
  ) {
    super();
  }

  snapshot(): ChatGptExternalTurnProgressSnapshot {
    return { ...this.current };
  }

  async acknowledgeToolBatch(revision: number): Promise<void> {
    if (!Number.isSafeInteger(revision)
      || revision <= 0
      || revision > this.current.lastToolBatchRevision) {
      throw new Error("ChatGPT mirrored tool-boundary acknowledgement has an invalid batch revision");
    }
    if (revision <= this.observedToolBatchRevision) return;
    await this.onToolBatchObserved?.(revision);
    this.observedToolBatchRevision = revision;
  }

  /** Ignores stale or replayed frames so out-of-order delivery cannot rewind observed liveness. */
  apply(next: ChatGptExternalTurnProgressSnapshot): boolean {
    assertChatGptTurnProgressSnapshot(next);
    if (next.revision <= this.current.revision) return false;
    // A frame that advances the revision must not contradict what it already reported: the
    // recorder only ever moves these forward, so a regression means a corrupt or forged frame
    // rather than an ordering artefact, and accepting it would desynchronise observed liveness.
    if (next.lastToolBatchRevision < this.current.lastToolBatchRevision
      || (this.current.compactionRequested === true && next.compactionRequested !== true)
      || (next.lastProgressAt === undefined && this.current.lastProgressAt !== undefined)
      || (next.lastProgressAt !== undefined
        && this.current.lastProgressAt !== undefined
        && next.lastProgressAt < this.current.lastProgressAt)) {
      throw new Error("ChatGPT external progress snapshot regressed against the observed state");
    }
    this.current = { ...next };
    this.notify(this.snapshot());
    return true;
  }
}

export function assertChatGptTurnProgressSnapshot(
  value: ChatGptExternalTurnProgressSnapshot,
): void {
  const finiteIndex = (candidate: number): boolean => Number.isSafeInteger(candidate) && candidate >= 0;
  if (!value
    || !finiteIndex(value.revision)
    || !finiteIndex(value.lastToolBatchRevision)
    || !finiteIndex(value.activeToolCalls)
    || (value.activeNativeProcesses !== undefined && !finiteIndex(value.activeNativeProcesses))
    || (value.activeSubagents !== undefined && !finiteIndex(value.activeSubagents))
    || (value.backgroundActivityUnverified !== undefined && typeof value.backgroundActivityUnverified !== "boolean")
    || value.lastToolBatchRevision > value.revision
    || (value.lastProgressAt !== undefined && !Number.isFinite(value.lastProgressAt))
    || (value.compactionRequested !== undefined && typeof value.compactionRequested !== "boolean")
    // Any recorded activity stamps a timestamp. The sole exception is a compaction supersession
    // revision, which is a control-state transition rather than model/tool progress.
    || (value.revision > 0 && value.lastProgressAt === undefined && value.compactionRequested !== true)) {
    throw new Error("ChatGPT external progress snapshot is invalid");
  }
}

export function chatGptExternalProgressIsLive(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
  graceMs: number,
): boolean {
  if (!snapshot) return false;
  if (!Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error("ChatGPT external progress liveness inputs are invalid");
  }
  return chatGptExternalWorkBlocksRecovery(snapshot)
    || (snapshot.lastProgressAt !== undefined && now - snapshot.lastProgressAt < graceMs);
}

/** Only unresolved native tool calls veto browser-turn completion. */
export function chatGptExternalToolCallsAreInFlight(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
): boolean {
  return (snapshot?.activeToolCalls ?? 0) > 0;
}

export function chatGptExternalWorkBlocksRecovery(snapshot: ChatGptExternalTurnProgressSnapshot | undefined): boolean {
  return (snapshot?.activeToolCalls ?? 0) > 0 || (snapshot?.activeNativeProcesses ?? 0) > 0
    || (snapshot?.activeSubagents ?? 0) > 0 || snapshot?.backgroundActivityUnverified === true;
}
