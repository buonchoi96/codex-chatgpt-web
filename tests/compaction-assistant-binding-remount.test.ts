import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

// The renderer may remount an accepted user bubble before the assistant role.
// The broker token proves the bubble is ours; a foreign user must still fail.
function fixture(verified: boolean) {
  const old = ["group:user:previous", "group:assistant:previous"];
  const accepted = "group:user:accepted-123";
  const oldBinding = "group:assistant:temporary-123";
  const acceptedAssistant = "group:assistant:accepted-123";
  let state = {
    turnIdentities: [...old, accepted],
    userIdentities: [old[0]!, accepted],
    responseIdentities: [old[1]!],
  };
  const inspected: string[] = [];
  const page = {
    locator: (selector: string) => {
      inspected.push(selector);
      return { count: async () => 0 };
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    submissionDomState: async () => state,
    reconcileMultipartHistory: async () => {},
    userMessageMatchesSubmission: async (_locator: unknown, text: string, _signal: unknown, token: string) => {
      expect(text).toBe("original submitted turn_abcdefghijklmnopqrstuvwxyz012345");
      expect(token).toBe("turn_abcdefghijklmnopqrstuvwxyz012345");
      return verified;
    },
    submittedUserMatches: async () => { throw new Error("must use token proof"); },
  }) as any;
  const baseline = {
    initialTurnIdentities: [...old], domCache: {}, acknowledgedStages: [],
    submittedText: "original submitted turn_abcdefghijklmnopqrstuvwxyz012345",
    turnToken: "turn_abcdefghijklmnopqrstuvwxyz012345",
  };
  const binding = {
    identity: oldBinding,
    locator: { count: async () => 0 },
    acceptedTurnIdentities: [...old, oldBinding],
  };
  return {
    worker, page, baseline, binding, inspected,
    mountAssistant() {
      state = { turnIdentities: [...old, accepted, acceptedAssistant],
        userIdentities: [old[0]!, accepted], responseIdentities: [old[1]!, acceptedAssistant] };
    },
  };
}

test("manual compact keeps a proven original user bubble pending until its assistant role remounts", async () => {
  const f = fixture(true);
  const pending = await f.worker.reconcileAssistantTurnBinding(f.page, f.baseline, f.binding);
  expect(pending).toBe(f.binding);
  expect(f.baseline).toMatchObject({ acceptedUserIdentity: "group:user:accepted-123" });
  expect(f.inspected).toContain('[data-turn-key="accepted-123"]');
  f.mountAssistant();
  const rebound = await f.worker.reconcileAssistantTurnBinding(f.page, f.baseline, f.binding);
  expect(rebound.identity).toBe("group:assistant:accepted-123");
});

test("a different user bubble still cannot take ownership of a detached assistant", async () => {
  const f = fixture(false);
  await expect(f.worker.reconcileAssistantTurnBinding(f.page, f.baseline, f.binding))
    .rejects.toThrow("ChatGPT opened another user turn while the bound assistant response was detached");
  expect(f.baseline.acceptedUserIdentity).toBeUndefined();
});
