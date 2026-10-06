import { cpus, platform, release } from "node:os";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { computerUseProgram, type ComputerUseOperation } from "../src/adapters/chatgpt-web/native-computer-use";

// Synthetic only: execute the actual finite programs with a mocked native boundary.
// The baseline is trusted repository source, loaded without a shell or live UI access.
const baselineRef = process.argv[2] ?? "20296a5ac3b8327c6660e3607b992f91ee0c37c0";
const path = "src/adapters/chatgpt-web/native-computer-use.ts";
const baseline = Bun.spawnSync(["git", "show", `${baselineRef}:${path}`]);
if (baseline.exitCode !== 0) throw new Error("Cannot read baseline native Computer Use source");
const baselineJS = new Bun.Transpiler({ loader: "ts" }).transformSync(baseline.stdout.toString());
if (/^import\s/m.test(baselineJS)) throw new Error("Baseline must predate the observation helper import");
const beforeProgram = new Function(baselineJS.replace(/^export\s+/gm, "") + "\nreturn computerUseProgram;")() as typeof computerUseProgram;
const baselineCommit = Bun.spawnSync(["git", "rev-parse", `${baselineRef}^{commit}`]).stdout.toString().trim();
const target = { id: 42, app: "synthetic-editor" };
const samples = 30, cyclesPerSample = 200, warmupCycles = 200;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
type Counts = { imports: number; lookups: number; captures: number; screenshots: number; activates: number; types: number; outputs: number; outputBytes: number; cacheHits: number; errors: number };

function runtime(program: typeof computerUseProgram, documentBytes: number, changeEvery: number) {
  const context: Record<string, unknown> = {};
  const counts: Counts = { imports: 0, lookups: 0, captures: 0, screenshots: 0, activates: 0, types: 0, outputs: 0, outputBytes: 0, cacheHits: 0, errors: 0 };
  let knownId: string | null = null, cycle = 0;
  let capturedText: string | undefined, acknowledgedText: string | undefined;
  const documents = ["a".repeat(documentBytes), "b".repeat(documentBytes)];
  const sky = {
    async list_apps() { return [{ id: target.app, windows: [target] }]; },
    async get_window(window: typeof target) { counts.lookups++; return { ...window }; },
    async get_window_state(options: { window: typeof target; include_screenshot: boolean; include_text: boolean }) {
      counts.captures++; if (options.include_screenshot) counts.screenshots++;
      if (!options.include_text) throw new Error("Benchmark requires fresh text evidence");
      const index = changeEvery ? Math.floor(cycle / changeEvery) % 2 : 0;
      cycle++;
      capturedText = (" " + documents[index]).slice(1);
      return { window: { ...options.window }, screenshots: [], accessibility: { tree: "0 Edit document", document_text: capturedText, focused_element: "0 Edit" } };
    },
    async activate_window() { counts.activates++; },
    async type_text() { counts.types++; },
  };
  const loadSky = async () => { counts.imports++; return { sky }; };
  const nodeRepl = { write(value: unknown) {
    // Equivalent output normalization for both versions, plus one consumer JSON parse.
    const wire = typeof value === "string" ? value : JSON.stringify(value);
    const decoded = JSON.parse(wire);
    if (decoded.accessibility) acknowledgedText = decoded.accessibility.document_text;
    if (decoded.observation || decoded.accessibility) {
      if (acknowledgedText !== capturedText) throw new Error("Output consumer received stale synthetic document state");
    }
    counts.outputs++; counts.outputBytes += Buffer.byteLength(wire);
    if (decoded.observation?.cacheHit) counts.cacheHits++;
    knownId = decoded.observation?.id ?? null;
  } };
  function compile(request: ComputerUseOperation) {
    const code = program(request).replace('import("@oai/sky")', "loadSky()")
      .replace('"__benchmark_known_id__"', "knownId");
    const execute = new AsyncFunction("globalThis", "loadSky", "nodeRepl", "knownId", code);
    return async () => { try { await execute(context, loadSky, nodeRepl, knownId); } catch (error) { counts.errors++; throw error; } };
  }
  return { counts, enumerate: compile({ operation: "list_apps" }), observe: compile({ operation: "window_state", window: target, knownObservationId: "__benchmark_known_id__" }) };
}

const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
const rounded = (value: number) => Number(value.toFixed(6));
const delta = (a: Counts, b: Counts) => Object.fromEntries(Object.keys(a).map(key => [key, a[key as keyof Counts] - b[key as keyof Counts]])) as Counts;

async function compare(name: string, documentBytes: number, changeEvery = 0) {
  const before = runtime(beforeProgram, documentBytes, changeEvery);
  const after = runtime(computerUseProgram, documentBytes, changeEvery);
  await before.enumerate(); await after.enumerate();
  for (let i = 0; i < warmupCycles; i++) { await before.observe(); await after.observe(); }
  const initialBefore = { ...before.counts }, initialAfter = { ...after.counts };
  const timings = { before: [] as number[], after: [] as number[] };
  async function sample(label: "before" | "after", lane: typeof before) {
    const start = performance.now();
    for (let i = 0; i < cyclesPerSample; i++) await lane.observe();
    timings[label].push((performance.now() - start) / cyclesPerSample);
  }
  // Alternate ordering to reduce warmup and background-load bias.
  for (let i = 0; i < samples; i++) {
    if (i % 2) { await sample("after", after); await sample("before", before); }
    else { await sample("before", before); await sample("after", after); }
  }
  const beforeCounts = delta(before.counts, initialBefore), afterCounts = delta(after.counts, initialAfter);
  const expectedCaptures = samples * cyclesPerSample;
  for (const counts of [beforeCounts, afterCounts]) {
    if (counts.captures !== expectedCaptures || counts.screenshots || counts.activates || counts.types || counts.errors) {
      throw new Error("Synthetic observation operation-count regression");
    }
  }
  function summarize(label: "before" | "after", counts: Counts, lifetime: Counts) {
    return { p50MsPerCycle: rounded(percentile(timings[label], .5)), p95MsPerCycle: rounded(percentile(timings[label], .95)),
      meanOutputBytes: rounded(counts.outputBytes / counts.outputs), measuredOperations: counts,
      lifetimeImports: lifetime.imports, lifetimeWindowLookups: lifetime.lookups };
  }
  return { name, documentBytes, externalChangeEvery: changeEvery || null,
    before: summarize("before", beforeCounts, before.counts), after: summarize("after", afterCounts, after.counts),
    p50ImprovementPercent: rounded((1 - percentile(timings.after, .5) / percentile(timings.before, .5)) * 100),
    outputReductionPercent: rounded((1 - afterCounts.outputBytes / beforeCounts.outputBytes) * 100) };
}

const scenarios = [];
for (const [name, size, changeEvery] of [["unchanged-small", 128, 0], ["unchanged-64KiB", 65_536, 0], ["external-edit-every-10", 65_536, 10]] as const) {
  scenarios.push(await compare(name, size, changeEvery));
}
console.log(JSON.stringify({ benchmark: "synthetic-native-computer-observation", baselineCommit,
  after: "current uncommitted workspace", environment: { platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model, bun: Bun.version },
  afterSourceHashes: Object.fromEntries([path, "src/adapters/chatgpt-web/computer-observation.ts"].map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])),
  scope: "Precompiled generated native programs; mocked Sky fresh accessibility capture, observation comparison, output JSON serialization and one consumer parse. Enumeration/import/window binding warmed before measurement.",
  mockDocumentAllocation: "Each capture creates a prefix/slice string from one of two immutable fixture texts, with new window and accessibility objects.",
  exclusions: ["real native UI capture cost", "program generation/compilation", "IPC/network", "model latency/reasoning", "real safety classifier/foreground transitions"],
  samples, cyclesPerSample, warmupCycles, measuredCyclesPerVersionPerScenario: samples * cyclesPerSample,
  retries: 0, scenarios }, null, 2));
