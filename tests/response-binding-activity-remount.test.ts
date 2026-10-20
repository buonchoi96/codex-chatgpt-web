import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

type State = {
  userTurnCount: number;
  assistantTurnCount: number;
  visibleStopButtonCount: number;
  turnIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
};

/**
 * Execute the real waitForNewAssistantTurn method, not just a source-text
 * assertion. DOM reads are deterministic fixtures to cover an Activity
 * remount without using a logged-in ChatGPT tab or issuing a Send.
 */
function harness(states: State[]) {
  const selectors: string[] = [];
  let polls = 0;
  let consumed = 0;
  const locator = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => false,
  };
  const page = {
    isClosed: () => false,
    locator: (selector: string) => {
      selectors.push(selector);
      return locator;
    },
  } as unknown as Page;
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  worker.submissionDomState = async () => states[Math.min(consumed++, states.length - 1)]!;
  worker.waitForTurnDomOrExternalProgress = async () => { polls += 1; };
  const generation = { active: () => true, progress: () => {} };
  const baseline = {
    initialTurnIdentities: ["group:user:old-00", "group:assistant:old-00"],
    domCache: {},
    acknowledgedStages: [],
  };
  const wait = (acceptedUserIdentity?: string) => worker.waitForNewAssistantTurn(
    page, { ...baseline, acceptedUserIdentity },
    Date.now() + 500,
    undefined, undefined, 60_000, undefined, undefined, generation,
  ) as Promise<{ identity: string }>;
  return { wait, selectors, get polls() { return polls; }, get consumed() { return consumed; } };
}

const state = (assistantKey: string, userKey?: string): State => ({
  userTurnCount: userKey ? 1 : 0,
  assistantTurnCount: 1,
  visibleStopButtonCount: 1,
  userIdentities: userKey ? [`group:user:${userKey}`] : [],
  responseIdentities: [`group:assistant:${assistantKey}`],
  turnIdentities: [`group:user:${assistantKey}`, `group:assistant:${assistantKey}`],
});

test("waitForNewAssistantTurn ignores an older remounted assistant until accepted user key matches", async () => {
  const sample = harness([
    state("old-foreign-01"),
    state("accepted-01", "accepted-01"),
  ]);
  const selected = await sample.wait("group:user:accepted-01");
  expect(selected.identity).toBe("group:assistant:accepted-01");
  expect(sample.polls).toBe(1);
  expect(sample.consumed).toBe(2);
  expect(sample.selectors.at(-1)).toContain('[data-turn-key="accepted-01"]');
});

test("generation-running receipt alone never binds an assistant without paired user evidence", async () => {
  const sample = harness([
    state("stale-virtualized"),
    state("accepted-02", "accepted-02"),
  ]);
  const selected = await sample.wait();
  expect(selected.identity).toBe("group:assistant:accepted-02");
  expect(sample.polls).toBe(1);
  expect(sample.consumed).toBe(2);
});
