import { createHash } from "node:crypto";

export type NativeOperationRisk = "read_only" | "low_risk_ui" | "ordinary_mutation" | "sensitive" | "unknown";
export function nativeBackgroundReceipt(content: unknown[], nonce?: string): Record<string, unknown> | undefined {
  if (!nonce || !/^[a-f0-9]{48}$/.test(nonce)) return undefined;
  const prefix = `codex-native-receipt:${nonce}:`;
  const lines = content.flatMap(value => {
    const item = value as { type?: unknown; text?: unknown } | null;
    return item?.type === "text" && typeof item.text === "string" ? item.text.split("\n").filter(line => line.startsWith(prefix)) : [];
  });
  if (lines.length !== 1 || lines[0]!.length > 65536) return undefined;
  try {
    const receipt = JSON.parse(lines[0]!.slice(prefix.length));
    return receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : undefined;
  } catch { return undefined; }
}
export function preserveNativeGatewayFailure<T extends { content: unknown[]; isError?: boolean }>(result: T, expectedMarker?: string): T {
  if (!expectedMarker) return result;
  // The broker supplies a fresh marker for this invocation, never to the nested tool itself.
  // Ordinary tool text cannot impersonate the envelope. It never grants safety clearance.
  // Responses joins text-only native blocks; recovery may append a checkpoint block later.
  // Match only the exact nonce suffix, preserving native output and checkpoint instructions.
  let found = false;
  const content = result.content.flatMap(value => {
    const item = value as { type?: unknown; text?: unknown } | null;
    if (item?.type !== "text" || typeof item.text !== "string" || !item.text.endsWith(expectedMarker)) return [value];
    found = true;
    const text = item.text.slice(0, -expectedMarker.length);
    return text ? [{ ...item, text }] : [];
  });
  return found ? { ...result, content, isError: true } : result;
}
export interface NativeOperationIntent {
  category: "command" | "computer_use" | "tool";
  risk: NativeOperationRisk;
  readOnly: boolean;
  deterministic: boolean;
  foregroundTransition: boolean;
  externalSideEffect: boolean | "unknown";
  destructive: boolean | "unknown";
  requiresApproval: boolean | "native";
  commandShape: "simple" | "compound" | "opaque" | "none";
}

// Descriptive only: this list NEVER authorizes execution or bypasses native approval. Splitting
// is deliberately narrower than detecting shell syntax: no arguments, configuration or paths
// supplied by the caller may turn into a new shell program.
const independentProbes = new Set([
  "git status --short", "git rev-parse HEAD", "git rev-parse --show-toplevel",
  "git branch --show-current", "Get-Location", "Get-Process",
]);

export function splitIndependentInspections(command: string): string[] | undefined {
  if (!/[;\r\n]/.test(command)) return undefined;
  const parts = command.split(/;|\r?\n/).map(part => part.trim());
  if (parts.length < 2 || parts.length > 8 || parts.some(part => !independentProbes.has(part))) return undefined;
  return parts;
}

export function classifyNativeOperation(name: string, args: Record<string, unknown> = {}): NativeOperationIntent {
  const command = typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : undefined;
  const inspection = /^(?:(?:functions|tools)__)?(?:exec_command|shell_command)$/.test(name)
    && command !== undefined && independentProbes.has(command.trim());
  const shape = command === undefined ? "none" : /[;\r\n&|<>`$(){}]/.test(command) ? "compound" : /["']/.test(command) ? "opaque" : "simple";
  const cu = /(?:node_repl|computer_use|cua_repl)/.test(name);
  return {
    category: command !== undefined ? "command" : cu ? "computer_use" : "tool",
    risk: inspection ? "read_only" : "unknown",
    readOnly: inspection,
    deterministic: inspection,
    foregroundTransition: cu && /(?:activate|focus)/.test(name),
    externalSideEffect: inspection ? false : "unknown",
    destructive: inspection ? false : "unknown",
    requiresApproval: args.sandbox_permissions === "require_escalated" ? true : "native",
    commandShape: shape,
  };
}

export function operationFingerprint(name: string, args?: Record<string, unknown>, input?: string): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  const semantic = args ? { ...args } : undefined;
  // Only known command transport controls are omitted. Preserve cwd, tty, shell and approvals.
  if (semantic && /^(?:(?:functions|tools)__)?(?:exec_command|shell_command)$/.test(name)) {
    delete semantic.yield_time_ms; delete semantic.max_output_tokens;
    if (name.endsWith("shell_command")) delete semantic.timeout_ms;
  }
  return createHash("sha256").update(JSON.stringify(canonical([name, semantic ?? null, input ?? null]))).digest("hex");
}

export function nativeSafetyDiagnostic(result: { content: unknown[]; isError?: boolean; structuredContent?: unknown }) {
  // Never emit the underlying text. Even successful tools may contain examples of safety errors;
  // only terminal error results supply classification evidence.
  const text = result.isError ? result.content.flatMap(value => {
    const item = value as { type?: unknown; text?: unknown } | null;
    return item?.type === "text" && typeof item.text === "string" ? [item.text.slice(0, 16_384)] : [];
  }).join("\n") : "";
  const explicit = /explicit unsafe|unsafe (?:operation|request)|denied by policy|not allowed by (?:policy|safety)|approval.{0,30}(?:denied|rejected)/i.test(text);
  const foreground = /foreground.transition.safety.blocked|desktop.{0,60}(?:locked|unlocked|no foreground)|no foreground window/i.test(text);
  const indeterminate = /safety status could not be determined|indeterminate safety|safety.{0,30}indeterminate/i.test(text);
  const blocked = /safety[_ -]blocked|blocked by.{0,30}safety|command.safety.{0,30}blocked/i.test(text);
  const outcome = explicit ? "rejected" : foreground ? "foreground_blocked" : indeterminate ? "indeterminate" : blocked ? "rejected" : "not_reported";
  return {
    result: outcome,
    source: outcome === "not_reported" ? "unavailable" : /blocked by OpenAI|OpenAI.{0,40}safety checks/i.test(text) ? "external_classifier_report" : "native_tool_result",
    nativeInvoked: "unknown",
    blockedBeforeNativeDispatch: "unknown",
    foreground: foreground ? "unproven" : "unknown",
    retry: outcome === "indeterminate" ? "changed_evidence_only" : "none",
    fallback: "none_selected",
  } as const;
}

/** Broker metadata is diagnostic, not trusted input or permission. Reconstruct only finite
 * fields so a forged socket request cannot place private arguments into the log. */
export function sanitizedOperationIntent(value: unknown): NativeOperationIntent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.category !== "string" || !["command", "computer_use", "tool"].includes(v.category)
    || typeof v.risk !== "string" || !["read_only", "low_risk_ui", "ordinary_mutation", "sensitive", "unknown"].includes(v.risk)
    || typeof v.commandShape !== "string" || !["simple", "compound", "opaque", "none"].includes(v.commandShape)
    || [v.readOnly, v.deterministic, v.foregroundTransition].some(x => typeof x !== "boolean")
    || [v.externalSideEffect, v.destructive].some(x => typeof x !== "boolean" && x !== "unknown")
    || (typeof v.requiresApproval !== "boolean" && v.requiresApproval !== "native")) return undefined;
  return { category: v.category as NativeOperationIntent["category"], risk: v.risk as NativeOperationRisk,
    commandShape: v.commandShape as NativeOperationIntent["commandShape"], readOnly: v.readOnly as boolean,
    deterministic: v.deterministic as boolean, foregroundTransition: v.foregroundTransition as boolean,
    externalSideEffect: v.externalSideEffect as boolean | "unknown", destructive: v.destructive as boolean | "unknown",
    requiresApproval: v.requiresApproval as boolean | "native" };
}

export function operationTelemetry(
  event: "queued" | "delivered" | "completed" | "blocked_before_dispatch",
  request: { callId?: string; wireName: string; arguments?: Record<string, unknown>; input?: string; requestedTool?: string; operationIntent?: NativeOperationIntent; registryGeneration?: string },
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ event, selectedTool: request.wireName,
    requestedTool: request.requestedTool ?? request.wireName,
    ...(request.callId ? { callId: request.callId.slice(0, 17) } : {}),
    intent: sanitizedOperationIntent(request.operationIntent) ?? classifyNativeOperation(request.wireName, request.arguments),
    computerUseState: "native_owned", foregroundState: "unknown", retryAttempted: false,
    registryGeneration: typeof request.registryGeneration === "string" && /^[a-f0-9]{12}$/.test(request.registryGeneration)
      ? request.registryGeneration : "unknown",
    selectedRoute: request.wireName === "exec" ? "native_gateway" : "native_tool",
    ...extra });
}
