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


test("passive recovery receipt must persist before its one-shot token is acknowledged", async () => {
  const store = new CompactionTransactionStore();
  const saved:string[]=[];
  const transaction=store.begin("passive-native-checkpoint",10_000,summary=>saved.push(summary));
  try {
    expect(() => store.submit(transaction.token,transaction.handoffId,"summary","compaction"))
      .toThrow("does not match");
    expect(saved).toEqual([]);
    store.submit(transaction.token,transaction.handoffId,"  summary  ","recovery");
    expect(saved).toEqual(["summary"]);
    expect(await store.wait(transaction.token)).toBe("summary");
    expect(() => store.submit(transaction.token,transaction.handoffId,"duplicate","recovery"))
      .toThrow("invalid, expired, or consumed");
  } finally { store.close(); }
});

test("failed checkpoint persistence cannot produce a successful recovery handoff", () => {
  const store=new CompactionTransactionStore();
  const checkpoint=store.begin("durable-write-denied",10_000,()=>{throw new Error("disk unavailable");});
  try {
    expect(()=>store.submit(checkpoint.token,checkpoint.handoffId,"summarized","recovery"))
      .toThrow("disk unavailable");
    // No completion was acknowledged; a retry still requires a working durable store.
    expect(()=>store.submit(checkpoint.token,checkpoint.handoffId,"summarized","compaction"))
      .toThrow("does not match");
  } finally {store.close();}
});
