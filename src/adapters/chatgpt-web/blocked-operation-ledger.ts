import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  /** Locally owned observation identity, never an invented native call/trace ID. */
  observation_id_sha256?: string;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

const MAX_RECORDS = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const REVIEW = /^Human-reviewed verification receipt SHA-256: [a-f0-9]{64}$/;
const CLASSIFICATIONS = new Set(["SAFETY_STATUS_UNDETERMINED", "EXPLICIT_POLICY_DENIAL", "USER_APPROVAL_REQUIRED", "SANDBOX_DENIAL", "TRANSPORT_FAILURE"]);
const RESOLUTIONS = new Set(["PENDING_SAFETY_REVIEW", "BLOCKED_BY_SAFETY", "VERIFIED_COMPLETED", "NO_LONGER_REQUIRED"]);

function validRecord(item: unknown): item is BlockedOperationRecord {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  const textFields = ["blocker_id", "affected_goal_requirement", "exact_tool_name", "intended_operation", "timestamp", "last_verified_state", "required_permission", "next_allowed_review_condition"];
  if (textFields.some(key => typeof record[key] !== "string" || !(record[key] as string).trim() || (record[key] as string).length > 4096)) return false;
  if (!/^[A-Za-z0-9_.-]{1,256}$/.test(record.exact_tool_name as string)
    || !Number.isFinite(Date.parse(record.timestamp as string))
    || !["original_arguments_sha256", "target_scope_sha256", "request_turn_id_sha256"].every(key => typeof record[key] === "string" && HASH.test(record[key] as string))
    || record.observation_id_sha256 !== undefined && (typeof record.observation_id_sha256 !== "string" || !HASH.test(record.observation_id_sha256))
    || !CLASSIFICATIONS.has(record.classification as string) || !RESOLUTIONS.has(record.resolution as string)
    || !["pre_dispatch", "dispatched", "unknown"].includes(record.dispatch_state as string)
    || !["refusal_returned", "verified_not_executed", "verified_completed", "unknown"].includes(record.execution_receipt as string)
    || !Number.isSafeInteger(record.attempts) || (record.attempts as number) < 1) return false;
  if (["VERIFIED_COMPLETED", "NO_LONGER_REQUIRED"].includes(record.resolution as string) && !REVIEW.test(record.last_verified_state as string)) return false;
  return record.resolution !== "VERIFIED_COMPLETED" || record.execution_receipt === "verified_completed";
}

/** A persistent, private record for tasks that may not be silently checked off by /goal. */
export class BlockedOperationLedger {
  constructor(readonly filePath = join(getConfigDir(), "runtime", "blocked-operations.json")) {}

  list(): BlockedOperationRecord[] {
    let data: string;
    try {
      if (statSync(this.filePath).size > MAX_BYTES) throw new Error("Blocked operation ledger is invalid or full; preserve it for manual reconciliation");
      data = readFileSync(this.filePath, "utf8");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { throw new Error("Blocked operation ledger is invalid; preserve it for manual reconciliation"); }
    if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS || !parsed.every(validRecord)
      || new Set(parsed.map(item => item.blocker_id)).size !== parsed.length
      || new Set(parsed.filter(item => item.observation_id_sha256).map(item => item.observation_id_sha256)).size !== parsed.filter(item => item.observation_id_sha256).length) {
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
    observationId?: string;
  }): BlockedOperationRecord {
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(input.tool)) throw new Error("Blocked operation tool name is invalid");
    return this.withWriteLock(() => {
    const records = this.list();
    const observation = input.observationId ? sha256([input.owner, input.observationId]) : undefined;
    const argumentsHash = sha256(input.arguments), targetHash = sha256(input.targetScope), ownerHash = sha256(input.owner);
    const existing = observation ? records.find(item => item.observation_id_sha256 === observation) : undefined;
    if (existing) {
      if (existing.exact_tool_name !== input.tool || existing.original_arguments_sha256 !== argumentsHash
        || existing.target_scope_sha256 !== targetHash || existing.request_turn_id_sha256 !== ownerHash
        || existing.affected_goal_requirement !== (input.affectedGoalRequirement ?? "UNMAPPED_GOAL_PREREQUISITE_REVIEW_REQUIRED")) {
        throw new Error("Blocked operation observation conflict; preserve original evidence");
      }
      return existing;
    }
    const blocker: BlockedOperationRecord = {
      blocker_id: `blocked_${randomUUID()}`,
      affected_goal_requirement: input.affectedGoalRequirement ?? "UNMAPPED_GOAL_PREREQUISITE_REVIEW_REQUIRED",
      exact_tool_name: input.tool,
      original_arguments_sha256: argumentsHash,
      intended_operation: `Native tool invocation: ${input.tool}`,
      target_scope_sha256: targetHash,
      request_turn_id_sha256: ownerHash,
      ...(observation ? { observation_id_sha256: observation } : {}),
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
    this.persist([...records, blocker]);
    return blocker;
    });
  }

  /** No execution or retry is performed. Keep only the digest of independently reviewed evidence. */
  resolve(blockerId: string, resolution: "VERIFIED_COMPLETED" | "NO_LONGER_REQUIRED", evidence: string): void {
    if (evidence.trim().length < 8) throw new Error("Resolution requires a concrete verification receipt");
    this.withWriteLock(() => {
    const records = this.list();
    const blocker = records.find(item => item.blocker_id === blockerId);
    if (!blocker) throw new Error("The blocked operation is not present in the ledger");
    blocker.resolution = resolution;
    blocker.execution_receipt = resolution === "VERIFIED_COMPLETED" ? "verified_completed" : blocker.execution_receipt;
    blocker.last_verified_state = `Human-reviewed verification receipt SHA-256: ${sha256(evidence)}`;
    this.persist(records);
    });
  }

  private withWriteLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lock = `${this.filePath}.lock`;
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Blocked operation ledger is busy; persistence is unverified, no execution or retry permitted");
      throw new Error("Blocked operation ledger lock could not be acquired; persistence is unverified");
    }
    try { return operation(); } finally { rmdirSync(lock); }
  }

  private persist(records: BlockedOperationRecord[]): void {
    if (records.length > MAX_RECORDS || !records.every(validRecord)) throw new Error("Blocked operation ledger is invalid or full; no record was removed");
    const serialized = JSON.stringify(records, null, 2);
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Blocked operation ledger is full; no record was removed");
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(tempPath, this.filePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}
