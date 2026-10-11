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

test("delivery timeout waits five minutes after the banner instead of retiring the turn immediately", () => {
  const grace = new ChatGptMessageDeliveryTimeoutGrace();
  expect(CHATGPT_MESSAGE_DELIVERY_TIMEOUT_GRACE_MS).toBe(300_000);
  expect(grace.update(base, 1_000)).toBe(false);
  expect(grace.update(base, 300_999)).toBe(false);
  expect(grace.update(base, 301_000)).toBe(true);
});

test("visible progress, native progress and an active tool keep a delivery-failed turn alive", () => {
  const grace = new ChatGptMessageDeliveryTimeoutGrace();
  expect(grace.update(base, 1_000)).toBe(false);
  expect(grace.update({ ...base, nativeToolCallsInFlight: true }, 900_000)).toBe(false);
  expect(grace.update({ ...base, nativeLastProgressAt: 900_000 }, 900_000)).toBe(false);
  expect(grace.update({ ...base, traceBlocks: [{ kind: "commentary", text: "Investigating" }] }, 1_100_000)).toBe(false);
  expect(grace.update({ ...base, traceBlocks: [{ kind: "commentary", text: "Investigating" }] }, 1_399_999)).toBe(false);
  expect(grace.update({ ...base, traceBlocks: [{ kind: "commentary", text: "Investigating" }] }, 1_400_000)).toBe(true);
});

test("normal UI and a subsequent delivery timeout do not share an expired watchdog budget", () => {
  const grace = new ChatGptMessageDeliveryTimeoutGrace();
  expect(grace.update(base, 1_000)).toBe(false);
  expect(grace.update({ ...base, alertVisible: false }, 500_000)).toBe(false);
  expect(grace.update(base, 600_000)).toBe(false);
  expect(grace.update(base, 899_999)).toBe(false);
  expect(grace.update(base, 900_000)).toBe(true);
});
