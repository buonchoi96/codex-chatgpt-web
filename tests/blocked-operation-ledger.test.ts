import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockedOperationLedger } from "../src/adapters/chatgpt-web/blocked-operation-ledger";

test("safety refusal remains unresolved after a new ledger process and never stores raw arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-test-"));
  const file = join(dir, "blocked.json");
  try {
    const store = new BlockedOperationLedger(file);
    const record = store.recordSafetyRefusal({
      tool: "exec_command", arguments: { cmd: "PRIVATE_SENTINEL_123" },
      owner: "turn_SECRET_SENTINEL", targetScope: { cwd: "C:/SENSITIVE_ROOT" },
      affectedGoalRequirement: "P0-0 safety review test",
    });
    expect(record.resolution).toBe("PENDING_SAFETY_REVIEW");
    expect(record.classification).toBe("SAFETY_STATUS_UNDETERMINED");
    expect(record.dispatch_state).toBe("unknown");
    expect(record.attempts).toBe(1);
    expect(new BlockedOperationLedger(file).unresolved()).toHaveLength(1);
    const serialized = readFileSync(file, "utf8");
    expect(serialized).not.toContain("PRIVATE_SENTINEL_123");
    expect(serialized).not.toContain("turn_SECRET_SENTINEL");
    expect(serialized).not.toContain("C:/SENSITIVE_ROOT");
    expect(() => store.resolve(record.blocker_id, "VERIFIED_COMPLETED", ""))
      .toThrow("requires a concrete verification receipt");
    expect(new BlockedOperationLedger(file).unresolved()).toHaveLength(1);
    store.resolve(record.blocker_id, "VERIFIED_COMPLETED", "Verified tool receipt 42");
    expect(new BlockedOperationLedger(file).unresolved()).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("multiple blocked operations retain distinct digests and remain pending until individually reviewed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-multiple-test-"));
  const file = join(dir, "blocked.json");
  try {
    const ledger = new BlockedOperationLedger(file);
    const one = ledger.recordSafetyRefusal({ tool: "exec_command", arguments: { cmd: "one" }, owner: "turn-1", targetScope: "a" });
    const two = ledger.recordSafetyRefusal({ tool: "exec_command", arguments: { cmd: "two" }, owner: "turn-1", targetScope: "a" });
    expect(one.original_arguments_sha256).not.toBe(two.original_arguments_sha256);
    expect(ledger.unresolved().map(entry => entry.blocker_id)).toEqual([one.blocker_id, two.blocker_id]);
    expect(readdirSync(dir).some(name => name.endsWith(".tmp"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
