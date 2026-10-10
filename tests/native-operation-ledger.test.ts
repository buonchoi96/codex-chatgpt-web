import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeOperationLedger } from "../src/adapters/chatgpt-web/native-operation-ledger";

test("restart receipts forbid replay without storing private native results", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-operation-ledger-"));
  const file = join(root, "ledger.json"), scope = "a".repeat(64), operation = "b".repeat(64);
  try {
    const ledger = new NativeOperationLedger(() => file);
    ledger.begin(scope, operation);
    ledger.complete(scope, operation, { content: [{ type: "text", text: "private result" }] });
    expect(() => new NativeOperationLedger(() => file).begin(scope, operation)).toThrow("RECONCILIATION_REQUIRED");
    ledger.begin(scope, operation); // Intentional repetition in the original live owner is permitted.
    expect(readFileSync(file, "utf8")).not.toContain("private result");
    expect(() => new NativeOperationLedger(() => file).begin(scope, operation)).toThrow("RECONCILIATION_REQUIRED");
    new NativeOperationLedger(() => file).begin("c".repeat(64), operation);
    writeFileSync(file, '{"version":1,"operations":[{"state":"completed"}]}');
    expect(() => new NativeOperationLedger(() => file).begin(scope, operation)).toThrow("RECONCILIATION_REQUIRED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("receipt write failure prevents dispatch instead of making a side effect replayable", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-operation-ledger-"));
  try {
    expect(() => new NativeOperationLedger(() => root).begin("a".repeat(64), "b".repeat(64))).toThrow("RECONCILIATION_REQUIRED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery attempts remain bounded across helper/channel replacement and refuse a lost native owner", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-recovery-ledger-"));
  try {
    const file = () => join(root, "ledger.json"), scope = "a".repeat(64);
    const ledger = new NativeOperationLedger(file);
    for (let attempt = 0; attempt < 8; ++attempt) ledger.beginRecovery(scope);
    expect(() => ledger.beginRecovery(scope)).toThrow("RECONCILIATION_REQUIRED");
    expect(() => new NativeOperationLedger(file).beginRecovery(scope)).toThrow("RECONCILIATION_REQUIRED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
