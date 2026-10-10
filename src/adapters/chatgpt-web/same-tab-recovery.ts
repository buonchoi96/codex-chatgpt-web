export type SameTabRecoveryState = "ACTIVE" | "STALL_SUSPECTED" | "STALL_VERIFIED" | "STOP_REQUESTED"
  | "STOP_CONFIRMED" | "RESUME_PREPARED" | "RESUME_SUBMITTED" | "RESUMED" | "COMPLETED"
  | "WAITING_FOR_TOOL" | "WAITING_FOR_APPROVAL" | "RECOVERY_UNSAFE" | "USER_ACTION_REQUIRED" | "FALLBACK_REQUIRED";
export interface RecoveryObservation {
  owned: boolean;
  revision: number;
  activeTools: number;
  approvalPending: boolean;
  safetyBlocked: boolean;
  stopVisible: boolean;
  composerReady: boolean;
}

/** Called only after the progress-aware watchdog verifies a stall, never on elapsed time alone. */
export class SameTabRecovery {
  state: SameTabRecoveryState = "ACTIVE";
  private attempts = 0;
  constructor(private readonly changed: (state: SameTabRecoveryState) => void = () => {}) {}
  private transition(state: SameTabRecoveryState): void { this.state = state; this.changed(state); }
  private safe(observed: RecoveryObservation, revision = observed.revision): boolean {
    if (observed.safetyBlocked) { this.transition("USER_ACTION_REQUIRED"); return false; }
    if (!observed.owned) { this.transition("FALLBACK_REQUIRED"); return false; }
    if (observed.approvalPending) { this.transition("WAITING_FOR_APPROVAL"); return false; }
    if (observed.activeTools > 0 || observed.revision !== revision) { this.transition("WAITING_FOR_TOOL"); return false; }
    return true;
  }
  async recover(actions: {
    observe(): Promise<RecoveryObservation>;
    stop(): Promise<void>;
    submit(): Promise<void>;
  }): Promise<boolean> {
    if (["RECOVERY_UNSAFE", "USER_ACTION_REQUIRED", "FALLBACK_REQUIRED", "COMPLETED"].includes(this.state)) return false;
    if (this.attempts >= 2) { this.transition("USER_ACTION_REQUIRED"); return false; }
    this.transition("STALL_SUSPECTED");
    const observed = await actions.observe();
    if (!this.safe(observed)) return false;
    this.transition("STALL_VERIFIED");
    this.attempts++;
    try {
      if (observed.stopVisible) {
        // Recheck claims/receipts after asynchronous UI inspection, immediately before Stop.
        if (!this.safe(await actions.observe(), observed.revision)) return false;
        this.transition("STOP_REQUESTED");
        await actions.stop();
      }
      const stopped = await actions.observe();
      if (!this.safe(stopped, observed.revision)) return false;
      if (stopped.stopVisible || !stopped.composerReady) { this.transition("RECOVERY_UNSAFE"); return false; }
      this.transition("STOP_CONFIRMED");
      this.transition("RESUME_PREPARED");
      if (!this.safe(await actions.observe(), observed.revision)) return false;
      this.transition("RESUME_SUBMITTED");
      await actions.submit();
      this.transition("RESUMED");
      return true;
    } catch (error) {
      // An accepted Send or Stop with a lost acknowledgement is never repeated here.
      this.transition("RECOVERY_UNSAFE");
      throw error;
    }
  }
  complete(): void { this.transition("COMPLETED"); }
}
