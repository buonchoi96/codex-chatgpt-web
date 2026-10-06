import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createComputerObservationEngine } from "../src/adapters/chatgpt-web/computer-observation";
import {
  CHATGPT_NATIVE_MCP_INSTRUCTIONS,
  COMPUTER_USE_FAST_PATH_RULE,
} from "../src/adapters/chatgpt-web/mcp-server";

test("Full Harness advertises a persistent low-latency Computer Use loop", () => {
  expect(COMPUTER_USE_FAST_PATH_RULE).toContain("persistent node_repl/@oai/sky session");
  expect(COMPUTER_USE_FAST_PATH_RULE).toContain("Prefer structured app/window/control state");
  expect(COMPUTER_USE_FAST_PATH_RULE).toContain("Do not re-describe or re-analyze an unchanged screen");
  expect(COMPUTER_USE_FAST_PATH_RULE).toContain("short deterministic sequence of low-risk UI actions");
  expect(CHATGPT_NATIVE_MCP_INSTRUCTIONS).toContain(COMPUTER_USE_FAST_PATH_RULE);

  const mcp = readFileSync("src/adapters/chatgpt-web/mcp-server.ts", "utf8");
  expect(mcp).toContain('name === "mcp__node_repl__js"');
  expect(mcp).toMatch(/browserToolDescription[\s\S]*COMPUTER_USE_FAST_PATH_RULE/);
  expect(mcp).toMatch(/gatewayToolDescription[\s\S]*COMPUTER_USE_FAST_PATH_RULE/);

  const prompt = readFileSync("src/adapters/chatgpt-web/prompt.ts", "utf8");
  expect(prompt).toContain("prefer structured app/window/control information over a fresh screenshot");
  expect(prompt).toContain("Do not re-describe an unchanged screen");
});

const target = { id: 42, app: "notepad" };
const state = (window = target, text = "marker") => ({ window, screenshots: [], accessibility: { tree: "0 Edit", document_text: text, focused_element: "0 Edit" } });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const capture = (engine: ReturnType<typeof createComputerObservationEngine>, value = state(), known?: string) =>
  engine.observe(value.window, value, engine.captureEpoch(), known);

test("observation state revisions stay stable on equality and action revisions count attempted actions", () => {
  const engine = createComputerObservationEngine(digest, "test");
  const first = capture(engine).observation;
  expect(first).toMatchObject({ stateRevision: 1, actionRevision: 0 });
  expect(capture(engine, state(), first.id).observation).toMatchObject({ stateRevision: 1, actionRevision: 0, cacheHit: true });
  engine.recordAction();
  expect(capture(engine, state(), first.id).observation).toMatchObject({ stateRevision: 2, actionRevision: 1, cacheHit: false });
  engine.invalidate();
  expect(capture(engine).observation).toMatchObject({ stateRevision: 3, actionRevision: 1 });
});

test("an invalidated in-flight capture is rejected instead of publishing stale evidence", () => {
  const engine = createComputerObservationEngine(digest, "test");
  const first = capture(engine);
  const started = engine.captureEpoch();
  engine.invalidate();
  expect(() => engine.observe(target, state(), started, first.observation.id)).toThrow("invalidated");
  expect(capture(engine, state(), first.observation.id).observation.cacheHit).toBe(false);
});

test("cache entry limit evicts least recently compared state", () => {
  const engine = createComputerObservationEngine(digest, "test", { maxEntries: 2, maxBytes: 4096, maxEntryBytes: 2048 });
  const a = capture(engine).observation;
  const bTarget = { id: 43, app: "notepad" };
  const b = capture(engine, state(bTarget)).observation;
  expect(capture(engine, state(), a.id).observation.cacheHit).toBe(true);
  capture(engine, state({ id: 44, app: "notepad" }));
  expect(capture(engine, state(), a.id).observation.cacheHit).toBe(true);
  expect(capture(engine, state(bTarget), b.id).observation.cacheHit).toBe(false);
});

test("total bytes and oversized entries bound retained observations", () => {
  const engine = createComputerObservationEngine(digest, "test", { maxEntries: 16, maxBytes: 500, maxEntryBytes: 500 });
  const a = capture(engine).observation;
  const bTarget = { id: 43, app: "notepad" };
  const b = capture(engine, state(bTarget)).observation;
  expect(capture(engine, state(bTarget), b.id).observation.cacheHit).toBe(true);
  expect(capture(engine, state(), a.id).observation.cacheHit).toBe(false);
  const huge = state(target, "x".repeat(501));
  const large = capture(engine, huge).observation;
  expect(capture(engine, huge, large.id).observation).toMatchObject({ unchanged: false, cacheHit: false, hash: null });
});

test("hash collisions cannot hide external content changes and JSON key order is immaterial", () => {
  const engine = createComputerObservationEngine(() => "collision", "test");
  const first = capture(engine).observation;
  const reordered = { accessibility: { focused_element: "0 Edit", document_text: "marker", tree: "0 Edit" }, screenshots: [], window: { app: "notepad", id: 42 } };
  expect(engine.observe(target, reordered, engine.captureEpoch(), first.id).observation.cacheHit).toBe(true);
  const changed = capture(engine, state(target, "manual edit"), first.id);
  expect(changed.observation).toMatchObject({ revision: 2, cacheHit: false, unchanged: false });
  expect(changed.accessibility?.document_text).toBe("manual edit");
});

test("mutable native objects and fields beyond the accessibility text cannot impersonate unchanged evidence", () => {
  const engine = createComputerObservationEngine(digest, "test");
  const value: any = { ...state(), native_metadata: { geometry: [0, 0, 400, 300], foreground: true } };
  const first = engine.observe(target, value, engine.captureEpoch()).observation;
  value.accessibility.document_text = "manual edit on same native object";
  const edited = engine.observe(target, value, engine.captureEpoch(), first.id).observation;
  expect(edited).toMatchObject({ cacheHit: false, unchanged: false, stateRevision: 2 });
  value.native_metadata.geometry[2] = 500;
  const resized = engine.observe(target, value, engine.captureEpoch(), edited.id).observation;
  expect(resized).toMatchObject({ cacheHit: false, unchanged: false, stateRevision: 3 });
  delete value.native_metadata.foreground;
  expect(engine.observe(target, value, engine.captureEpoch(), resized.id).observation).toMatchObject({ cacheHit: false, stateRevision: 4 });
});

test("unknown observation IDs always receive full fresh state even after equality", () => {
  const engine = createComputerObservationEngine(digest, "test");
  capture(engine);
  const repeated = capture(engine, state(), "some-other-session:1");
  expect(repeated.accessibility?.document_text).toBe("marker");
  expect(repeated.observation).toMatchObject({ unchanged: true, cacheHit: false });
});

test("unavailable, non-JSON and pixel-bearing evidence never authorizes compact reuse", () => {
  const engine = createComputerObservationEngine(digest, "test");
  for (const extra of [{ accessibility: null }, { accessibility: { tree: "", document_text: "" } },
    { screenshots: [{ data: "pixels" }] }, { unknown: undefined }, { unknown: NaN }, { unknown: new Date() }]) {
    const value = { ...state(), ...extra };
    const first = engine.observe(target, value, engine.captureEpoch());
    const second = engine.observe(target, value, engine.captureEpoch(), first.observation.id);
    expect(second.observation).toMatchObject({ evidence: "unavailable", unchanged: false, cacheHit: false, hash: null });
  }
  const cyclic: any = state(); cyclic.self = cyclic;
  expect(engine.observe(target, cyclic, engine.captureEpoch()).observation.evidence).toBe("unavailable");
});
