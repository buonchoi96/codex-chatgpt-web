import { expect, test } from "bun:test";
import {
  ChatGptMessageDeliveryTimeoutGrace,
  CHATGPT_MESSAGE_DELIVERY_TIMEOUT_GRACE_MS,
} from "../src/adapters/chatgpt-web/browser-worker";

const base = {
  alertVisible: true,
  visibleText: "still generating",
  traceBlocks: [] as Array<{ kind: "status" | "commentary"; text: string; activity?: boolean }>,
  nativeToolCallsInFlight: false,
};

test("red delivery error waits exactly sixty seconds of semantic silence", () => {
  const grace = new ChatGptMessageDeliveryTimeoutGrace();
  expect(CHATGPT_MESSAGE_DELIVERY_TIMEOUT_GRACE_MS).toBe(60_000);
  expect(grace.update(base, 1_000)).toBe(false);
  expect(grace.update(base, 60_999)).toBe(false);
  expect(grace.update(base, 61_000)).toBe(true);
});

test("visible progress, native progress and an active tool keep a delivery-failed turn alive", () => {
  const grace = new ChatGptMessageDeliveryTimeoutGrace();
  expect(grace.update(base, 1_000)).toBe(false);
  expect(grace.update({ ...base, nativeToolCallsInFlight: true }, 900_000)).toBe(false);
  expect(grace.update({ ...base, nativeLastProgressAt: 900_000 }, 900_000)).toBe(false);
  expect(grace.update({ ...base, traceBlocks: [{ kind: "commentary", text: "Investigating" }] }, 1_100_000)).toBe(false);
  expect(grace.update({ ...base, traceBlocks: [{ kind: "commentary", text: "Investigating" }] }, 1_159_999)).toBe(false);
  expect(grace.update({ ...base, traceBlocks: [{ kind: "commentary", text: "Investigating" }] }, 1_160_000)).toBe(true);
});

test("normal UI and a subsequent delivery timeout do not share an expired watchdog budget", () => {
  const grace = new ChatGptMessageDeliveryTimeoutGrace();
  expect(grace.update(base, 1_000)).toBe(false);
  expect(grace.update({ ...base, alertVisible: false }, 500_000)).toBe(false);
  expect(grace.update(base, 600_000)).toBe(false);
  expect(grace.update(base, 659_999)).toBe(false);
  expect(grace.update(base, 660_000)).toBe(true);
});
