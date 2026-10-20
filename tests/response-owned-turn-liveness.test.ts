import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import type { Page } from "playwright-core";
import {
  CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  CHATGPT_RESPONSE_DOM_PROBE_TIMEOUT_MS,
  MAX_CHATGPT_BROWSER_PAGE_REBINDS,
  chatGptOwnedTurnStillGenerating,
  chatGptDetachedAcceptedTurnMayStillBeRunning,
  chatGptAssistantBelongsToAcceptedUser,
  chatGptAssistantHasUserGroupEvidence,
  probeChatGptOwnedTurnLiveness,
} from "../src/adapters/chatgpt-web/browser-worker";

function probeFixture(options: {
  owner?: boolean;
  assistant?: boolean;
  stop?: boolean;
  hiddenStop?: boolean;
  completed?: boolean;
  detachedAssistant?: boolean;
}): Page {
  const { createWindow } = require("@mixmark-io/domino");
  const owner = options.owner === false ? "" : `<section data-turn-key="accepted-01">
      ${options.assistant === false ? "" : '<div data-conversation-role="assistant">Still generating text</div>'}
      ${options.completed ? '<div class="turn-action-controls"><button>Copy</button></div>' : ""}
    </section>`;
  const stop = options.stop === false ? ""
    : `<button data-testid="stop-button"${options.hiddenStop ? ' style="display:none"' : ""}>Stop</button>`;
  const detached = options.detachedAssistant
    ? '<section data-turn-key="temporary-02"><div data-conversation-role="assistant">Active temporary response</div></section>'
    : "";
  const window = createWindow(`<html><body>${owner}${detached}${stop}</body></html>`);
  const nodeListProto = Object.getPrototypeOf(window.document.querySelectorAll("button"));
  const existingIterator = Object.getOwnPropertyDescriptor(nodeListProto, Symbol.iterator);
  Object.defineProperty(nodeListProto, Symbol.iterator, {
    configurable: true,
    value: Array.prototype[Symbol.iterator],
  });
  const ctx = createContext({
    document: window.document,
    getComputedStyle: (node: HTMLElement) => ({
      display: node.style.display || "block",
      visibility: "visible",
      opacity: "1",
    }),
  });
  return {
    evaluate: async (callback: Function, args: unknown) => {
      try {
        return runInContext(`(${callback.toString()})`, ctx)(args);
      } finally {
        if (existingIterator) Object.defineProperty(nodeListProto, Symbol.iterator, existingIterator);
        else delete nodeListProto[Symbol.iterator];
      }
    },
  } as unknown as Page;
}

test("a running, owned assistant survives exhausted full-projection probes", async () => {
  const page = probeFixture({});
  const live = await probeChatGptOwnedTurnLiveness(page, "group:assistant:accepted-01");
  expect(live).toMatchObject({
    ownerPresent: true,
    assistantPresent: true,
    stopVisible: true,
    completionActionVisible: false,
  });
  expect(live.assistantTextChars).toBeGreaterThan(0);
  expect(chatGptOwnedTurnStillGenerating(live)).toBe(true);
  expect(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS).toBe(5_000);
  expect(CHATGPT_RESPONSE_DOM_PROBE_TIMEOUT_MS).toBe(20_000);
  expect(MAX_CHATGPT_BROWSER_PAGE_REBINDS).toBe(2);
});

test("stale or unrelated browser activity never proves the accepted turn is running", async () => {
  const cases = [
    { options: { owner: false }, expected: "ownerPresent" },
    { options: { assistant: false }, expected: "assistantPresent" },
    { options: { stop: false }, expected: "stopVisible" },
    { options: { hiddenStop: true }, expected: "stopVisible" },
  ] as const;
  for (const { options, expected } of cases) {
    const observation = await probeChatGptOwnedTurnLiveness(probeFixture(options), "group:assistant:accepted-01");
    expect(observation[expected]).toBe(false);
    expect(chatGptOwnedTurnStillGenerating(observation)).toBe(false);
  }
  const wrongIdentity = await probeChatGptOwnedTurnLiveness(probeFixture({}), "group:assistant:some-other-turn");
  expect(chatGptOwnedTurnStillGenerating(wrongIdentity)).toBe(false);
});

test("a live Stop is not mistaken for a completed answer, even when copy controls exist", async () => {
  const observed = await probeChatGptOwnedTurnLiveness(probeFixture({ completed: true }), "group:assistant:accepted-01");
  expect(observed.completionActionVisible).toBe(true);
  expect(chatGptOwnedTurnStillGenerating(observed)).toBe(true);
});

test("exhausted projection path preserves the accepted Send and defers completion", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8") as string;
  const boundary = source.indexOf("if (consecutiveObservationRebinds > MAX_CHATGPT_BROWSER_PAGE_REBINDS)");
  const probe = source.indexOf("probeChatGptOwnedTurnLiveness(page, responseTurn.identity)", boundary);
  const preserved = source.indexOf("if (owned && (chatGptOwnedTurnStillGenerating(owned)", probe);
  const deferred = source.indexOf("response_projection_deferred", preserved);
  const nextIteration = source.indexOf("continue;", deferred);
  const failure = source.indexOf("no owned active-generation evidence", nextIteration);
  expect(boundary).toBeGreaterThan(0);
  expect(probe).toBeGreaterThan(boundary);
  expect(preserved).toBeGreaterThan(probe);
  expect(deferred).toBeGreaterThan(preserved);
  expect(nextIteration).toBeGreaterThan(deferred);
  expect(failure).toBeGreaterThan(nextIteration);
  expect(source.slice(probe, failure)).not.toMatch(/(?:sendAttachedPrompt|onSubmitted|emitBrowserCompletion)\(/);
});

test("grouped assistant projection uses its stable turn key instead of a nested :has locator", async () => {
  let observedSelector = "";
  let invokedOriginalLocator = false;
  const fakePage = {
    isClosed: () => false,
    evaluate: async () => ({
      ownerPresent: true, assistantPresent: true, stopVisible: true,
      completionActionVisible: false, assistantTextChars: 22,
      visibleStopCount: 1, activeAssistantGroupCount: 1, userBubbleCount: 1,
    }),
    locator: (selector: string) => {
      observedSelector = selector;
      return {
        evaluate: async () => ({
          key: "owned:unchanged",
          snapshot: {
            responsePresent: true, visibleText: "", fullHtml: "", markdownSegments: [],
            completionActionVisible: false, stoppedThinkingVisible: false, traceBlocks: [],
          },
        }),
        page: () => fakePage,
      };
    },
  };
  const strictLocator = {
    evaluate: async () => { invokedOriginalLocator = true; throw new Error("slow nested :has selector used"); },
    page: () => fakePage,
  };
  const worker = Object.create(require("../src/adapters/chatgpt-web/browser-worker").ChatGptBrowserWorker.prototype);
  const snapshot = await worker.responseDomSnapshot(strictLocator, {}, "group:assistant:accepted-01");
  expect(snapshot.responsePresent).toBe(true);
  expect(invokedOriginalLocator).toBe(false);
  expect(observedSelector).toBe('[data-turn-key="accepted-01"]');
  expect(observedSelector).not.toContain(":has");
});

test("two production-style transient Activity groups keep a proven Send pending without claiming their text", async () => {
  const detached = await probeChatGptOwnedTurnLiveness(
    probeFixture({ owner: false, detachedAssistant: true }),
    "group:assistant:accepted-01",
  );
  expect(detached).toMatchObject({
    ownerPresent: false,
    assistantPresent: false,
    visibleStopCount: 1,
    activeAssistantGroupCount: 1,
    userBubbleCount: 0,
  });
  expect(chatGptOwnedTurnStillGenerating(detached)).toBe(false);
  expect(chatGptDetachedAcceptedTurnMayStillBeRunning(detached)).toBe(true);
  // Same visible Stop with no assistant group, multiple assistant groups, or
  // hidden Stop never proves a unique potentially continuing generation.
  expect(chatGptDetachedAcceptedTurnMayStillBeRunning(
    await probeChatGptOwnedTurnLiveness(probeFixture({ owner: false }), "group:assistant:accepted-01"),
  )).toBe(false);
  expect(chatGptDetachedAcceptedTurnMayStillBeRunning(
    await probeChatGptOwnedTurnLiveness(
      probeFixture({ owner: false, detachedAssistant: true, stop: false }),
      "group:assistant:accepted-01",
    ),
  )).toBe(false);
});

test("accepted user key prevents binding a remounted unrelated assistant", () => {
  expect(chatGptAssistantBelongsToAcceptedUser(
    "group:assistant:accepted-01", "group:user:accepted-01",
  )).toBe(true);
  expect(chatGptAssistantBelongsToAcceptedUser(
    "group:assistant:temporary-02", "group:user:accepted-01",
  )).toBe(false);
});

test("detached active response handling runs before unverified rebinding", () => {
  const source = require("node:fs").readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8") as string;
  const pending = source.indexOf("response_binding_detached_pending");
  const gate = source.lastIndexOf("if (!snapshot.responsePresent) {", pending);
  const reconcile = source.indexOf("this.reconcileAssistantTurnBinding(", pending);
  expect(pending).toBeGreaterThan(gate);
  expect(reconcile).toBeGreaterThan(pending);
  expect(source).toContain("response_binding_pending_user_proof");
  expect(source).toContain("response_binding_waiting_for_accepted_user_group");
});

test("generation-running receipt cannot claim an unpaired remounted assistant", () => {
  expect(chatGptAssistantHasUserGroupEvidence(
    "group:assistant:old-completed-answer", undefined,
  )).toBe(false);
  expect(chatGptAssistantHasUserGroupEvidence(
    "group:assistant:old-completed-answer", "group:user:new-accepted-send",
  )).toBe(false);
  expect(chatGptAssistantHasUserGroupEvidence(
    "group:assistant:new-accepted-send", "group:user:new-accepted-send",
  )).toBe(true);
  expect(chatGptAssistantHasUserGroupEvidence("legacy-assistant-turn", undefined)).toBe(true);
  expect(chatGptAssistantHasUserGroupEvidence(
    "group:assistant:new-accepted-send", "legacy-user-turn",
  )).toBe(false);
});
