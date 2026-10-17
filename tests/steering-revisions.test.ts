import { describe, expect, test } from "bun:test";
import {
  SteeringRevisionQueue,
  type BoundaryHoldReason,
  type CanonicalAckRecord,
  type CanonicalLineage,
  type ReceiptBoundary,
} from "../src/adapters/chatgpt-web/steering-revisions";

function lineage(overrides: Partial<CanonicalLineage> = {}): CanonicalLineage {
  return {
    verification: "proven",
    conversationId: "conversation-a",
    epoch: 1,
    canonicalRevisionId: "native-0",
    canonicalPrefixHash: "prefix-0",
    proofId: "proof-0",
    ...overrides,
  };
}

function boundary(overrides: Partial<ReceiptBoundary> = {}): ReceiptBoundary {
  return {
    epoch: 1,
    generation: "idle",
    sendReceipt: { status: "none" },
    activeTool: "none",
    approval: "none",
    compaction: "none",
    rebind: "current",
    stop: "none",
    ...overrides,
  };
}

function add(queue: SteeringRevisionQueue, sourceRevisionId: string, predecessorRevisionId: string,
  delta: string, revisionLineage = lineage()) {
  return queue.enqueueRevision({ sourceRevisionId, predecessorRevisionId, lineage: revisionLineage, delta });
}

function acknowledge(queue: SteeringRevisionQueue, deltaId: string, revisionIds: number[], acceptedLineage: CanonicalLineage) {
  return queue.resolveSend({ kind: "positive", deltaId, revisionIds, lineage: acceptedLineage });
}

describe("SteeringRevisionQueue", () => {
  test("assigns monotonic IDs, deduplicates exact reconnects, and blocks conflicting reuse", () => {
    const queue = new SteeringRevisionQueue(lineage());
    const first = add(queue, "native-1", "native-0", "Keep the original task.");
    expect(first).toEqual({ status: "queued", revisionId: 1 });
    expect(add(queue, "native-1", "native-0", "Keep the original task.")).toEqual({
      status: "duplicate", revisionId: 1,
    });
    expect(add(queue, "native-2", "native-1", "Also add a test.")).toEqual({
      status: "queued", revisionId: 2,
    });
    expect(add(queue, "native-1", "native-0", "Replace the first instruction.")).toEqual({
      status: "blocked", reason: "revision_conflict",
    });
    expect(queue.reserve(boundary())).toEqual({ status: "held", reason: "integrity_blocked" });
  });

  test("orders revisions across reasoning, active tools, a reserved send, and unknown acknowledgement", () => {
    const queue = new SteeringRevisionQueue(lineage());
    add(queue, "native-1", "native-0", "Change the label.");
    expect(queue.reserve(boundary({ generation: "active" }))).toEqual({
      status: "held", reason: "generation_active",
    });
    expect(queue.reserve(boundary({ activeTool: "active" }))).toEqual({ status: "held", reason: "active_tool" });

    const reserved = queue.reserve(boundary());
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") throw new Error("expected first reservation");
    expect(queue.reserve(boundary())).toEqual(reserved);
    expect(reserved.delta.revisionIds).toEqual([1]);
    expect(reserved.delta.text).toBe("Change the label.");
    expect(reserved.delta.idempotencyKey).toBe(reserved.delta.deltaId);
    expect(queue.beginSend(reserved.delta.deltaId, boundary())).toMatchObject({ status: "send_once" });

    // A revision racing the send is appended after the frozen reservation.
    expect(add(queue, "native-2", "native-1", "Add a regression test.")).toEqual({
      status: "queued", revisionId: 2,
    });
    expect(queue.reserve(boundary({ sendReceipt: { status: "pending", deltaId: reserved.delta.deltaId } }))).toEqual({
      status: "held", reason: "before_send_ack",
    });
    expect(queue.resolveSend({ kind: "unknown", deltaId: reserved.delta.deltaId })).toEqual({
      status: "held", reason: "unknown_send",
    });
    expect(queue.beginSend(reserved.delta.deltaId, boundary())).toEqual({ status: "held", reason: "unknown_send" });
    expect(queue.reserve(boundary({ sendReceipt: { status: "unknown", deltaId: reserved.delta.deltaId } }))).toEqual({
      status: "held", reason: "unknown_send",
    });
    expect(queue.snapshot()).toMatchObject({ pendingRevisionIds: [1, 2], acknowledgedRevisionIds: [] });

    const afterFirst = lineage({ canonicalRevisionId: "native-1", canonicalPrefixHash: "prefix-1", proofId: "proof-1" });
    expect(acknowledge(queue, reserved.delta.deltaId, [1], afterFirst)).toEqual({
      status: "accepted", deltaId: reserved.delta.deltaId, revisionIds: [1],
    });
    const next = queue.reserve(boundary({ sendReceipt: { status: "positive", deltaId: reserved.delta.deltaId } }));
    expect(next.status).toBe("reserved");
    if (next.status !== "reserved") throw new Error("expected second reservation");
    expect(next.delta.revisionIds).toEqual([2]);
    expect(next.delta.text).toBe("Add a regression test.");
    expect(next.delta.lineage).toEqual(afterFirst);
    expect(queue.beginSend(next.delta.deltaId, boundary({
      sendReceipt: { status: "positive", deltaId: reserved.delta.deltaId },
    })).status).toBe("send_once");
    expect(acknowledge(queue, next.delta.deltaId, [2], lineage({
      canonicalRevisionId: "native-2", canonicalPrefixHash: "prefix-2", proofId: "proof-2",
    }))).toMatchObject({ status: "accepted", revisionIds: [2] });
    expect(queue.snapshot()).toMatchObject({ status: "open", pendingRevisionIds: [], acknowledgedRevisionIds: [1, 2] });
  });

  test("holds the queue at approval, Stop, and compaction receipt boundaries", () => {
    const queue = new SteeringRevisionQueue(lineage());
    add(queue, "native-1", "native-0", "Keep this delta pending.");
    const cases: Array<[ReceiptBoundary, BoundaryHoldReason]> = [
      [boundary({ approval: "pending" }), "approval_pending"],
      [boundary({ stop: "requested" }), "stop_pending"],
      [boundary({ compaction: "pending" }), "compaction_pending"],
      [boundary({ sendReceipt: { status: "pending", deltaId: "foreign-send" } }), "before_send_ack"],
    ];
    for (const [blockedBoundary, reason] of cases)
      expect(queue.reserve(blockedBoundary)).toEqual({ status: "held", reason });
    const rebindQueue = new SteeringRevisionQueue(lineage());
    add(rebindQueue, "native-1", "native-0", "Wait for epoch proof.");
    expect(rebindQueue.reserve(boundary({ rebind: "required" }))).toEqual({
      status: "held", reason: "epoch_rebind_required",
    });
  });

  test("does not dequeue on a malformed positive receipt", () => {
    const queue = new SteeringRevisionQueue(lineage());
    add(queue, "native-1", "native-0", "Keep until its exact receipt arrives.");
    const reserved = queue.reserve(boundary());
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    queue.beginSend(reserved.delta.deltaId, boundary());
    expect(acknowledge(queue, reserved.delta.deltaId, [], lineage({
      canonicalRevisionId: "native-1", canonicalPrefixHash: "wrong-prefix", proofId: "wrong-proof",
    }))).toEqual({ status: "rejected", reason: "positive_receipt_does_not_match_reservation" });
    expect(queue.snapshot()).toMatchObject({
      status: "integrity_blocked", pendingRevisionIds: [1], acknowledgedRevisionIds: [],
    });
    expect(queue.reserve(boundary())).toEqual({ status: "held", reason: "integrity_blocked" });
  });

  test("retries only a positively known not-sent reservation with the same idempotency key", () => {
    const queue = new SteeringRevisionQueue(lineage());
    add(queue, "native-1", "native-0", "Retry only after a definite non-send.");
    const reserved = queue.reserve(boundary());
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    queue.beginSend(reserved.delta.deltaId, boundary());
    expect(queue.resolveSend({ kind: "not_sent", deltaId: reserved.delta.deltaId })).toMatchObject({
      status: "retryable_not_sent", deltaId: reserved.delta.deltaId,
    });
    const retry = queue.reserve(boundary());
    expect(retry).toEqual(reserved);
    expect(queue.beginSend(reserved.delta.deltaId, boundary()).status).toBe("send_once");
  });

  test("fails closed at the bounded pending revision limit", () => {
    const queue = new SteeringRevisionQueue(lineage());
    let predecessor = "native-0";
    for (let index = 1; index <= 64; index++) {
      const sourceRevisionId = `native-${index}`;
      expect(add(queue, sourceRevisionId, predecessor, `Instruction ${index}.`).status).toBe("queued");
      predecessor = sourceRevisionId;
    }
    expect(add(queue, "native-65", predecessor, "This must not be silently dropped.")).toEqual({
      status: "blocked", reason: "queue_capacity_exceeded",
    });
    expect(queue.reserve(boundary())).toEqual({ status: "held", reason: "integrity_blocked" });
  });

  test("requires exact canonical acknowledgement records before compaction epoch rebind", () => {
    const queue = new SteeringRevisionQueue(lineage());
    add(queue, "native-1", "native-0", "Keep the pending follow-up.");
    const first = queue.reserve(boundary());
    if (first.status !== "reserved") throw new Error("expected reservation");
    queue.beginSend(first.delta.deltaId, boundary());
    const acceptedLineage = lineage({ canonicalRevisionId: "native-1", canonicalPrefixHash: "prefix-1", proofId: "proof-1" });
    expect(acknowledge(queue, first.delta.deltaId, [1], acceptedLineage).status).toBe("accepted");
    add(queue, "native-2", "native-1", "Preserve this across compaction.", acceptedLineage);

    const compactionBoundary = boundary({ epoch: 2, compaction: "complete", rebind: "required",
      sendReceipt: { status: "positive", deltaId: first.delta.deltaId } });
    expect(queue.reserve(compactionBoundary)).toEqual({ status: "held", reason: "epoch_rebind_required" });
    const nextLineage = lineage({ epoch: 2, canonicalRevisionId: "native-1", canonicalPrefixHash: "compact-prefix",
      proofId: "compact-proof" });
    expect(queue.rebindEpoch({ lineage: nextLineage, acknowledgedRecords: [], boundary: compactionBoundary })).toEqual({
      status: "rejected", reason: "acknowledgement_records_mismatch",
    });
    const canonicalAckRecords: readonly CanonicalAckRecord[] = queue.acknowledgedRecords();
    expect(canonicalAckRecords).toHaveLength(1);
    expect(queue.rebindEpoch({ lineage: nextLineage, acknowledgedRecords: canonicalAckRecords, boundary: compactionBoundary })).toEqual({
      status: "rebound", epoch: 2,
    });
    const afterRebind = queue.reserve(boundary({ epoch: 2 }));
    expect(afterRebind.status).toBe("reserved");
    if (afterRebind.status !== "reserved") throw new Error("expected post-compaction delta");
    expect(afterRebind.delta.revisionIds).toEqual([2]);
    expect(afterRebind.delta.text).toBe("Preserve this across compaction.");
    expect(afterRebind.delta.epoch).toBe(2);
  });

  test("user cancellation is terminal and removes all send authority", () => {
    const queue = new SteeringRevisionQueue(lineage());
    add(queue, "native-1", "native-0", "Do not resume after Stop.");
    const reserved = queue.reserve(boundary());
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    queue.beginSend(reserved.delta.deltaId, boundary());
    expect(queue.reserve(boundary({ stop: "user_cancelled" }))).toEqual({ status: "cancelled" });
    expect(queue.beginSend(reserved.delta.deltaId, boundary())).toEqual({ status: "cancelled" });
    expect(add(queue, "native-2", "native-1", "This cannot be resumed.")).toEqual({ status: "cancelled" });
    expect(acknowledge(queue, reserved.delta.deltaId, [1], lineage({
      canonicalRevisionId: "native-1", canonicalPrefixHash: "prefix-1", proofId: "proof-1",
    }))).toEqual({ status: "cancelled" });
    expect(queue.snapshot().status).toBe("cancelled");
  });
});
