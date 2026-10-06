import type { NativeOperationIntent } from "./native-operation";
import { createComputerObservationEngine } from "./computer-observation";

export interface ComputerUseOperation {
  operation: "list_apps" | "list_windows" | "window_state" | "activate_window" | "type_text" | "activate_and_observe";
  window?: { id: number; app: string };
  text?: string;
  /** Compact repeats are opt-in: the caller must still have this full observation in context. */
  knownObservationId?: string;
}

export function computerUseIntent(operation: ComputerUseOperation["operation"]): NativeOperationIntent {
  const readOnly = ["list_apps", "list_windows", "window_state"].includes(operation);
  return { category: "computer_use", risk: readOnly ? "read_only" : "ordinary_mutation", readOnly,
    deterministic: true, foregroundTransition: !readOnly, externalSideEffect: readOnly ? false : "unknown",
    destructive: readOnly ? false : "unknown", requiresApproval: "native", commandShape: "none" };
}

/** Finite native programs, not an interpreter for caller-supplied JS. All native safety gates
 * remain in Sky. Each action dispatches once; Sky owns its necessary foreground transition. */
export function computerUseProgram(request: ComputerUseOperation, generation = "native-session"): string {
  if (!["list_apps", "list_windows", "window_state", "activate_window", "type_text", "activate_and_observe"].includes(request.operation)) {
    throw new Error("Unsupported structured Computer Use operation");
  }
  const targetRequired = !["list_apps", "list_windows"].includes(request.operation);
  if (targetRequired && (!request.window || !Number.isSafeInteger(request.window.id) || request.window.id < 0
    || typeof request.window.app !== "string" || !request.window.app.trim())) throw new Error("A stable app/window identity is required");
  if (request.operation === "type_text" && typeof request.text !== "string") throw new Error("type_text requires text");
  if (request.knownObservationId !== undefined && (request.operation !== "window_state"
    || typeof request.knownObservationId !== "string" || !request.knownObservationId || request.knownObservationId.length > 256)) {
    throw new Error("knownObservationId requires a bounded window_state observation ID");
  }
  const target = targetRequired ? JSON.stringify({ id: request.window!.id, app: request.window!.app }) : "null";
  const operation = request.operation;
  return [
    "{",
    'const key = "__codexBridgeSkyV2";',
    `const generation = ${JSON.stringify(generation)};`,
    'if (globalThis[key]?.generation !== generation || globalThis[key]?.schema !== 5) {',
    '  globalThis[key]?.observations?.invalidate();',
    '  delete globalThis[key];',
    '}',
    'if (!globalThis[key]) {',
    '  const initializing = { schema: 5, generation, windows: new Map(), observed: new Set(), selectedWindow: null };',
    '  globalThis[key] = initializing;',
    '  initializing.ready = (async () => {',
    '    try {',
    '      const { createHash, randomUUID } = await import("node:crypto");',
    `      const createObservations = (${createComputerObservationEngine.toString()});`,
    '      const { sky } = await import("@oai/sky");',
    '      if (globalThis[key] !== initializing) throw new Error("Native session invalidated during initialization");',
    '      initializing.sky = sky;',
    '      initializing.observations = createObservations(value => createHash("sha256").update(value).digest("hex"), randomUUID());',
    '    } catch (error) { if (globalThis[key] === initializing) delete globalThis[key]; throw error; }',
    '  })();',
    '}',
    "const session = globalThis[key];",
    "await session.ready;",
    // Awaited work may outlive its registry generation. Never publish that result, act on
    // its old enumeration, or let its error handler delete a replacement session.
    "const assertSession = () => { if (globalThis[key] !== session) throw new Error('Native session invalidated during operation'); };",
    "assertSession();",
    `const target = ${target};`,
    'const windowKey = target ? JSON.stringify([target.app, target.id]) : null;',
    "try {",
    ...(targetRequired ? [
      "if (!session.observed.has(windowKey)) throw new Error('Target must be observed in native enumeration before use');",
      "if (session.selectedWindow !== windowKey) { session.observations.invalidate(); session.selectedWindow = windowKey; }",
      "let window = session.windows.get(windowKey);",
      "if (!window) {",
      "  window = await session.sky.get_window(target);",
      "  assertSession();",
      "  if (window.id !== target.id || window.app !== target.app) throw new Error('Native window identity changed');",
      "  session.windows.set(windowKey, window);",
      "  if (session.windows.size > 16) session.windows.delete(session.windows.keys().next().value);",
      "}",
    ] : []),
    ...(operation === "list_apps" || operation === "list_windows" ? [
      `const value = await session.sky.${operation}();`,
      "assertSession();",
      operation === "list_apps" ? "const live = value.flatMap(app => app.windows ?? []);" : "const live = value;",
      "const identities = new Set(live.map(window => JSON.stringify([window.app, window.id])));",
      "session.observed = identities;",
      "for (const id of session.windows.keys()) if (!identities.has(id)) { session.windows.delete(id); session.observations.invalidate(); }",
      "if (session.selectedWindow && !identities.has(session.selectedWindow)) { session.observations.invalidate(); session.selectedWindow = null; }",
      "nodeRepl.write(JSON.stringify(value));",
    ] : operation === "window_state" || operation === "activate_and_observe" ? [
      ...(operation === "activate_and_observe" ? [
        // The only sequence is activation followed by proof on the same enumerated target.
        // No text entry, confirmations, coordinates, caller scripts or automatic retries.
        "if (typeof session.sky.activate_window !== 'function' || typeof session.sky.get_window_state !== 'function') throw new Error('Native sequence capabilities unavailable');",
        "session.observations.recordAction();",
        "await session.sky.activate_window({ window });",
        "assertSession();",
        "session.observations.invalidate();",
      ] : []),
      "const captureEpoch = session.observations.captureEpoch();",
      "const value = await session.sky.get_window_state({ window, include_screenshot: false, include_text: true });",
      "assertSession();",
      `const result = session.observations.observe(target, value, captureEpoch, ${JSON.stringify(request.knownObservationId ?? null)});`,
      "session.windows.set(windowKey, value.window);",
      operation === "activate_and_observe"
        ? 'nodeRepl.write(JSON.stringify({ ...result, completed: true, operation: "activate_and_observe" }));'
        : "nodeRepl.write(JSON.stringify(result));",
    ] : [
      "const actionRevision = session.observations.recordAction();",
      operation === "type_text" ? `await session.sky.type_text({ window, text: ${JSON.stringify(request.text)} });`
        : "await session.sky.activate_window({ window });",
      "assertSession();",
      "session.observations.invalidate();",
      `nodeRepl.write(JSON.stringify({ completed: true, operation: ${JSON.stringify(operation)}, actionRevision }));`,
    ]),
    "} catch (error) {",
    "  session.observations.invalidate();",
    "  const message = String(error?.message ?? error);",
    "  if (/stale|window.{0,30}(?:closed|destroyed|not found)|identity changed/i.test(message) && windowKey) { session.windows.delete(windowKey); session.observed.delete(windowKey); }",
    "  if (globalThis[key] === session && /session.{0,30}reset|connection.{0,30}(?:lost|closed|disconnect)/i.test(message)) delete globalThis[key];",
    "  throw error;",
    "}",
    "}",
  ].join("\n");
}
