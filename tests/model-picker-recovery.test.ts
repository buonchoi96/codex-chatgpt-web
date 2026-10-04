import { expect, test } from "bun:test";
import { retryTransientChatGptModelControlSelection } from "../src/adapters/chatgpt-web/browser-worker";

const unavailable = "ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.";

test("transient model picker failure is retried exactly once before Send", async () => {
  let attempts = 0;
  let recoveries = 0;
  const value = await retryTransientChatGptModelControlSelection(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(unavailable, { cause: new Error("surface changed during confirmation") });
      return "selected";
    },
    async () => { recoveries += 1; },
  );
  expect(value).toBe("selected");
  expect(attempts).toBe(2);
  expect(recoveries).toBe(1);
});

test("persistent model picker failure is not retried more than once", async () => {
  let attempts = 0;
  let recoveries = 0;
  await expect(retryTransientChatGptModelControlSelection(
    async () => {
      attempts += 1;
      throw new Error(unavailable);
    },
    async () => { recoveries += 1; },
  )).rejects.toThrow(unavailable);
  expect(attempts).toBe(2);
  expect(recoveries).toBe(1);
});

test("non-picker failures bypass picker recovery", async () => {
  let recoveries = 0;
  await expect(retryTransientChatGptModelControlSelection(
    async () => { throw new Error("session expired"); },
    async () => { recoveries += 1; },
  )).rejects.toThrow("session expired");
  expect(recoveries).toBe(0);
});
