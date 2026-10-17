import { expect, test } from "bun:test";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";

test("cancellation before consuming a submitted handoff revokes its unconsumed summary", async () => {
  const store = new CompactionTransactionStore();
  const transaction = store.begin("cancel-submitted-handoff", 10_000);
  const abort = new AbortController();
  try {
    store.submit(transaction.token, transaction.handoffId, "Uncommitted checkpoint");
    abort.abort(new DOMException("Operator stopped compaction", "AbortError"));
    await expect(store.wait(transaction.token, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(store.wait(transaction.token)).rejects.toThrow("invalid, expired, or consumed");
    expect(() => store.submit(transaction.token, transaction.handoffId, "late summary"))
      .toThrow("invalid, expired, or consumed");
  } finally {
    store.close();
  }
});

test("cancellation of a waiting handoff rejects its waiter and refuses a late submission", async () => {
  const store = new CompactionTransactionStore();
  const transaction = store.begin("cancel-pending-handoff", 10_000);
  const abort = new AbortController();
  try {
    const waiting = store.wait(transaction.token, abort.signal);
    const settled = waiting.then(
      value => ({ status: "fulfilled", value }),
      error => ({ status: "rejected", name: error.name }),
    );
    abort.abort();
    await expect(settled).resolves.toMatchObject({ status: "rejected", name: "AbortError" });
    expect(() => store.submit(transaction.token, transaction.handoffId, "late summary"))
      .toThrow("invalid, expired, or consumed");
    await expect(store.wait(transaction.token)).rejects.toThrow("invalid, expired, or consumed");
  } finally {
    store.close();
  }
});

test("a consumed handoff remains a completed result when its observer aborts later", async () => {
  const store = new CompactionTransactionStore();
  const transaction = store.begin("already-consumed-handoff", 10_000);
  const abort = new AbortController();
  try {
    store.submit(transaction.token, transaction.handoffId, "  Accepted checkpoint  ");
    const completed = store.wait(transaction.token, abort.signal);
    abort.abort();
    await expect(completed).resolves.toBe("Accepted checkpoint");
    await expect(store.wait(transaction.token)).rejects.toThrow("invalid, expired, or consumed");
  } finally {
    store.close();
  }
});
