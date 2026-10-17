import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

const receipt = "cwgcompact_" + "a".repeat(32);
const message = "Full source document before its transport receipt\n"
  + "<codex_web_compaction_receipt>" + receipt + "</codex_web_compaction_receipt>";

function fixture(rendered: string) {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const projection = {
    valid: true, bubbleCount: 1, contentCount: 1, canonical: "",
    draftText: rendered, connectorPaths: [],
  };
  const locator = { evaluate: async () => projection };
  return { worker, locator, baseline: {
    submittedText: message, submittedRenderedDraft: { text: message, connectorPaths: [] },
    compactionBindingProof: receipt,
  } };
}

test("compaction receipt proves accepted Send after Markdown changes displayed text", async () => {
  const rendered = message.slice(0, 20) + "\n".repeat(120) + message.slice(20);
  const { worker, locator, baseline } = fixture(rendered);
  expect(rendered.length).toBe(message.length + 120);
  expect(await worker.submittedUserMatches(locator, baseline)).toBe(true);
});

test("compaction rejects foreign, duplicate and absent receipts", async () => {
  for (const rendered of [
    message.replace(receipt, "cwgcompact_" + "b".repeat(32)),
    message + receipt,
    message.replace(receipt, ""),
  ]) {
    const { worker, locator, baseline } = fixture(rendered);
    expect(await worker.submittedUserMatches(locator, baseline)).toBe(false);
  }
});

test("compaction receipt is valid only for its prepared Send", async () => {
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    submissionDomState: async () => ({ turnIdentities: [] }),
    reconcileMultipartHistory: async () => {},
  }) as any;
  const page = { locator: () => ({}) } as any;
  const baseline = await worker.captureSubmissionBaseline(page, message, [], undefined, receipt);
  expect(baseline.compactionBindingProof).toBe(receipt);
  await expect(worker.captureSubmissionBaseline(page, message, [], undefined,
    "cwgcompact_" + "b".repeat(32))).rejects.toThrow("compaction receipt");
});
