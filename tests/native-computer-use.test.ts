import { expect, test } from "bun:test";
import { computerUseProgram } from "../src/adapters/chatgpt-web/native-computer-use";

function runtime() {
  const context: Record<string, any> = {};
  let imports = 0, windows = 0, observations = 0, activates = 0, types = 0;
  let stale = false, locked = false;
  const calls: unknown[] = [];
  const sky = {
    async list_apps() { return [{ id: "notepad", windows: [{ id: 42, app: "notepad" }] }]; },
    async list_windows() { windows++; return []; },
    async get_window(input: any) { windows++; return { id: input.id, app: input.app }; },
    async get_window_state(input: any) { observations++; calls.push(input); if (stale) throw new Error("stale window reference"); return { window: input.window, accessibility: { text: "marker" } }; },
    async activate_window() { activates++; if (locked) throw new Error("cannot confirm desktop is unlocked: no foreground window"); },
    async type_text() { if (locked) throw new Error("cannot confirm desktop is unlocked: no foreground window"); types++; },
  };
  const execute = async (program: string) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction("globalThis", "loadSky", "nodeRepl", program.replace('import("@oai/sky")', "loadSky()"))(
      context, async () => { imports++; return { sky }; }, { write: (value: unknown) => calls.push(value) },
    );
  };
  return { execute, calls, context, counters: () => ({ imports, windows, observations, activates, types }), stale: () => { stale = true; }, locked: () => { locked = true; } };
}

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
