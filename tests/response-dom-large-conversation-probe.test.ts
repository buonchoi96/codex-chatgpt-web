import { expect, test } from "bun:test";
import type { Locator } from "playwright-core";
import {
  CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  CHATGPT_RESPONSE_DOM_PROBE_TIMEOUT_MS,
  MAX_CHATGPT_BROWSER_PAGE_REBINDS,
  ChatGptBrowserObservationTimeoutError,
  ChatGptBrowserWorker,
} from "../src/adapters/chatgpt-web/browser-worker";
import { pendingJournaledFinalAnswerSuffix } from "../src/adapters/chatgpt-web/finalization-gate";

test("response Markdown projection gets a longer bounded probe than lightweight pre-Send checks", async () => {
  expect(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS).toBe(5_000);
  expect(CHATGPT_RESPONSE_DOM_PROBE_TIMEOUT_MS).toBe(20_000);
  expect(MAX_CHATGPT_BROWSER_PAGE_REBINDS).toBe(2);
  let receivedTimeout = 0;
  const locator = {
    evaluate: async (_fn: unknown, _options: { timeout: number }) => {
      receivedTimeout = _options.timeout;
      const error = new Error("page.evaluate: Timeout exceeded");
      error.name = "TimeoutError";
      throw error;
    },
    page: () => ({ isClosed: () => false }),
  } as unknown as Locator;
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    responseDomSnapshot(locator: Locator): Promise<unknown>;
  };
  await expect(worker.responseDomSnapshot(locator)).rejects.toBeInstanceOf(
    ChatGptBrowserObservationTimeoutError,
  );
  expect(receivedTimeout).toBe(CHATGPT_RESPONSE_DOM_PROBE_TIMEOUT_MS);
});

test("a browser-visible completed last line must enter the final-answer journal without duplication", () => {
  const prefix = "Tool receipt accepted.\n";
  const finalLine = "Final goal status: PURSUING.\n";
  const recorded = [
    { type: "text_delta" as const, phase: "final_answer" as const, text: prefix },
  ];
  expect(pendingJournaledFinalAnswerSuffix(recorded, prefix + finalLine)).toBe(finalLine);
  expect(pendingJournaledFinalAnswerSuffix([
    ...recorded,
    { type: "text_delta" as const, phase: "final_answer" as const, text: finalLine },
  ], prefix + finalLine)).toBe("");
});
