import type { NativeOperationIntent } from "./native-operation";

export interface ComputerUseOperation {
  operation: "list_apps" | "list_windows" | "window_state" | "activate_window" | "type_text";
  window?: { id: number; app: string };
  text?: string;
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
  if (!["list_apps", "list_windows", "window_state", "activate_window", "type_text"].includes(request.operation)) {
    throw new Error("Unsupported structured Computer Use operation");
  }
  const targetRequired = !["list_apps", "list_windows"].includes(request.operation);
  if (targetRequired && (!request.window || !Number.isSafeInteger(request.window.id) || request.window.id < 0
    || typeof request.window.app !== "string" || !request.window.app.trim())) throw new Error("A stable app/window identity is required");
  if (request.operation === "type_text" && typeof request.text !== "string") throw new Error("type_text requires text");
  const target = targetRequired ? JSON.stringify({ id: request.window!.id, app: request.window!.app }) : "null";
  const operation = request.operation;
  return [
    "{",
    'const key = "__codexBridgeSkyV2";',
    `const generation = ${JSON.stringify(generation)};`,
    'if (globalThis[key]?.generation !== generation) delete globalThis[key];',
    'if (!globalThis[key]) globalThis[key] = { generation, sky: (await import("@oai/sky")).sky, windows: new Map(), observed: new Set() };',
    "const session = globalThis[key];",
    `const target = ${target};`,
    'const windowKey = target ? JSON.stringify([target.app, target.id]) : null;',
    "try {",
    ...(targetRequired ? [
      "if (!session.observed.has(windowKey)) throw new Error('Target must be observed in native enumeration before use');",
      "let window = session.windows.get(windowKey);",
      "if (!window) {",
      "  window = await session.sky.get_window(target);",
      "  if (window.id !== target.id || window.app !== target.app) throw new Error('Native window identity changed');",
      "  session.windows.set(windowKey, window);",
      "  if (session.windows.size > 16) session.windows.delete(session.windows.keys().next().value);",
      "}",
    ] : []),
    ...(operation === "list_apps" || operation === "list_windows" ? [
      `const value = await session.sky.${operation}();`,
      operation === "list_apps" ? "const live = value.flatMap(app => app.windows ?? []);" : "const live = value;",
      "const identities = new Set(live.map(window => JSON.stringify([window.app, window.id])));",
      "session.observed = identities;",
      "for (const id of session.windows.keys()) if (!identities.has(id)) session.windows.delete(id);",
      "nodeRepl.write(value);",
    ] : operation === "window_state" ? [
      "nodeRepl.write(await session.sky.get_window_state({ window, include_screenshot: false, include_text: true }));",
    ] : [
      operation === "type_text" ? `await session.sky.type_text({ window, text: ${JSON.stringify(request.text)} });`
        : "await session.sky.activate_window({ window });",
      `nodeRepl.write({ completed: true, operation: ${JSON.stringify(operation)} });`,
    ]),
    "} catch (error) {",
    "  const message = String(error?.message ?? error);",
    "  if (/stale|window.{0,30}(?:closed|destroyed|not found)|identity changed/i.test(message) && windowKey) { session.windows.delete(windowKey); session.observed.delete(windowKey); }",
    "  if (/session.{0,30}reset|connection.{0,30}(?:lost|closed|disconnect)/i.test(message)) delete globalThis[key];",
    "  throw error;",
    "}",
    "}",
  ].join("\n");
}
