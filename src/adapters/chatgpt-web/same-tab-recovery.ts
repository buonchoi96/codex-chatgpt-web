export const STOP_CONFIRMATION_DEADLINE_MS = 30_000;
export type SameTabRecoveryState = 'ACTIVE' | 'RECONCILE' | 'COMPLETED' | 'WAITING_TOOL' | 'WAITING_APPROVAL' | 'STOP_REQUESTED' | 'STOP_CONFIRMED' | 'RESUME_PREPARED' | 'RESUME_SUBMITTED' | 'RESUMED' | 'UNKNOWN_STOP_OR_SEND' | 'FALLBACK_ELIGIBLE' | 'FALLBACK_SUBMITTED' | 'USER_ACTION_REQUIRED' | 'USER_CANCELLED' | 'REVISION_QUEUED';
export type RecoveryOutcome = 'completed' | 'resumed' | 'waiting' | 'queued' | 'unsafe' | 'fallback' | 'cancelled';
export type RecoveryFallbackReason = 'stop_activation_failed' | 'stop_confirmation_timeout';
export interface RecoveryObservation {
  owned: boolean; revision: number; activeTools: number; approvalPending: boolean; safetyBlocked: boolean;
  sendAcknowledged: boolean; generationActive: boolean; composerReady: boolean; historyStable: boolean;
  verifiedStall: boolean; completed?: boolean;
}
export interface RecoveryFallbackProof {
  oldGenerationStopped: boolean; toolReceiptsSettled: boolean; sendAcknowledged: boolean;
  ownershipMatched: boolean; revisionUnchanged: boolean; approvalPending: boolean; safetyBlocked: boolean;
  completed?: boolean;
}
export interface SameTabRecoveryActions {
  observe(signal?: AbortSignal): Promise<RecoveryObservation>;
  stop(signal?: AbortSignal): Promise<void>;
  submit(): Promise<'accepted' | 'unknown' | 'completed'>;
  reconcileFallback?(): Promise<RecoveryFallbackProof>;
  fallback?(): Promise<'accepted' | 'unknown' | 'completed'>;
}

/** Serial mutation of one owned response. Eligibility never proves a second generation is safe. */
export class SameTabRecovery {
  state: SameTabRecoveryState = 'ACTIVE';
  fallbackReason?: RecoveryFallbackReason;
  stopRequestedAt?: number;
  stopConfirmedAt?: number;
  private attempts = 0;
  private busy = false;
  private cancelled = false;
  private stopController?: AbortController;
  constructor(private readonly changed: (state: SameTabRecoveryState) => void = () => {},
    private readonly now: () => number = () => performance.now(),
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly scheduleTimeout: (callback: () => void, ms: number) => () => void = (callback, ms) => {
      const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
    }) {}
  private transition(state: SameTabRecoveryState): void { this.state = state; this.changed(state); }
  cancel(): void { this.cancelled = true; this.stopController?.abort(); this.transition('USER_CANCELLED'); }
  private guard(observed: RecoveryObservation, revision: number): RecoveryOutcome | undefined {
    if (this.cancelled) return 'cancelled';
    if (observed.safetyBlocked || !observed.owned || !observed.historyStable) { this.transition('USER_ACTION_REQUIRED'); return 'unsafe'; }
    if (observed.approvalPending) { this.transition('WAITING_APPROVAL'); return 'waiting'; }
    if (observed.activeTools > 0) { this.transition('WAITING_TOOL'); return 'waiting'; }
    if (!observed.sendAcknowledged) { this.transition('UNKNOWN_STOP_OR_SEND'); return 'unsafe'; }
    if (observed.revision !== revision) { this.transition('REVISION_QUEUED'); return 'queued'; }
  }
  private async eligibleFallback(actions: SameTabRecoveryActions, reason: RecoveryFallbackReason): Promise<RecoveryOutcome> {
    if (this.cancelled) return 'cancelled';
    this.fallbackReason = reason; this.transition('FALLBACK_ELIGIBLE');
    if (!actions.reconcileFallback || !actions.fallback) return 'unsafe';
    const proof = await actions.reconcileFallback();
    if (this.cancelled) return 'cancelled';
    if (!proof.oldGenerationStopped || !proof.toolReceiptsSettled || !proof.sendAcknowledged ||
        !proof.ownershipMatched || !proof.revisionUnchanged || proof.approvalPending || proof.safetyBlocked) return 'unsafe';
    if (proof.completed) { this.transition('COMPLETED'); return 'completed'; }
    this.transition('FALLBACK_SUBMITTED');
    const sent = await actions.fallback();
    if (sent === 'completed') { this.transition('COMPLETED'); return 'completed'; }
    if (sent !== 'accepted') { this.transition('UNKNOWN_STOP_OR_SEND'); return 'unsafe'; }
    // Cancellation remains sticky for subsequent recovery attempts, but a
    // confirmed Send receipt cannot be reclassified as an unsent cancellation.
    if (this.cancelled) this.transition('FALLBACK_SUBMITTED');
    return 'fallback';
  }
  async recover(actions: SameTabRecoveryActions): Promise<RecoveryOutcome> {
    if (this.cancelled) return 'cancelled';
    if (this.busy) return 'waiting';
    if (this.state === 'COMPLETED') return 'completed';
    if (['UNKNOWN_STOP_OR_SEND', 'USER_ACTION_REQUIRED', 'FALLBACK_ELIGIBLE', 'FALLBACK_SUBMITTED'].includes(this.state)) return 'unsafe';
    if (this.attempts >= 2) { this.transition('USER_ACTION_REQUIRED'); return 'unsafe'; }
    this.busy = true;
    let mutationStarted = false;
    try {
      this.transition('RECONCILE');
      let observed = await actions.observe();
      const revision = observed.revision;
      let refused = this.guard(observed, revision);
      if (refused) return refused;
      if (observed.completed) { this.transition('COMPLETED'); return 'completed'; }
      if (!observed.verifiedStall) { this.transition('ACTIVE'); return 'waiting'; }
      if (observed.generationActive) {
        observed = await actions.observe(); refused = this.guard(observed, revision); if (refused) return refused;
        if (observed.completed) { this.transition('COMPLETED'); return 'completed'; }
        // The first stall receipt can become obsolete while ownership and
        // native progress are rechecked. A recovered generation must never be
        // stopped using that stale decision.
        if (!observed.verifiedStall) { this.transition('ACTIVE'); return 'waiting'; }
        // The second snapshot can also prove that the generation ended on its
        // own. Only a still-active generation requires a Stop side effect.
        if (observed.generationActive) {
          this.attempts++;
          this.transition('STOP_REQUESTED'); mutationStarted = true;
          this.stopRequestedAt = this.now();
          const deadline = this.stopRequestedAt + STOP_CONFIRMATION_DEADLINE_MS;
          const controller = new AbortController(); this.stopController = controller;
          let clearDeadline = () => {};
          const checkDeadline = () => {
            const remaining = deadline - this.now();
            if (remaining <= 0) controller.abort();
            else clearDeadline = this.scheduleTimeout(checkDeadline, remaining);
          };
          // A wall timer can fire immediately after system sleep. Recheck the injected awake
          // clock before revoking Stop authority, including when the Stop RPC itself is stuck.
          clearDeadline = this.scheduleTimeout(checkDeadline, STOP_CONFIRMATION_DEADLINE_MS);
          const bounded = <T>(pending: Promise<T>) => new Promise<T>((resolve, reject) => {
            const aborted = () => reject(new Error('Stop confirmation deadline or cancellation'));
            controller.signal.addEventListener('abort', aborted, { once: true });
            pending.then(value => { controller.signal.removeEventListener('abort', aborted); resolve(value); }, error => {
              controller.signal.removeEventListener('abort', aborted); reject(error);
            });
            if (controller.signal.aborted) aborted();
          });
          try {
            try { await bounded(actions.stop(controller.signal)); }
            catch {
              if (this.cancelled) return 'cancelled';
              return await this.eligibleFallback(actions, controller.signal.aborted || this.now() >= deadline ? 'stop_confirmation_timeout' : 'stop_activation_failed');
            }
            for (;;) {
              if (this.cancelled) return 'cancelled';
              if (controller.signal.aborted || this.now() >= deadline) return await this.eligibleFallback(actions, 'stop_confirmation_timeout');
              try { observed = await bounded(actions.observe(controller.signal)); }
              catch (error) {
                if (this.cancelled) return 'cancelled';
                if (controller.signal.aborted || this.now() >= deadline) return await this.eligibleFallback(actions, 'stop_confirmation_timeout');
                throw error;
              }
              refused = this.guard(observed, revision); if (refused) return refused;
              if (observed.completed) { this.transition('COMPLETED'); return 'completed'; }
              if (this.now() < deadline && !observed.generationActive && observed.composerReady) break;
              await this.wait(Math.min(250, Math.max(0, deadline - this.now())));
            }
          } finally { clearDeadline(); this.stopController = undefined; }
        }
      }
      if (observed.generationActive || !observed.composerReady) { this.transition('UNKNOWN_STOP_OR_SEND'); return 'unsafe'; }
      if (mutationStarted) { this.stopConfirmedAt = this.now(); this.transition('STOP_CONFIRMED'); }
      else this.stopConfirmedAt = undefined;
      this.transition('RESUME_PREPARED');
      observed = await actions.observe(); refused = this.guard(observed, revision); if (refused) return refused;
      if (observed.completed) { this.transition('COMPLETED'); return 'completed'; }
      if (observed.generationActive || !observed.composerReady) { this.transition('UNKNOWN_STOP_OR_SEND'); return 'unsafe'; }
      // With no Stop side effect, a stale initial stall must not authorize
      // Send after the last native/DOM recheck proves frontend progress.
      // A confirmed Stop may clear the error banner, so do not require the
      // watchdog to remain expired after a real Stop mutation.
      if (!mutationStarted && !observed.verifiedStall) { this.transition('ACTIVE'); return 'waiting'; }
      if (!mutationStarted) this.attempts++;
      this.transition('RESUME_SUBMITTED'); mutationStarted = true;
      const sent = await actions.submit();
      if (sent === 'completed') { this.transition('COMPLETED'); return 'completed'; }
      if (sent !== 'accepted') { this.transition('UNKNOWN_STOP_OR_SEND'); return 'unsafe'; }
      // Once accepted, the Send already happened even if cancellation raced
      // the acknowledgement. Keep the cancellation flag to prohibit replay.
      this.transition('RESUMED'); return 'resumed';
    } catch (error) {
      if (this.cancelled) return 'cancelled';
      this.transition(mutationStarted ? 'UNKNOWN_STOP_OR_SEND' : 'USER_ACTION_REQUIRED'); throw error;
    } finally { this.busy = false; }
  }
}
