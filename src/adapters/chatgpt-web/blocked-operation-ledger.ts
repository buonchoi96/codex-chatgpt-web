import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config";

export type BlockedOperationClassification =
  | "SAFETY_STATUS_UNDETERMINED" | "EXPLICIT_POLICY_DENIAL"
  | "USER_APPROVAL_REQUIRED" | "SANDBOX_DENIAL" | "TRANSPORT_FAILURE";

export interface BlockedOperationRecord {
  blocker_id: string;
  affected_goal_requirement: string;
  exact_tool_name: string;
  original_arguments_sha256: string;
  intended_operation: string;
  target_scope_sha256: string;
  request_turn_id_sha256: string;
  timestamp: string;
  classification: BlockedOperationClassification;
  dispatch_state: "pre_dispatch" | "dispatched" | "unknown";
  execution_receipt: "refusal_returned" | "verified_not_executed" | "verified_completed" | "unknown";
  last_verified_state: string;
  required_permission: string;
  attempts: number;
  next_allowed_review_condition: string;
  resolution: "PENDING_SAFETY_REVIEW" | "BLOCKED_BY_SAFETY" | "VERIFIED_COMPLETED" | "NO_LONGER_REQUIRED";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A persistent, private record for tasks that may not be silently checked off by /goal. */
export class BlockedOperationLedger {
  constructor(readonly filePath = join(getConfigDir(), "runtime", "blocked-operations.json")) {}

  list(): BlockedOperationRecord[] {
    let data: string;
    try { data = readFileSync(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== "object"
      || typeof item.blocker_id !== "string" || typeof item.resolution !== "string")) {
      throw new Error("Blocked operation ledger is invalid; preserve it for manual reconciliation");
    }
    return parsed as BlockedOperationRecord[];
  }

  unresolved(): BlockedOperationRecord[] {
    return this.list().filter(item => item.resolution === "PENDING_SAFETY_REVIEW"
      || item.resolution === "BLOCKED_BY_SAFETY");
  }

  recordSafetyRefusal(input: {
    tool: string;
    arguments: unknown;
    owner: string;
    targetScope: unknown;
    affectedGoalRequirement?: string;
  }): BlockedOperationRecord {
    const blocker: BlockedOperationRecord = {
      blocker_id: `blocked_${randomUUID()}`,
      affected_goal_requirement: input.affectedGoalRequirement ?? "UNMAPPED_GOAL_PREREQUISITE_REVIEW_REQUIRED",
      exact_tool_name: input.tool,
      original_arguments_sha256: sha256(input.arguments),
      intended_operation: `Native tool invocation: ${input.tool}`,
      target_scope_sha256: sha256(input.targetScope),
      request_turn_id_sha256: sha256(input.owner),
      timestamp: new Date().toISOString(),
      classification: "SAFETY_STATUS_UNDETERMINED",
      dispatch_state: "unknown",
      execution_receipt: "refusal_returned",
      last_verified_state: "Native tool returned an explicit safety-status refusal; execution outcome is unverified",
      required_permission: "Review the affected operation and original native safety decision",
      attempts: 1,
      next_allowed_review_condition: "Explicitly authorized native approval/review permits a retry AND receipts prove no effect",
      resolution: "PENDING_SAFETY_REVIEW",
    };
    this.persist([...this.list(), blocker]);
    return blocker;
  }

  /** No execution or retry is performed. Keep only the digest of independently reviewed evidence. */
  resolve(blockerId: string, resolution: "VERIFIED_COMPLETED" | "NO_LONGER_REQUIRED", evidence: string): void {
    if (evidence.trim().length < 8) throw new Error("Resolution requires a concrete verification receipt");
    const records = this.list();
    const blocker = records.find(item => item.blocker_id === blockerId);
    if (!blocker) throw new Error("The blocked operation is not present in the ledger");
    blocker.resolution = resolution;
    blocker.execution_receipt = resolution === "VERIFIED_COMPLETED" ? "verified_completed" : blocker.execution_receipt;
    blocker.last_verified_state = `Human-reviewed verification receipt SHA-256: ${sha256(evidence)}`;
    this.persist(records);
  }

  private persist(records: BlockedOperationRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(tempPath, this.filePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}
