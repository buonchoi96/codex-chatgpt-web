import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { throwIfChatGptSessionFailureAlert } from "../src/adapters/chatgpt-web/browser-worker";

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(subscriptionThrows = false) {
  const expired = deferred(), subscription = deferred();
  const started: string[] = [];
  const page = { locator() { return { filter({hasText}: {hasText: RegExp}) {
    const kind = hasText.test("Your session has expired") ? "expired" : "subscription";
    return { last() { return { isVisible() {
      started.push(kind);
      if (kind === "subscription" && subscriptionThrows) throw new Error("subscription construction failed");
      return kind === "expired" ? expired.promise : subscription.promise;
    } }; } };
  } }; } } as unknown as Page;
  return {page, expired, subscription, started};
}

test("independent session probes overlap while expiry remains the first verdict", async () => {
  for (const expires of [true, false]) {
    const f = fixture();
    let settled = false;
    const result = throwIfChatGptSessionFailureAlert(f.page).catch(error => error).finally(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(f.started).toEqual(["expired", "subscription"]);
    f.subscription.resolve(true);
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBeFalse();
    f.expired.resolve(expires);
    expect(await result).toMatchObject({status: expires ? 401 : 503, retryable: !expires});
  }
});

test("expiry never waits for a stalled speculative subscription probe", async () => {
  const f = fixture();
  const result = throwIfChatGptSessionFailureAlert(f.page).catch(error => error);
  f.expired.resolve(true);
  expect(await result).toMatchObject({status: 401});
});

test("visibility rejections stay suppressed and speculative synchronous errors retain priority", async () => {
  const f = fixture();
  const result = throwIfChatGptSessionFailureAlert(f.page);
  await Promise.resolve(); await Promise.resolve();
  f.expired.reject(new Error("expired read failed"));
  f.subscription.reject(new Error("subscription read failed"));
  await expect(result).resolves.toBeUndefined();
  for (const expires of [true, false]) {
    const f = fixture(true);
    const result = throwIfChatGptSessionFailureAlert(f.page).catch(error => error);
    f.expired.resolve(expires);
    if (expires) expect(await result).toMatchObject({status: 401});
    else expect((await result).message).toBe("subscription construction failed");
  }
});
