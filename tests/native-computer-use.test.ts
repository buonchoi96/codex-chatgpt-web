import { expect, test } from "bun:test";
import { computerUseProgram } from "../src/adapters/chatgpt-web/native-computer-use";

function runtime() {
  const context: Record<string, any> = {};
  let imports = 0, windows = 0, observations = 0, activates = 0, types = 0;
  let stale = false, locked = false;
  let state: any = { window: { id: 42, app: "notepad" }, screenshots: [], accessibility: { tree: "0 Edit marker", document_text: "marker", focused_element: "0 Edit" } };
  let failure: string | undefined;
  let captureHook: (() => Promise<void>) | undefined;
  let importHook: (() => Promise<void>) | undefined;
  const calls: unknown[] = [];
  const outputs: any[] = [];
  const sky = {
    async list_apps() { return [{ id: "notepad", windows: [{ id: 42, app: "notepad" }] }]; },
    async list_windows() { windows++; return []; },
    async get_window(input: any) { windows++; return { id: input.id, app: input.app }; },
    async get_window_state(input: any) { observations++; calls.push(input); if (stale) throw new Error("stale window reference"); if (failure) throw new Error(failure); const value = state; await captureHook?.(); return value; },
    async activate_window() { activates++; if (locked) throw new Error("cannot confirm desktop is unlocked: no foreground window"); },
    async type_text() { if (locked) throw new Error("cannot confirm desktop is unlocked: no foreground window"); types++; },
  };
  const execute = async (program: string) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction("globalThis", "loadSky", "nodeRepl", program.replace('import("@oai/sky")', "loadSky()"))(
      context, async () => { imports++; await importHook?.(); return { sky }; }, { write: (value: unknown) => { calls.push(value); outputs.push(typeof value === "string" ? JSON.parse(value) : value); } },
    );
  };
  return { execute, calls, outputs, context, sky, importHook: (hook: () => Promise<void>) => { importHook = hook; }, captureHook: (hook: () => Promise<void>) => { captureHook = hook; }, state: (value: any) => { state = value; }, fail: (value?: string) => { failure = value; }, counters: () => ({ imports, windows, observations, activates, types }), stale: () => { stale = true; }, locked: () => { locked = true; } };
}

const target = { id: 42, app: "notepad" };
const observe = (knownObservationId?: string) => computerUseProgram({ operation: "window_state", window: target, ...(knownObservationId ? { knownObservationId } : {}) } as any);

test("a delayed native import cannot overwrite a newer registry generation", async () => {
  const r = runtime();
  let releaseImport!: () => void, enteredImport!: () => void;
  const entered = new Promise<void>(resolve => { enteredImport = resolve; });
  const blocked = new Promise<void>(resolve => { releaseImport = resolve; });
  let first = true;
  r.importHook(async () => { if (first) { first = false; enteredImport(); await blocked; } });
  const old = r.execute(computerUseProgram({ operation: "list_apps" }, "old")).catch(error => error);
  await entered;
  await r.execute(computerUseProgram({ operation: "list_apps" }, "new"));
  releaseImport();
  expect(await old).toBeInstanceOf(Error);
  expect((await old).message).toContain("invalidated");
  expect(r.context.__codexBridgeSkyV2.generation).toBe("new");
  expect(r.outputs).toHaveLength(1);
});

test("concurrent discovery shares initialization within the same registry generation", async () => {
  const r = runtime();
  await Promise.all([r.execute(computerUseProgram({ operation: "list_apps" }, "same")),
    r.execute(computerUseProgram({ operation: "list_apps" }, "same"))]);
  expect(r.counters().imports).toBe(1);
  expect(r.outputs).toHaveLength(2);
});

test("repeat observations require fresh native evidence and an acknowledged ID before omitting state", async () => {
  const r = runtime();
  await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(observe()); const first = r.outputs.at(-1);
  expect(first.observation).toMatchObject({ revision: 1, unchanged: false, cacheHit: false, evidence: "fresh_native_accessibility", scope: "window_accessibility" });
  expect(first.observation.hash).toMatch(/^[a-f0-9]{64}$/);
  await r.execute(observe()); const full = r.outputs.at(-1);
  expect(full.accessibility.document_text).toBe("marker");
  expect(full.observation.id).toBe(first.observation.id);
  expect(full.observation.unchanged).toBe(true);
  await r.execute(observe(first.observation.id)); const compact = r.outputs.at(-1);
  expect(compact.accessibility).toBeUndefined();
  expect(compact.observation).toMatchObject({ id: first.observation.id, revision: 1, unchanged: true, cacheHit: true });
  expect(r.counters().observations).toBe(3);
});

test("native actions report revisions without counting read-only calls or error invalidations as actions", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(observe());
  expect(r.outputs.at(-1).observation.actionRevision).toBe(0);
  await r.execute(computerUseProgram({ operation: "type_text", window: target, text: "marker" }));
  expect(r.outputs.at(-1).actionRevision).toBe(1);
  await r.execute(observe());
  expect(r.outputs.at(-1).observation).toMatchObject({ actionRevision: 1, stateRevision: 2 });
  r.locked();
  await expect(r.execute(computerUseProgram({ operation: "activate_window", window: target }))).rejects.toThrow("no foreground");
  await r.execute(observe());
  expect(r.outputs.at(-1).observation).toMatchObject({ actionRevision: 2, stateRevision: 3, cacheHit: false });
});

test("activation and structured observation form a fixed sequence with one binding and no intermediate success", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(computerUseProgram({ operation: "activate_and_observe", window: target } as any));
  expect(r.counters()).toEqual({ imports: 1, windows: 1, observations: 1, activates: 1, types: 0 });
  expect(r.outputs).toHaveLength(2);
  expect(r.outputs.at(-1)).toMatchObject({ completed: true, operation: "activate_and_observe", accessibility: { document_text: "marker" }, observation: { actionRevision: 1, unchanged: false } });
});

test("finite sequence stops at foreground rejection and checks both native capabilities before acting", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" })); r.locked();
  const sequence = computerUseProgram({ operation: "activate_and_observe", window: target } as any);
  await expect(r.execute(sequence)).rejects.toThrow("no foreground");
  expect(r.counters()).toEqual({ imports: 1, windows: 1, observations: 0, activates: 1, types: 0 });
  expect(r.outputs).toHaveLength(1);
  const unsupported = runtime(); await unsupported.execute(computerUseProgram({ operation: "list_apps" }));
  (unsupported.sky as any).get_window_state = undefined;
  await expect(unsupported.execute(sequence)).rejects.toThrow("capabilities");
  expect(unsupported.counters().activates).toBe(0);
});

test("finite sequence capture failure never reports completion or retries activation", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" })); r.fail("native capture failed");
  await expect(r.execute(computerUseProgram({ operation: "activate_and_observe", window: target } as any))).rejects.toThrow("capture failed");
  expect(r.counters().activates).toBe(1); expect(r.counters().observations).toBe(1);
  expect(r.outputs).toHaveLength(1);
});

test("a mutation during native capture rejects its stale result and publishes no observation", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }));
  r.captureHook(async () => { await r.execute(computerUseProgram({ operation: "type_text", window: target, text: "external" })); });
  await expect(r.execute(observe())).rejects.toThrow("invalidated");
  expect(r.outputs).toHaveLength(2);
  expect(r.outputs.at(-1).operation).toBe("type_text");
});

test("generation replacement during capture rejects the old session result", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }, "first"));
  r.captureHook(async () => { await r.execute(computerUseProgram({ operation: "list_apps" }, "second")); });
  await expect(r.execute(computerUseProgram({ operation: "window_state", window: target }, "first"))).rejects.toThrow("invalidated");
  expect(r.outputs).toHaveLength(2);
  expect(r.outputs.at(-1)).toEqual([{ id: "notepad", windows: [target] }]);
  r.captureHook(async () => {});
  await r.execute(computerUseProgram({ operation: "window_state", window: target }, "second"));
  expect(r.outputs.at(-1).observation).toMatchObject({ stateRevision: 1, actionRevision: 0, cacheHit: false });
});

test("generation replacement during window lookup prevents stale-session native input", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }, "first"));
  const originalLookup = r.sky.get_window;
  r.sky.get_window = async input => {
    const window = await originalLookup(input);
    await r.execute(computerUseProgram({ operation: "list_apps" }, "second"));
    return window;
  };
  await expect(r.execute(computerUseProgram({ operation: "type_text", window: target, text: "marker" }, "first"))).rejects.toThrow("invalidated");
  expect(r.counters().types).toBe(0);
  expect(r.outputs).toHaveLength(2);
});

test("a connection failure from an old call cannot retire the replacement native session", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }, "first"));
  r.sky.get_window_state = async () => {
    await r.execute(computerUseProgram({ operation: "list_apps" }, "second"));
    throw new Error("connection lost");
  };
  await expect(r.execute(computerUseProgram({ operation: "window_state", window: target }, "first"))).rejects.toThrow("connection lost");
  expect(r.context.__codexBridgeSkyV2.generation).toBe("second");
  r.sky.get_window_state = async input => ({ window: input.window, screenshots: [], accessibility: { tree: "0 Edit", document_text: "fresh" } });
  await r.execute(computerUseProgram({ operation: "window_state", window: target }, "second"));
  expect(r.outputs.at(-1).accessibility.document_text).toBe("fresh");
  expect(r.counters().imports).toBe(2);
});

test("manual document and focus changes create new revisions even without bridge actions", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(observe()); const first = r.outputs.at(-1);
  r.state({ window: target, screenshots: [], accessibility: { tree: "0 Edit marker", document_text: "manual edit", focused_element: "0 Edit" } });
  await r.execute(observe(first.observation.id)); const second = r.outputs.at(-1);
  expect(second.accessibility.document_text).toBe("manual edit");
  expect(second.observation).toMatchObject({ revision: 2, unchanged: false, cacheHit: false });
  expect(second.observation.hash).not.toBe(first.observation.hash);
  r.state({ window: target, screenshots: [], accessibility: { tree: "0 Edit marker", document_text: "manual edit", focused_element: "1 Button" } });
  await r.execute(observe(second.observation.id));
  expect(r.outputs.at(-1).observation.revision).toBe(3);
});

test("mutations and all observation errors invalidate prior equality without action retries", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(observe()); let previous = r.outputs.at(-1).observation;
  await r.execute(computerUseProgram({ operation: "type_text", window: target, text: "marker" }));
  await r.execute(observe(previous.id));
  expect(r.outputs.at(-1).observation.unchanged).toBe(false);
  previous = r.outputs.at(-1).observation;
  r.fail("native capture failed"); await expect(r.execute(observe(previous.id))).rejects.toThrow("capture failed");
  r.fail(); await r.execute(observe(previous.id));
  expect(r.outputs.at(-1).observation.unchanged).toBe(false);
  expect(r.counters().types).toBe(1);
  expect(r.counters().observations).toBe(4);
});

test("missing accessibility never proves an unchanged screen or returns a cached screenshot", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }));
  r.state({ window: target, screenshots: [], accessibility: null });
  await r.execute(observe()); const first = r.outputs.at(-1);
  await r.execute(observe(first.observation.id));
  expect(r.outputs.at(-1)).toMatchObject({ accessibility: null, observation: { unchanged: false, cacheHit: false, evidence: "unavailable" } });
  expect(r.calls).toContainEqual({ window: target, include_screenshot: false, include_text: true });
});

test("state identity mismatch fails closed and requires native enumeration again", async () => {
  const r = runtime(); await r.execute(computerUseProgram({ operation: "list_apps" }));
  r.state({ window: { id: 43, app: "notepad" }, screenshots: [], accessibility: { tree: "0 Edit" } });
  await expect(r.execute(observe())).rejects.toThrow("identity changed");
  await expect(r.execute(computerUseProgram({ operation: "type_text", window: target, text: "marker" }))).rejects.toThrow("observed");
  expect(r.counters().types).toBe(0);
});

test("read-only observations reuse module/window identity without screenshots or activation", async () => {
  const r = runtime();
  await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(computerUseProgram({ operation: "window_state", window: { id: 42, app: "notepad" } }));
  await r.execute(computerUseProgram({ operation: "window_state", window: { id: 42, app: "notepad" } }));
  expect(r.counters()).toEqual({ imports: 1, windows: 1, observations: 2, activates: 0, types: 0 });
  expect(r.calls).toContainEqual({ window: { id: 42, app: "notepad" }, include_screenshot: false, include_text: true });
});

test("stale references invalidate window bindings but never repeat the failed operation", async () => {
  const r = runtime(); const program = computerUseProgram({ operation: "window_state", window: { id: 42, app: "notepad" } });
  await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(program); r.stale();
  await expect(r.execute(program)).rejects.toThrow("stale window");
  await expect(r.execute(program)).rejects.toThrow("observed");
  expect(r.counters().imports).toBe(1); expect(r.counters().windows).toBe(1);
  expect(r.counters().observations).toBe(2);
});

test("locked or unknown foreground never allows typing or synthetic activation success", async () => {
  const r = runtime(); r.locked();
  await r.execute(computerUseProgram({ operation: "list_apps" }));
  await expect(r.execute(computerUseProgram({ operation: "type_text", window: { id: 42, app: "notepad" }, text: "marker" }))).rejects.toThrow("no foreground window");
  expect(r.counters().types).toBe(0); expect(r.counters().activates).toBe(0);
});

test("targeted input dispatches one native action with no extra activation, observation or retry", async () => {
  const r = runtime();
  await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(computerUseProgram({ operation: "type_text", window: { id: 42, app: "notepad" }, text: "quote'; await unsafe(); //" }));
  expect(r.counters()).toEqual({ imports: 1, windows: 1, observations: 0, activates: 0, types: 1 });
});

test("native session reset rebuilds bindings and observed window closure removes stale identities", async () => {
  const r = runtime(); const observe = computerUseProgram({ operation: "window_state", window: { id: 42, app: "notepad" } });
  await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(observe);
  await r.execute(computerUseProgram({ operation: "list_windows" }));
  await expect(r.execute(observe)).rejects.toThrow("observed");
  expect(r.counters().imports).toBe(1); expect(r.counters().windows).toBe(2);
  delete r.context.__codexBridgeSkyV2;
  await expect(r.execute(observe)).rejects.toThrow("observed");
  expect(r.counters().imports).toBe(2); expect(r.counters().windows).toBe(2);
});

test("unobserved window identities never reach native lookup or input", async () => {
  const r = runtime();
  await expect(r.execute(computerUseProgram({ operation: "type_text", window: { id: 99, app: "notepad" }, text: "marker" }))).rejects.toThrow("observed");
  await r.execute(computerUseProgram({ operation: "list_apps" }));
  await expect(r.execute(computerUseProgram({ operation: "activate_window", window: { id: 42, app: "different-app" } }))).rejects.toThrow("observed");
  expect(r.counters().windows).toBe(0); expect(r.counters().types).toBe(0); expect(r.counters().activates).toBe(0);
});

test("malformed targets and attempts to submit a confirmation are rejected before native dispatch", () => {
  for (const request of [{ operation: "press_key", text: "Enter" }, { operation: "window_state" },
    { operation: "activate_window", window: { id: -1, app: "notepad" } }]) {
    expect(() => computerUseProgram(request as any)).toThrow();
  }
});

test("registry generation change discards observed targets and module bindings", async () => {
  const r = runtime();
  await r.execute(computerUseProgram({ operation: "list_apps" }, "registry-a"));
  await r.execute(computerUseProgram({ operation: "window_state", window: { id: 42, app: "notepad" } }, "registry-a"));
  await expect(r.execute(computerUseProgram({ operation: "type_text", window: { id: 42, app: "notepad" }, text: "marker" }, "registry-b"))).rejects.toThrow("observed");
  expect(r.counters().imports).toBe(2);
  expect(r.counters().types).toBe(0);
});

test("switching native target invalidates earlier observations even when returning to identical state", async () => {
  const r = runtime(); const second = { id: 43, app: "notepad" };
  r.sky.list_apps = async () => [{ id: "notepad", windows: [target, second] }];
  await r.execute(computerUseProgram({ operation: "list_apps" }));
  await r.execute(observe()); const first = r.outputs.at(-1).observation;
  r.state({ window: second, screenshots: [], accessibility: { tree: "0 Edit marker", document_text: "marker" } });
  await r.execute(computerUseProgram({ operation: "window_state", window: second }));
  r.state({ window: target, screenshots: [], accessibility: { tree: "0 Edit marker", document_text: "marker", focused_element: "0 Edit" } });
  await r.execute(observe(first.id));
  expect(r.outputs.at(-1).observation).toMatchObject({ stateRevision: 3, unchanged: false, cacheHit: false, actionRevision: 0 });
});

test("old retained observation IDs cannot match after a native session generation reset", async () => {
  const r = runtime();
  await r.execute(computerUseProgram({ operation: "list_apps" }, "first"));
  await r.execute(computerUseProgram({ operation: "window_state", window: target }, "first"));
  const oldId = r.outputs.at(-1).observation.id;
  await r.execute(computerUseProgram({ operation: "list_apps" }, "second"));
  await r.execute(computerUseProgram({ operation: "window_state", window: target, knownObservationId: oldId }, "second"));
  expect(r.outputs.at(-1).observation).toMatchObject({ stateRevision: 1, actionRevision: 0, unchanged: false, cacheHit: false });
  expect(r.outputs.at(-1).observation.id).not.toBe(oldId);
});

test("malformed repeat IDs and caller-supplied action lists cannot enable arbitrary sequences", () => {
  for (const request of [
    { operation: "window_state", window: target, knownObservationId: "" },
    { operation: "window_state", window: target, knownObservationId: "x".repeat(257) },
    { operation: "type_text", window: target, text: "marker", knownObservationId: "old:1" },
    { operation: "action_sequence", window: target, actions: ["activate_window", "press_key"] },
  ]) expect(() => computerUseProgram(request as any)).toThrow();
});

test("an unobserved sequence target never dispatches an action", async () => {
  const r = runtime();
  await expect(r.execute(computerUseProgram({ operation: "activate_and_observe", window: target }))).rejects.toThrow("observed");
  expect(r.counters()).toEqual({ imports: 1, windows: 0, observations: 0, activates: 0, types: 0 });
});
