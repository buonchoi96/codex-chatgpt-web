import { expect, test } from "bun:test";
import { SameTabRecovery, type RecoveryObservation } from "../src/adapters/chatgpt-web/same-tab-recovery";

test("same-tab recovery verifies Stop and preserves receipts without replaying the original task", async () => {
  const states: string[] = [], calls: string[] = [];
  const observation: RecoveryObservation = { owned: true, revision: 5, activeTools: 0, approvalPending: false,
    safetyBlocked: false, stopVisible: true, composerReady: false };
  const recovery = new SameTabRecovery(state => states.push(state));
  const result = await recovery.recover({ observe: async () => ({ ...observation }),
    stop: async () => { calls.push("stop"); observation.stopVisible = false; observation.composerReady = true; },
    submit: async () => { calls.push("continue"); } });
  expect(result).toBe(true);
  expect(calls).toEqual(["stop", "continue"]);
  expect(states).toEqual(["STALL_SUSPECTED", "STALL_VERIFIED", "STOP_REQUESTED", "STOP_CONFIRMED",
    "RESUME_PREPARED", "RESUME_SUBMITTED", "RESUMED"]);
  recovery.complete();
  expect(states.at(-1)).toBe("COMPLETED");
});

test("native activity, approval, ownership loss, refusal, stop failure and new receipts block recovery", async () => {
  for (const change of [{ activeTools: 1 }, { approvalPending: true }, { owned: false }, { safetyBlocked: true },
    { composerReady: false }]) {
    let calls = 0;
    const recovery = new SameTabRecovery();
    const observation: RecoveryObservation = { owned: true, revision: 5, activeTools: 0, approvalPending: false,
      safetyBlocked: false, stopVisible: false, composerReady: true, ...change };
    expect(await recovery.recover({ observe: async () => observation, stop: async () => { calls++; },
      submit: async () => { calls++; } })).toBe(false);
    expect(calls).toBe(0);
  }
  let revision = 5, submitted = false;
  const recovery = new SameTabRecovery();
  expect(await recovery.recover({ observe: async () => ({ owned: true, revision, activeTools: 0,
    approvalPending: false, safetyBlocked: false, stopVisible: revision === 5, composerReady: revision > 5 }),
    stop: async () => { revision++; }, submit: async () => { submitted = true; } })).toBe(false);
  expect(submitted).toBe(false);
  expect(recovery.state).toBe("WAITING_FOR_TOOL");
});

test("same-tab automatic recovery is bounded and never retries an ambiguous send", async () => {
  const recovery = new SameTabRecovery(), observe = async () => ({ owned: true, revision: 0, activeTools: 0,
    approvalPending: false, safetyBlocked: false, stopVisible: false, composerReady: true });
  let sends = 0;
  for (let i = 0; i < 2; i++) expect(await recovery.recover({ observe, stop: async () => {}, submit: async () => { sends++; } })).toBe(true);
  expect(await recovery.recover({ observe, stop: async () => {}, submit: async () => { sends++; } })).toBe(false);
  expect(sends).toBe(2);
  expect(recovery.state).toBe("USER_ACTION_REQUIRED");
  const failed = new SameTabRecovery();
  await expect(failed.recover({ observe, stop: async () => {}, submit: async () => { throw new Error("accepted send disconnected"); } })).rejects.toThrow("accepted send disconnected");
  expect(failed.state).toBe("RECOVERY_UNSAFE");
  expect(await failed.recover({ observe, stop: async () => {}, submit: async () => { sends++; } })).toBe(false);
  expect(sends).toBe(2);
});

test("a refusal remains terminal when its UI message disappears", async () => {
  const recovery = new SameTabRecovery();
  let safetyBlocked = true, sends = 0;
  const actions = { observe: async () => ({ owned: true, revision: 0, activeTools: 0,
    approvalPending: false, safetyBlocked, stopVisible: false, composerReady: true }),
    stop: async () => {}, submit: async () => { sends++; } };
  expect(await recovery.recover(actions)).toBe(false);
  safetyBlocked = false;
  expect(await recovery.recover(actions)).toBe(false);
  expect(sends).toBe(0);
});
