export const CHATGPT_FRONTEND_ERROR_STALL_MS = 60_000;
export const CHATGPT_SOFT_RECOVERY_STALL_MS = 180_000;
export type WatchedChatGptError = 'red' | 'interrupted';

export interface RecoveryWatchdogObservation {
  errorKind: WatchedChatGptError | null;
  visibleText: string;
  traceBlocks: readonly { kind: string; text: string }[];
  nativeLastProgressAt?: number;
  nativeRevision?: number;
  nativeToolCallsInFlight: boolean;
  approvalPending: boolean;
}

/** The caller supplies monotonic awake time. Banner presence starts classification,
 * not permission to Stop; recovery independently verifies ownership and receipts. */
export class ChatGptRecoveryWatchdog {
  private kind: WatchedChatGptError | null = null;
  private previousAt?: number;
  private signature?: string;
  private nativeProgress?: string;
  private suspended = false;
  private elapsed = 0;
  private startedAt?: number;
  private lastSemanticAt?: number;

  update(observed: RecoveryWatchdogObservation, now: number) {
    if (!Number.isFinite(now)) throw new Error('Recovery watchdog requires finite awake time');
    const changedKind = this.kind !== observed.errorKind;
    if (changedKind || this.previousAt === undefined || now < this.previousAt || !observed.errorKind) {
      this.kind = observed.errorKind;
      this.elapsed = 0;
      this.startedAt = observed.errorKind ? now : undefined;
      this.lastSemanticAt = undefined;
      this.signature = undefined;
      this.nativeProgress = undefined;
      this.suspended = false;
      this.previousAt = now;
    }
    const busy = observed.nativeToolCallsInFlight || observed.approvalPending;
    if (!busy && !this.suspended && observed.errorKind) this.elapsed += now - this.previousAt!;
    this.previousAt = now;
    this.suspended = busy;
    const signature = JSON.stringify([observed.visibleText, observed.traceBlocks
      .filter(block => block.kind === 'reasoning' || block.kind === 'commentary')
      .map(block => [block.kind, block.text])]);
    const nativeProgress = JSON.stringify([observed.nativeRevision, observed.nativeLastProgressAt]);
    if (this.signature !== signature || this.nativeProgress !== nativeProgress) {
      this.elapsed = 0;
      this.lastSemanticAt = observed.errorKind ? now : undefined;
    }
    this.signature = signature;
    this.nativeProgress = nativeProgress;
    const limit = observed.errorKind === 'red' ? CHATGPT_FRONTEND_ERROR_STALL_MS : CHATGPT_SOFT_RECOVERY_STALL_MS;
    return { errorKind: this.kind, watchdogStart: this.startedAt, lastSemanticProgress: this.lastSemanticAt,
      elapsedAwakeMs: this.elapsed, suspended: busy, expired: Boolean(observed.errorKind && !busy && this.elapsed >= limit) };
  }
}

/** Recheck a stalled response using fresh DOM/native evidence immediately before Stop.
 * A previously expired watchdog is not a permanent Stop authorization. Steering
 * is separately authorized by its still-pending canonical user revision. */
export function freshRecoveryStall(watchdog: ChatGptRecoveryWatchdog,
  observation: RecoveryWatchdogObservation, awakeNow: number, steeringPending: boolean): boolean {
  const current = watchdog.update(observation, awakeNow);
  return steeringPending || current.expired;
}
