import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("unknown or incomplete persisted resolutions fail closed instead of dropping unresolved work", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-corrupt-"));
  const file = join(dir, "blocked.json");
  try {
    for (const malformed of [
      [{ blocker_id: "retained", resolution: "invented_done" }],
      [{ blocker_id: "retained", resolution: "VERIFIED_COMPLETED" }],
      [{ blocker_id: "retained", resolution: "PENDING_SAFETY_REVIEW" }],
    ]) {
      const bytes = JSON.stringify(malformed);
      writeFileSync(file, bytes);
      expect(() => new BlockedOperationLedger(file).unresolved()).toThrow("invalid");
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a busy ledger cannot overwrite another writer or silently resolve a prerequisite", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-lock-"));
  const file = join(dir, "blocked.json");
  try {
    const store = new BlockedOperationLedger(file);
    const first = store.recordSafetyRefusal({ tool: "exec_command", arguments: {}, owner: "fixture", targetScope: "fixture" });
    const bytes = readFileSync(file, "utf8");
    mkdirSync(`${file}.lock`);
    expect(() => store.recordSafetyRefusal({ tool: "exec_command", arguments: {}, owner: "fixture-2", targetScope: "fixture" })).toThrow("busy");
    expect(() => store.resolve(first.blocker_id, "VERIFIED_COMPLETED", "receipt fixture" )).toThrow("busy");
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(store.unresolved()).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("receipt reconciliation is idempotent within one local observation without merging different operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-idempotent-"));
  const file = join(dir, "blocked.json");
  try {
    const input = { tool: "exec_command", arguments: { cmd: "fixture" }, owner: "fixture", targetScope: "fixture", observationId: "fixture-observation-1" };
    const first = new BlockedOperationLedger(file).recordSafetyRefusal(input);
    expect(new BlockedOperationLedger(file).recordSafetyRefusal(input).blocker_id).toBe(first.blocker_id);
    expect(new BlockedOperationLedger(file).unresolved()).toHaveLength(1);
    expect(() => new BlockedOperationLedger(file).recordSafetyRefusal({ ...input, arguments: { cmd: "different" } })).toThrow("conflict");
    expect(new BlockedOperationLedger(file).unresolved()).toHaveLength(1);
    new BlockedOperationLedger(file).recordSafetyRefusal({ ...input, observationId: "fixture-observation-2" });
    expect(new BlockedOperationLedger(file).unresolved()).toHaveLength(2);
    expect(readFileSync(file, "utf8")).not.toContain(input.observationId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an omitted freeform input still leaves a persistent unknown-outcome refusal", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-undefined-"));
  try {
    const store = new BlockedOperationLedger(join(dir, "blocked.json"));
    const record = store.recordSafetyRefusal({ tool: "exec", arguments: undefined, owner: "fixture", targetScope: {} });
    expect(store.unresolved()).toHaveLength(1);
    expect(record.original_arguments_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.dispatch_state).toBe("unknown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed persisted classifications, dispatch states, and receipts fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-enums-"));
  const file = join(dir, "blocked.json");
  try {
    const record = new BlockedOperationLedger(file).recordSafetyRefusal({
      tool: "exec_command", arguments: {}, owner: "fixture", targetScope: "fixture",
    });
    for (const [field, value] of [
      ["classification", "UNKNOWN_CLASSIFICATION"],
      ["dispatch_state", "retried"],
      ["execution_receipt", "success"],
    ] as const) {
      const malformed = { ...record, [field]: value };
      const bytes = JSON.stringify([malformed]);
      writeFileSync(file, bytes);
      expect(() => new BlockedOperationLedger(file).list()).toThrow("invalid");
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolved persisted records require an independently reviewed receipt digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-review-digest-"));
  const file = join(dir, "blocked.json");
  try {
    const record = new BlockedOperationLedger(file).recordSafetyRefusal({
      tool: "exec_command", arguments: {}, owner: "fixture", targetScope: "fixture",
    });
    const resolved = {
      ...record,
      resolution: "NO_LONGER_REQUIRED" as const,
      last_verified_state: "The prerequisite is no longer required",
    };
    const bytes = JSON.stringify([resolved]);
    writeFileSync(file, bytes);
    expect(() => new BlockedOperationLedger(file).unresolved()).toThrow("invalid");
    expect(readFileSync(file, "utf8")).toBe(bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("duplicate blocker and observation identities fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-duplicate-"));
  const file = join(dir, "blocked.json");
  try {
    const ledger = new BlockedOperationLedger(file);
    const one = ledger.recordSafetyRefusal({
      tool: "exec_command", arguments: { cmd: "one" }, owner: "fixture", targetScope: "fixture", observationId: "observation-one",
    });
    const two = ledger.recordSafetyRefusal({
      tool: "exec_command", arguments: { cmd: "two" }, owner: "fixture", targetScope: "fixture", observationId: "observation-two",
    });
    for (const duplicate of [
      [{ ...one }, { ...two, blocker_id: one.blocker_id }],
      [{ ...one }, { ...two, observation_id_sha256: one.observation_id_sha256 }],
    ]) {
      const bytes = JSON.stringify(duplicate);
      writeFileSync(file, bytes);
      expect(() => new BlockedOperationLedger(file).list()).toThrow("invalid");
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("valid legacy records without an observation digest remain readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-legacy-"));
  const file = join(dir, "blocked.json");
  try {
    const record = new BlockedOperationLedger(file).recordSafetyRefusal({
      tool: "exec_command", arguments: {}, owner: "fixture", targetScope: "fixture",
    });
    expect(record.observation_id_sha256).toBeUndefined();
    writeFileSync(file, JSON.stringify([record]));
    expect(new BlockedOperationLedger(file).list()).toEqual([record]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("persisted record and byte caps reject oversized ledgers without altering them", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgw-blocker-capacity-"));
  const file = join(dir, "blocked.json");
  try {
    const record = new BlockedOperationLedger(file).recordSafetyRefusal({
      tool: "exec_command", arguments: {}, owner: "fixture", targetScope: "fixture",
    });
    const tooMany = Array.from({ length: 10_001 }, (_, index) => ({ ...record, blocker_id: `blocked_${index}` }));
    const countBytes = JSON.stringify(tooMany);
    writeFileSync(file, countBytes);
    expect(() => new BlockedOperationLedger(file).list()).toThrow("invalid");
    expect(readFileSync(file, "utf8")).toBe(countBytes);

    const atRecordLimit = Array.from({ length: 10_000 }, (_, index) => ({ ...record, blocker_id: `blocked_${index}` }));
    const fullBytes = JSON.stringify(atRecordLimit);
    writeFileSync(file, fullBytes);
    expect(() => new BlockedOperationLedger(file).recordSafetyRefusal({
      tool: "exec_command", arguments: { cmd: "extra" }, owner: "fixture", targetScope: "fixture",
    })).toThrow("full");
    expect(readFileSync(file, "utf8")).toBe(fullBytes);

    const tooLarge = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
    writeFileSync(file, tooLarge);
    expect(() => new BlockedOperationLedger(file).list()).toThrow("invalid or full");
    expect(readFileSync(file)).toEqual(tooLarge);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
