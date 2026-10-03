import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

test.each(["mutation", "fallback"])("response wakeup cleans its DOM observer and timers on %s", async kind => {
  let observer!: { callback: () => void; disconnected: boolean };
  const timers = new Map<number, {callback: () => void; delay: number}>();
  let nextTimer = 0;
  const page = { evaluate(fn: Function, options: unknown) {
    return runInNewContext(`(${fn.toString()})`, {
      document: {documentElement: {}},
      MutationObserver: class {
        disconnected = false;
        constructor(public callback: () => void) { observer = this; }
        observe() {}
        disconnect() { this.disconnected = true; }
      },
      setTimeout(callback: () => void, delay: number) { const id = ++nextTimer; timers.set(id, {callback, delay}); return id; },
      clearTimeout(id: number) { timers.delete(id); },
    })(options);
  } };
  const worker = Object.create(ChatGptBrowserWorker.prototype);
  const done = worker.waitForTurnDomMutation(page, 250);
  expect([...timers.values()].map(t => t.delay)).toEqual([250]);
  if (kind === "mutation") {
    observer.callback(); observer.callback();
    expect([...timers.values()].map(t => t.delay)).toEqual([250, 16]);
    [...timers.values()].find(t => t.delay === 16)!.callback();
  } else [...timers.values()][0]!.callback();
  await done;
  expect(observer.disconnected).toBeTrue();
  expect(timers.size).toBe(0);
});

test("response wakeup aborts its external progress listener when DOM state arrives", async () => {
  let resolveDom!: () => void;
  let progressSignal!: AbortSignal;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    waitForTurnDomMutation: (_page: unknown, budget: number) => {
      expect(budget).toBe(250);
      return new Promise<void>(resolve => { resolveDom = resolve; });
    },
  });
  const progress = {waitForChange: (_revision: number, signal: AbortSignal) => {
    progressSignal = signal;
    return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
  }};
  const done = worker.waitForTurnDomOrExternalProgress({}, 7, progress, undefined, 250);
  resolveDom();
  await done;
  expect(progressSignal.aborted).toBeTrue();
});
