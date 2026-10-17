import { createHash, randomUUID } from "node:crypto";

const maxPendingRevisions = 64;
const maxTrackedRevisions = 256;
const maxPendingBytes = 64 * 1024;

/** Supplied only from the existing canonical-history proof path; this class never creates proof. */
export interface CanonicalLineage {
  verification: "proven";
  conversationId: string;
  epoch: number;
  canonicalRevisionId: string;
  canonicalPrefixHash: string;
  proofId: string;
}

export interface SteeringRevisionInput {
  sourceRevisionId: string;
  predecessorRevisionId: string;
  lineage: CanonicalLineage;
  /** Only the newly arrived user instruction delta; never a canonical-history transcript. */
  delta: string;
}

export interface ReceiptBoundary {
  epoch: number;
  generation: "idle" | "active";
  sendReceipt:
    | { status: "none" }
    | { status: "pending"; deltaId: string }
    | { status: "unknown"; deltaId: string }
    | { status: "positive"; deltaId: string };
  activeTool: "none" | "active";
  approval: "none" | "pending";
  compaction: "none" | "pending" | "complete";
  rebind: "current" | "required";
  stop: "none" | "requested" | "confirmed" | "user_cancelled";
}

export interface DeltaReservation {
  deltaId: string;
  /** Reused on reconciliation; it is never regenerated for an uncertain Send. */
  idempotencyKey: string;
  epoch: number;
  lineage: CanonicalLineage;
  revisionIds: readonly number[];
  sourceRevisionIds: readonly string[];
  /** Ordered newly supplied deltas only. */
  text: string;
}

export interface CanonicalAckRecord {
  revisionId: number;
  sourceRevisionId: string;
  deltaId: string;
  epoch: number;
  canonicalPrefixHash: string;
  proofId: string;
}

export type BoundaryHoldReason =
  | "before_send_ack"
  | "unknown_send"
  | "active_tool"
  | "approval_pending"
  | "generation_active"
  | "stop_pending"
  | "compaction_pending"
  | "epoch_rebind_required"
  | "receipt_mismatch"
  | "send_reserved";

type Held = { status: "held"; reason: BoundaryHoldReason | "integrity_blocked" };
type Cancelled = { status: "cancelled" };
type Rejected = { status: "rejected"; reason: string };
export type ReserveResult =
  | { status: "reserved"; delta: DeltaReservation }
  | { status: "idle" }
  | Held | Cancelled | Rejected;
export type BeginSendResult = { status: "send_once"; delta: DeltaReservation } | Held | Cancelled | Rejected;
export type ResolveSendResult =
  | { status: "accepted"; deltaId: string; revisionIds: readonly number[] }
  | { status: "retryable_not_sent"; deltaId: string; revisionIds: readonly number[] }
  | Held | Cancelled | Rejected;
export type RebindResult = { status: "rebound"; epoch: number } | Held | Cancelled | Rejected;

export type EnqueueResult =
  | { status: "queued" | "duplicate"; revisionId: number }
  | { status: "held"; reason: "epoch_rebind_required" }
  | { status: "blocked"; reason: string }
  | { status: "cancelled" };

export type SendReceipt =
  | { kind: "positive"; deltaId: string; revisionIds: readonly number[]; lineage: CanonicalLineage }
  | { kind: "not_sent"; deltaId: string }
  | { kind: "unknown"; deltaId: string };

interface TrackedRevision {
  revisionId: number;
  sourceRevisionId: string;
  predecessorRevisionId: string;
  fingerprint: string;
  delta?: string;
  byteLength: number;
}

interface ActiveReservation {
  delta: DeltaReservation;
  state: "reserved" | "started" | "unknown";
}

function validLineage(value: CanonicalLineage): boolean {
  return Boolean(value) && typeof value === "object" && value.verification === "proven" &&
    typeof value.conversationId === "string" && value.conversationId.length > 0 &&
    Number.isSafeInteger(value.epoch) && value.epoch >= 0 && typeof value.canonicalRevisionId === "string" &&
    value.canonicalRevisionId.length > 0 && typeof value.canonicalPrefixHash === "string" && value.canonicalPrefixHash.length > 0 &&
    typeof value.proofId === "string" && value.proofId.length > 0;
}

function copyLineage(value: CanonicalLineage): CanonicalLineage {
  return Object.freeze({ ...value });
}

function revisionFingerprint(value: SteeringRevisionInput): string {
  return createHash("sha256").update(JSON.stringify([
    value.sourceRevisionId,
    value.predecessorRevisionId,
    value.lineage.verification,
    value.lineage.conversationId,
    value.lineage.epoch,
    value.lineage.canonicalRevisionId,
    value.lineage.canonicalPrefixHash,
    value.lineage.proofId,
    value.delta,
  ])).digest("hex");
}

function sameAckRecord(left: CanonicalAckRecord, right: CanonicalAckRecord): boolean {
  return left.revisionId === right.revisionId && left.sourceRevisionId === right.sourceRevisionId &&
    left.deltaId === right.deltaId && left.epoch === right.epoch &&
    left.canonicalPrefixHash === right.canonicalPrefixHash && left.proofId === right.proofId;
}

/** Ordered, receipt-gated in-memory queue. It cannot send, approve, stop, or create lineage proof. */
export class SteeringRevisionQueue {
  private lineage: CanonicalLineage;
  private latestSourceRevisionId: string;
  private nextRevisionId = 1;
  private readonly bySourceRevision = new Map<string, TrackedRevision>();
  private readonly byRevisionId = new Map<number, TrackedRevision>();
  private readonly pendingRevisionIds: number[] = [];
  private pendingBytes = 0;
  private readonly ackRecords: CanonicalAckRecord[] = [];
  private active?: ActiveReservation;
  private lastAcknowledgedDeltaId?: string;
  private rebindRequired = false;
  private integrityBlocked = false;
  private cancelled = false;

  constructor(initialLineage: CanonicalLineage) {
    if (!validLineage(initialLineage)) throw new TypeError("A proven canonical lineage is required");
    this.lineage = copyLineage(initialLineage);
    this.latestSourceRevisionId = initialLineage.canonicalRevisionId;
  }

  enqueueRevision(input: SteeringRevisionInput): EnqueueResult {
    if (this.cancelled) return { status: "cancelled" };
    if (this.integrityBlocked) return { status: "blocked", reason: "integrity_blocked" };
    if (typeof input.sourceRevisionId !== "string" || !input.sourceRevisionId ||
        typeof input.predecessorRevisionId !== "string" || !input.predecessorRevisionId ||
        typeof input.delta !== "string" || !input.delta.trim() || !validLineage(input.lineage)) {
      this.integrityBlocked = true;
      return { status: "blocked", reason: "invalid_revision" };
    }

    const fingerprint = revisionFingerprint(input);
    const existing = this.bySourceRevision.get(input.sourceRevisionId);
    if (existing) {
      if (existing.fingerprint === fingerprint) return { status: "duplicate", revisionId: existing.revisionId };
      this.integrityBlocked = true;
      return { status: "blocked", reason: "revision_conflict" };
    }

    if (this.rebindRequired || input.lineage.epoch !== this.lineage.epoch) {
      return { status: "held", reason: "epoch_rebind_required" };
    }
    if (input.lineage.conversationId !== this.lineage.conversationId ||
        input.lineage.canonicalRevisionId !== this.lineage.canonicalRevisionId ||
        input.lineage.canonicalPrefixHash !== this.lineage.canonicalPrefixHash ||
        input.lineage.proofId !== this.lineage.proofId) {
      this.integrityBlocked = true;
      return { status: "blocked", reason: "lineage_mismatch" };
    }
    if (input.predecessorRevisionId !== this.latestSourceRevisionId) {
      this.integrityBlocked = true;
      return { status: "blocked", reason: "predecessor_mismatch" };
    }

    const byteLength = new TextEncoder().encode(input.delta).byteLength;
    if (this.bySourceRevision.size >= maxTrackedRevisions || this.pendingRevisionIds.length >= maxPendingRevisions ||
        this.pendingBytes + byteLength > maxPendingBytes) {
      this.integrityBlocked = true;
      return { status: "blocked", reason: "queue_capacity_exceeded" };
    }

    const tracked: TrackedRevision = {
      revisionId: this.nextRevisionId++,
      sourceRevisionId: input.sourceRevisionId,
      predecessorRevisionId: input.predecessorRevisionId,
      fingerprint,
      delta: input.delta,
      byteLength,
    };
    this.bySourceRevision.set(input.sourceRevisionId, tracked);
    this.byRevisionId.set(tracked.revisionId, tracked);
    this.pendingRevisionIds.push(tracked.revisionId);
    this.pendingBytes += byteLength;
    this.latestSourceRevisionId = input.sourceRevisionId;
    return { status: "queued", revisionId: tracked.revisionId };
  }

  reserve(boundary: ReceiptBoundary): ReserveResult {
    const hold = this.checkBoundary(boundary);
    if (hold === "cancelled") return { status: "cancelled" };
    if (hold) return { status: "held", reason: hold };
    if (this.integrityBlocked) return { status: "held", reason: "integrity_blocked" };
    if (this.active) {
      if (this.active.state !== "reserved")
        return { status: "held", reason: this.active.state === "unknown" ? "unknown_send" : "before_send_ack" };
      return { status: "reserved", delta: this.active.delta };
    }
    if (this.pendingRevisionIds.length === 0) return { status: "idle" };

    const revisions = this.pendingRevisionIds.map(id => this.byRevisionId.get(id)!);
    const deltaId = `steering-${randomUUID()}`;
    const delta: DeltaReservation = Object.freeze({
      deltaId,
      idempotencyKey: deltaId,
      epoch: this.lineage.epoch,
      lineage: copyLineage(this.lineage),
      revisionIds: Object.freeze(revisions.map(item => item.revisionId)),
      sourceRevisionIds: Object.freeze(revisions.map(item => item.sourceRevisionId)),
      text: revisions.map(item => item.delta!).join("\n\n"),
    });
    this.active = { delta, state: "reserved" };
    return { status: "reserved", delta };
  }

  beginSend(deltaId: string, boundary: ReceiptBoundary): BeginSendResult {
    if (this.cancelled) return { status: "cancelled" };
    if (!this.active || this.active.delta.deltaId !== deltaId)
      return { status: "rejected", reason: "reservation_mismatch" };
    if (this.active.state === "unknown") return { status: "held", reason: "unknown_send" };
    if (this.active.state === "started") return { status: "held", reason: "unknown_send" };
    const hold = this.checkBoundary(boundary);
    if (hold === "cancelled") return { status: "cancelled" };
    if (hold) return { status: "held", reason: hold };
    if (this.integrityBlocked) return { status: "held", reason: "integrity_blocked" };
    this.active.state = "started";
    return { status: "send_once", delta: this.active.delta };
  }

  resolveSend(receipt: SendReceipt): ResolveSendResult {
    if (this.cancelled) return { status: "cancelled" };
    if (!this.active || this.active.delta.deltaId !== receipt.deltaId)
      return { status: "rejected", reason: "reservation_mismatch" };
    if (receipt.kind === "unknown") {
      this.active.state = "unknown";
      return { status: "held", reason: "unknown_send" };
    }
    if (receipt.kind === "not_sent") {
      if (this.active.state !== "started" && this.active.state !== "unknown")
        return { status: "rejected", reason: "send_was_not_started" };
      this.active.state = "reserved";
      return { status: "retryable_not_sent", deltaId: receipt.deltaId, revisionIds: this.active.delta.revisionIds };
    }
    if (this.active.state !== "started" && this.active.state !== "unknown")
      return this.blockInvalidReceipt("send_was_not_started");
    const expectedIds = this.active.delta.revisionIds;
    if (receipt.revisionIds.length !== expectedIds.length ||
        receipt.revisionIds.some((id, index) => id !== expectedIds[index]) ||
        !validLineage(receipt.lineage) || receipt.lineage.conversationId !== this.lineage.conversationId ||
        receipt.lineage.epoch !== this.active.delta.epoch ||
        receipt.lineage.canonicalRevisionId !== this.active.delta.sourceRevisionIds.at(-1)) {
      return this.blockInvalidReceipt("positive_receipt_does_not_match_reservation");
    }
    if (this.pendingRevisionIds.slice(0, expectedIds.length).some((id, index) => id !== expectedIds[index]))
      return this.blockInvalidReceipt("reserved_revisions_are_not_queue_head");

    const delta = this.active.delta;
    const acceptedLineage = copyLineage(receipt.lineage);
    const ackRecords = delta.revisionIds.map(revisionId => {
      const tracked = this.byRevisionId.get(revisionId)!;
      return Object.freeze({
        revisionId,
        sourceRevisionId: tracked.sourceRevisionId,
        deltaId: delta.deltaId,
        epoch: delta.epoch,
        canonicalPrefixHash: acceptedLineage.canonicalPrefixHash,
        proofId: acceptedLineage.proofId,
      });
    });
    this.ackRecords.push(...ackRecords);
    for (const revisionId of expectedIds) {
      const index = this.pendingRevisionIds.indexOf(revisionId);
      this.pendingRevisionIds.splice(index, 1);
      const tracked = this.byRevisionId.get(revisionId)!;
      this.pendingBytes -= tracked.byteLength;
      tracked.delta = undefined;
    }
    this.lineage = acceptedLineage;
    this.lastAcknowledgedDeltaId = delta.deltaId;
    this.active = undefined;
    return { status: "accepted", deltaId: delta.deltaId, revisionIds: delta.revisionIds };
  }

  rebindEpoch(input: {
    lineage: CanonicalLineage;
    acknowledgedRecords: readonly CanonicalAckRecord[];
    boundary: ReceiptBoundary;
  }): RebindResult {
    if (this.cancelled) return { status: "cancelled" };
    if (input.boundary.stop === "user_cancelled") {
      this.cancel();
      return { status: "cancelled" };
    }
    if (input.boundary.activeTool === "active") return { status: "held", reason: "active_tool" };
    if (input.boundary.approval === "pending") return { status: "held", reason: "approval_pending" };
    if (input.boundary.generation === "active") return { status: "held", reason: "generation_active" };
    if (input.boundary.stop === "requested") return { status: "held", reason: "stop_pending" };
    if (input.boundary.sendReceipt.status === "pending") return { status: "held", reason: "before_send_ack" };
    if (input.boundary.sendReceipt.status === "unknown") return { status: "held", reason: "unknown_send" };
    if (input.boundary.sendReceipt.status === "positive" &&
        input.boundary.sendReceipt.deltaId !== this.lastAcknowledgedDeltaId)
      return { status: "held", reason: "receipt_mismatch" };
    if (input.boundary.compaction === "pending") return { status: "held", reason: "compaction_pending" };
    if (input.boundary.compaction !== "complete") return { status: "rejected", reason: "compaction_not_complete" };
    if (input.boundary.rebind !== "required") return { status: "rejected", reason: "rebind_not_required" };
    if (this.active) return { status: "held", reason: this.active.state === "reserved" ? "send_reserved" : "unknown_send" };
    if (!validLineage(input.lineage) || input.lineage.conversationId !== this.lineage.conversationId ||
        input.lineage.epoch <= this.lineage.epoch || input.boundary.epoch !== input.lineage.epoch ||
        input.lineage.canonicalRevisionId !== this.lineage.canonicalRevisionId)
      return { status: "rejected", reason: "invalid_epoch_lineage" };
    if (input.acknowledgedRecords.length !== this.ackRecords.length ||
        input.acknowledgedRecords.some((record, index) => !sameAckRecord(record, this.ackRecords[index])))
      return { status: "rejected", reason: "acknowledgement_records_mismatch" };

    this.lineage = copyLineage(input.lineage);
    this.rebindRequired = false;
    return { status: "rebound", epoch: this.lineage.epoch };
  }

  acknowledgedRecords(): readonly CanonicalAckRecord[] {
    return Object.freeze(this.ackRecords.map(record => Object.freeze({ ...record })));
  }

  cancel(): { status: "cancelled" } {
    this.cancelled = true;
    this.active = undefined;
    return { status: "cancelled" };
  }

  snapshot(): {
    status: "open" | "integrity_blocked" | "cancelled";
    epoch: number;
    pendingRevisionIds: readonly number[];
    acknowledgedRevisionIds: readonly number[];
  } {
    return Object.freeze({
      status: this.cancelled ? "cancelled" : this.integrityBlocked ? "integrity_blocked" : "open",
      epoch: this.lineage.epoch,
      pendingRevisionIds: Object.freeze([...this.pendingRevisionIds]),
      acknowledgedRevisionIds: Object.freeze(this.ackRecords.map(record => record.revisionId)),
    });
  }

  private checkBoundary(boundary: ReceiptBoundary): BoundaryHoldReason | "cancelled" | undefined {
    if (this.cancelled) return "cancelled";
    if (boundary.stop === "user_cancelled") {
      this.cancel();
      return "cancelled";
    }
    if (boundary.activeTool === "active") return "active_tool";
    if (boundary.approval === "pending") return "approval_pending";
    if (boundary.stop === "requested") return "stop_pending";
    if (boundary.compaction === "pending") return "compaction_pending";
    if (boundary.epoch < this.lineage.epoch) {
      this.integrityBlocked = true;
      return "receipt_mismatch";
    }
    if (boundary.compaction === "complete" || boundary.rebind === "required" || boundary.epoch !== this.lineage.epoch) {
      this.rebindRequired = true;
      return "epoch_rebind_required";
    }
    if (this.rebindRequired) return "epoch_rebind_required";
    if (boundary.sendReceipt.status === "pending") return "before_send_ack";
    if (boundary.sendReceipt.status === "unknown") return "unknown_send";
    if (boundary.sendReceipt.status === "positive" && boundary.sendReceipt.deltaId !== this.lastAcknowledgedDeltaId)
      return "receipt_mismatch";
    if (boundary.generation === "active") return "generation_active";
    return undefined;
  }

  private blockInvalidReceipt(reason: string): ResolveSendResult {
    this.integrityBlocked = true;
    if (this.active) this.active.state = "unknown";
    return { status: "rejected", reason };
  }
}
