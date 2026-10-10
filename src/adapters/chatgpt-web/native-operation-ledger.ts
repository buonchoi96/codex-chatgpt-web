import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "../../config";

type Receipt = { key: string; owner: string; state: "started" | "completed"; resultHash?: string; attempts?: number; integrity: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = /^[a-f0-9]{64}$/;

/** Durable evidence survives a lost owner; private tool output remains in canonical native history. */
export class NativeOperationLedger {
  private readonly owner = digest(randomBytes(24).toString("hex"));
  constructor(private readonly file: () => string) {}
  private update(scope: string, operation: string, result?: unknown, recovery = false): void {
    if (!hash.test(scope) || !hash.test(operation)) throw new Error("RECONCILIATION_REQUIRED: invalid operation ownership");
    const file = this.file(), lock = `${file}.lock`;
    let descriptor: number | undefined;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      descriptor = openSync(lock, "wx", 0o600);
      const receipts = new Map<string, Receipt>();
      if (existsSync(file)) {
        if (statSync(file).size > 512 * 1024) throw new Error("receipt budget exceeded");
        const ledger = JSON.parse(readFileSync(file, "utf8"));
        if (ledger.version !== 1 || !Array.isArray(ledger.operations) || ledger.operations.length > 1024) throw new Error("invalid ledger");
        for (const receipt of ledger.operations) {
          const { integrity, ...fields } = receipt;
          if (!hash.test(fields.key) || !hash.test(fields.owner) || !["started", "completed"].includes(fields.state)
            || (fields.resultHash !== undefined && !hash.test(fields.resultHash))
            || (fields.attempts !== undefined && (!Number.isSafeInteger(fields.attempts) || fields.attempts < 1 || fields.attempts > 8))
            || Object.keys(fields).length !== (3 + (fields.resultHash === undefined ? 0 : 1) + (fields.attempts === undefined ? 0 : 1))
            || integrity !== digest(fields) || receipts.has(fields.key)) throw new Error("invalid receipt");
          receipts.set(fields.key, receipt);
        }
      }
      const key = digest([scope, operation]), previous = receipts.get(key);
      if (previous && previous.owner !== this.owner) throw new Error("prior native owner/outcome requires reconciliation; do not replay");
      if (recovery && (previous?.attempts ?? 0) >= 8) throw new Error("recovery budget exhausted");
      if (!previous && receipts.size >= 1024) throw new Error("receipt budget exhausted; owner reconciliation required");
      const fields = { key, owner: this.owner, state: result === undefined ? "started" as const : "completed" as const,
        ...(recovery ? { attempts: (previous?.attempts ?? 0) + 1 } : previous?.attempts ? { attempts: previous.attempts } : {}),
        ...(result === undefined ? {} : { resultHash: digest(result) }) };
      receipts.set(key, { ...fields, integrity: digest(fields) });
      atomicWriteFile(file, JSON.stringify({ version: 1, operations: [...receipts.values()] }), { durable: true });
    } catch {
      throw new Error("RECONCILIATION_REQUIRED: durable native receipt ownership/outcome is unverified; do not replay");
    } finally {
      if (descriptor !== undefined) { closeSync(descriptor); unlinkSync(lock); }
    }
  }
  begin(scope: string, operation: string): void { this.update(scope, operation); }
  complete(scope: string, operation: string, result: unknown): void { this.update(scope, operation, result); }
  beginRecovery(scope: string): void { this.update(scope, digest("same-tab-recovery"), undefined, true); }
}
