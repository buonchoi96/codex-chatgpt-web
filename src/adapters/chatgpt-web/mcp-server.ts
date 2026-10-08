import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { VERSION } from "../../version";
import type { ChatGptTurnEnvironment } from "./environment";
import {
  CODEX_COMPACTION_CONTROL_WIRE_NAME,
  CODEX_RECOVERY_CHECKPOINT_WIRE_NAME,
} from "./native-compaction-control";
import { CODEX_OUTPUT_CONTROL_WIRE_NAME, submitNativeOutputControl } from "./native-output-control";
import { callTurnBroker, TurnBrokerTimeoutError, type BrokerToolResult } from "./turn-broker";
import { observeMcpToolCalls } from "./mcp-observation";
import { classifyNativeOperation, operationFingerprint, splitIndependentInspections, type NativeOperationIntent } from "./native-operation";
import { computerUseIntent, computerUseProgram, type ComputerUseOperation } from "./native-computer-use";
import { filterMcpAdvertisements, DEPRECATED_MCP_TOOLS } from "./mcp-advertisement";
import { BackendPerfTrace } from "../../lib/backend-perf";

interface ClaimedTurn {
  bindingId: string;
  activityId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

export type ChatGptMcpContract = "native" | "safe";

const BRIDGE_TOOL_NAMES = new Set([
  "codex_turn_start",
  "codex_exec",
  "codex_parallel_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_tool_inventory",
  "codex_tool_wait",
  "codex_readonly_tool_call",
  "codex_computer_use_observe",
  "codex_computer_use_action",
  "codex_windows_computer_use_observe",
  "codex_windows_computer_use_action",
  "codex_windows_computer_use_call",
  "codex_tool_call",
  "codex_turn_complete",
]);

const GATEWAY_AGENT_WAIT_TOOL_NAMES = new Set([
  "multi_agent_v1__wait_agent",
  "multi_agent_v2__wait_agent",
  "collaboration__wait_agent",
]);

// Legacy compatibility for the third-party windows_computer_use MCP. New native desktop
// automation should discover and invoke the official outer-Codex Computer Use capability through
// codex_tool_inventory/codex_tool_call instead of depending on this vendor-specific namespace.
const WINDOWS_COMPUTER_USE_WIRE_PREFIX = "mcp__windows_computer_use__windows_computer_use_";
const WINDOWS_COMPUTER_USE_READ_ONLY_TOOLS = new Set([
  "mcp__windows_computer_use__windows_computer_use_health",
  "mcp__windows_computer_use__windows_computer_use_list_windows",
  "mcp__windows_computer_use__windows_computer_use_snapshot",
  "mcp__windows_computer_use__windows_computer_use_accessibility_tree",
  "mcp__windows_computer_use__windows_computer_use_find",
  "mcp__windows_computer_use__windows_computer_use_element_info",
  "mcp__windows_computer_use__windows_computer_use_wait",
]);

const WINDOWS_COMPUTER_USE_OBSERVATION_TOOLS: Record<string, string> = {
  health: "mcp__windows_computer_use__windows_computer_use_health",
  list_windows: "mcp__windows_computer_use__windows_computer_use_list_windows",
  snapshot: "mcp__windows_computer_use__windows_computer_use_snapshot",
  accessibility_tree: "mcp__windows_computer_use__windows_computer_use_accessibility_tree",
  find: "mcp__windows_computer_use__windows_computer_use_find",
  element_info: "mcp__windows_computer_use__windows_computer_use_element_info",
  wait: "mcp__windows_computer_use__windows_computer_use_wait",
};

const WINDOWS_COMPUTER_USE_ACTION_TOOLS: Record<string, string> = {
  click: "mcp__windows_computer_use__windows_computer_use_click",
  double_click: "mcp__windows_computer_use__windows_computer_use_double_click",
  move: "mcp__windows_computer_use__windows_computer_use_move",
  drag: "mcp__windows_computer_use__windows_computer_use_drag",
  scroll: "mcp__windows_computer_use__windows_computer_use_scroll",
  type_text: "mcp__windows_computer_use__windows_computer_use_type_text",
  keypress: "mcp__windows_computer_use__windows_computer_use_keypress",
  focus: "mcp__windows_computer_use__windows_computer_use_focus",
  invoke: "mcp__windows_computer_use__windows_computer_use_invoke",
  set_value: "mcp__windows_computer_use__windows_computer_use_set_value",
  activate_window: "mcp__windows_computer_use__windows_computer_use_activate_window",
};

function isWindowsComputerUseWireName(name: string): boolean {
  return name.startsWith(WINDOWS_COMPUTER_USE_WIRE_PREFIX) && /^[A-Za-z0-9_]+$/.test(name);
}

function assertWindowsComputerUseReadOnlyCall(
  name: string,
  args: Record<string, unknown>,
): void {
  if (!WINDOWS_COMPUTER_USE_READ_ONLY_TOOLS.has(name)) {
    throw new Error(`Codex read-only dispatcher does not allow this tool: ${name}`);
  }
  if (args.activate === true) {
    throw new Error("Codex read-only Windows dispatcher rejects activate=true because it changes foreground window state");
  }
}

const turnTokenSchema = z.string().min(20).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
const parallelCommandSchema = z.object({
  cmd: z.string().min(1).max(100_000),
  workdir: z.string().max(16_384).optional(),
  yield_time_ms: z.number().int().min(250).max(30_000).optional(),
  max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
  tty: z.boolean().optional(),
});
const parallelCommandBatchSchema = z.object({
  commands: z.array(parallelCommandSchema).min(2).max(8),
});
type ParallelCommand = z.infer<typeof parallelCommandSchema>;
// Match Codex's default wait interval while returning before the MCP invocation deadline.
export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 30_000;
const AGENT_WAIT_TRANSPORT_RULE = `ChatGPT Web transport rule: wait for exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS / 1_000} seconds per call, matching the Codex default, then release the MCP channel so spawned Web agents can use their own tools. A wait timeout is not task completion; check agent progress and wait again if needed. Keep the native tool's declared arguments.`;
export const COMMAND_SAFETY_TRANSPORT_RULE = "Codex command-safety compatibility: keep shell and PowerShell calls single-purpose and minimal. Do not batch unrelated read-only probes into one command with semicolons, command chains, multiple interpreter invocations, Write-Output separators, large loops, or compound pipelines. Prefer one file read, hash, search, parser invocation, or other independent operation per command and make additional calls as needed. If a command is blocked before execution, do not retry the same compound form; split it into smaller read-only commands that preserve the requested work.";
export const COMMAND_SESSION_TRANSPORT_RULE = "Long-running command transport: exec_command must yield control within 30 seconds. If the process is still running, continue it through its returned session_id with write_stdin polls instead of keeping one native command invocation open across the bridge deadline.";
export const COMPUTER_USE_FAST_PATH_RULE = "Computer Use fast path: keep the persistent node_repl/@oai/sky session and reuse already-discovered module, app, window, and control state across calls. Prefer structured app/window/control state over a new screenshot whenever it is sufficient to choose the next action. Do not re-describe or re-analyze an unchanged screen. When a screenshot is necessary, focus on the relevant or changed UI region when the capability supports it, preserve enough detail for reliable coordinates/text, then choose the next action immediately. When no intermediate branch, confirmation, or safety-sensitive decision is required, execute a short deterministic sequence of low-risk UI actions before observing again. Re-observe after a meaningful UI state transition, when the target is ambiguous, or before a destructive/irreversible action. Avoid repeating list_apps, imports, discovery, or full-screen observation when the persistent session already has valid state.";
export const PARALLEL_COMMAND_RULE = "Parallel command fast path: when two or more command operations are independent, do not depend on each other's output, and do not mutate the same file/process/session/state, prefer codex_parallel_exec so separate native command calls can run concurrently. Keep every command single-purpose; parallelism is across separate Codex tool calls, never by joining commands with semicolons, &&, ||, Write-Output separators, or shell pipelines. Do not parallelize commands whose ordering matters, commands that share a session_id, or commands requiring approval/escalation; run those serially with codex_exec.";
export const CODEX_PARALLEL_COMMAND_CONTROL_WIRE_NAME = "codex.control.parallel_exec";
export const PARALLEL_COMMAND_STABLE_ABI_RULE = `If the current connector does not expose codex_parallel_exec or reports it is not callable, immediately use codex_tool_call with wire_name ${CODEX_PARALLEL_COMMAND_CONTROL_WIRE_NAME}; keep turn_token at the top level and pass {commands:[...]} in arguments. Do not pass codex_parallel_exec as an ordinary native wire name. This fallback applies the same 2–8 command schema and default-sandbox dispatch.`;
export const WRITE_STDIN_TRANSPORT_RULE = "Long-running command transport: write_stdin is a poll/continuation tool, not a place to wait for several minutes in one MCP call. Keep each write_stdin yield_time at or below 60 seconds and poll the same session_id again if the process is still alive. This preserves the native session while staying below the bridge transport deadline.";
// The OpenAI tunnel currently owns a two-minute command-response deadline. The local MCP response
// settles at 90 seconds, but a call already delivered to Codex is detached rather than cancelled:
// the turn remains live and codex_tool_wait retrieves the eventual retained result.
export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000;
export const CHATGPT_WEB_COMMAND_YIELD_MAX_MS = 30_000;
export const CHATGPT_WEB_WRITE_STDIN_YIELD_MAX_MS = 60_000;
export const CODEX_COMPLETION_CONTROL_WIRE_NAME = "codex.control.turn_complete";
export const CODEX_COMPUTER_USE_OBSERVE = "codex.control.computer_use_observe";
export const CODEX_COMPUTER_USE_ACTION = "codex.control.computer_use_action";
const computerUseWindowSchema = z.object({ id: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), app: z.string().min(1).max(16_384) });
const computerUseObserveSchema = z.object({ operation: z.enum(["list_apps", "list_windows", "window_state"]), window: computerUseWindowSchema.optional(), knownObservationId: z.string().min(1).max(256).optional() });
const computerUseActionSchema = z.object({ operation: z.enum(["activate_window", "type_text", "activate_and_observe"]), window: computerUseWindowSchema, text: z.string().max(100_000).optional() });
const GATEWAY_FAILURE_LINE = "if (result?.isError === true) text(__CODEX_NATIVE_FAILURE_MARKER__);";

const ZERO_RISK_MCP_INSTRUCTIONS = [
  "For each pasted Codex Web GPT request, begin with codex_turn_start using the request_id in its request block.",
  "Use that request_id with the Codex tools needed for the task.",
  "When the task is finished, send the complete answer with codex_turn_complete.",
  "If a tool returns an error, report that error instead of changing the request_id.",
].join(" ");

export const CHATGPT_NATIVE_MCP_INSTRUCTIONS = [
  "Use the current turn_token unchanged for every Codex Native call in this response.",
  "Treat every explicit deliverable in the active Codex request as part of one task completion condition.",
  "Do not stop after one successful subtask, implementation milestone, focused test, checkpoint, commit, or partial success when other actionable requested work remains.",
  "After each tool result, continue to the next unfinished requested requirement without asking whether to proceed.",
  "If a Codex Native call returns codex_tool_in_progress, the operation was already delivered and may still be running. Never repeat that original operation. Poll codex_tool_wait with the returned call_id until it yields the terminal tool result, then continue normally.",
  "When codex_tool_inventory returns discovery_tools containing tool_search, invoke tool_search through codex_tool_call and continue in the same response. Never call a discovered mcp__ tool directly from ChatGPT.",
  "For native desktop automation, prefer an official OpenAI Codex Computer Use capability that is actually present in the current outer Codex registry.",
  `For Windows list_apps, list_windows, or window_state, prefer codex_computer_use_observe; for an observed exact app/window activate_window or type_text, use codex_computer_use_action. Cached connectors can use codex_tool_call with wire_name ${CODEX_COMPUTER_USE_OBSERVE} or ${CODEX_COMPUTER_USE_ACTION} and the same operation arguments. These finite routes retain native safety checks and persistent Sky bindings. Native targeted typing already activates its window; do not prepend redundant activation.`,
  "For native Windows app control, explicitly query codex_tool_inventory for node_repl. When mcp__node_repl__js is available, prefer persistent node_repl + @oai/sky: import @oai/sky, retain sky in the REPL session, call sky.list_apps(), and continue through the native app/window operations exposed by sky.",
  COMPUTER_USE_FAST_PATH_RULE,
  "Reuse the exact discovered wire_name through codex_tool_call or the native exec gateway while the tool environment is unchanged.",
  "Treat cua_repl as browser-oriented unless its current description/state explicitly proves native computer APIs are enabled. apps=[], 'Native computer APIs are disabled', a missing sky trusted service, or an equivalent native-surface error is a signal to try node_repl + @oai/sky instead of declaring native Windows unavailable.",
  "Do not treat ChatGPT's browser-only computer surface as evidence of native desktop access.",
  "The codex_windows_computer_use_observe, codex_windows_computer_use_action, and codex_windows_computer_use_call tools are deprecated ABI stubs. They intentionally fail fast and never route desktop work. Use official node_repl + @oai/sky for native Windows Computer Use.",
  "Never execute the literal word tool_search as a PowerShell, cmd.exe, or shell command. tool_search is a Codex Native discovery capability, not an operating-system executable.",
  COMMAND_SAFETY_TRANSPORT_RULE,
  COMMAND_SESSION_TRANSPORT_RULE,
  PARALLEL_COMMAND_RULE,
  PARALLEL_COMMAND_STABLE_ABI_RULE,
  WRITE_STDIN_TRANSPORT_RULE,
  "If a required tool invocation is blocked by safety checks and no safe alternative can complete that requirement, finish every independent requirement and then call the dedicated codex_turn_complete with state=blocked, exact blocked_requirements, remaining_actionable_requirements=[], and a concrete blocker before producing final prose.",
  "Before ending the response, re-check the entire active request against work actually completed and verified. If any actionable explicit deliverable remains, continue using Codex Native tools instead of returning a progress-only answer or listing it as future work.",
  "For Full Harness turns, the mandatory completion receipt is the dedicated codex_turn_complete tool. Call it only after every independently actionable requirement is finished and remaining_actionable_requirements is empty.",
  "Call codex_turn_complete directly when it is callable on the current connector surface. If the current connector reports codex_turn_complete is not callable or missing, use the callable codex_tool_call with wire_name codex.control.turn_complete; keep turn_token at the top level and put the receipt fields inside arguments. Do not retry that unavailable direct tool. Do not search the outer Codex tool inventory for codex_turn_complete.",
  "For state=complete, blocked_requirements must be empty and blocker must be omitted. For state=blocked, blocked_requirements must be non-empty and blocker must be a concrete non-empty string.",
  "After codex_turn_complete is accepted, provide the final user-facing answer. If it is rejected, continue the task and submit a new receipt only when the rejection is resolved.",
  "Only stop early for a genuine external blocker that cannot be resolved with the available Codex tools or environment.",
].join(" ");

export function chatGptMcpInstructions(contract: ChatGptMcpContract): string {
  return contract === "safe" ? ZERO_RISK_MCP_INSTRUCTIONS : CHATGPT_NATIVE_MCP_INSTRUCTIONS;
}

function turnReferenceInput(contract: ChatGptMcpContract): Record<string, z.ZodString> {
  return contract === "safe"
    ? { request_id: turnTokenSchema }
    : { turn_token: turnTokenSchema };
}

function turnReference(contract: ChatGptMcpContract, input: object): string {
  const key = contract === "safe" ? "request_id" : "turn_token";
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

interface McpRequestExtra {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
  signal?: AbortSignal;
}

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: McpRequestExtra): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function afterSafeStart(contract: ChatGptMcpContract, description: string): string {
  return contract === "safe"
    ? `For a Zero Risk request connected by codex_turn_start. ${description}`
    : description;
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

function gatewayToolNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9_$]+$/.test(name);
}

function safeVisibleTools(environment: ChatGptTurnEnvironment, contract: ChatGptMcpContract): CodexTool[] {
  if (contract === "native") return environment.tools;
  const bridgeNamespaces = new Set(environment.tools
    .filter(tool => tool.namespace && BRIDGE_TOOL_NAMES.has(tool.name))
    .map(tool => tool.namespace!));
  return environment.tools.filter(tool => (
    wireName(tool) !== CODEX_COMPACTION_CONTROL_WIRE_NAME
    && !BRIDGE_TOOL_NAMES.has(tool.name)
    // Zero Risk does not expose model-authored JavaScript. Automatic Full mode keeps the native
    // Codex exec surface and applies its transport guard at invocation time below.
    && (tool.namespace !== undefined || tool.name !== "exec")
    && (!tool.namespace || !bridgeNamespaces.has(tool.namespace))
  ));
}

function exactVisibleStructuredTool(
  environment: ChatGptTurnEnvironment,
  contract: ChatGptMcpContract,
  name: string,
): CodexTool {
  const tool = safeVisibleTools(environment, contract).find(candidate => wireName(candidate) === name);
  if (!tool) throw new Error(`Codex tool is not available in this turn: ${name}`);
  if (tool.freeform || tool.toolSearch) {
    throw new Error(`Codex structured dispatcher cannot invoke non-function tool: ${name}`);
  }
  return tool;
}

function isAgentWaitTool(tool: CodexTool): boolean {
  return isGatewayAgentWaitTool(wireName(tool));
}

function isGatewayAgentWaitTool(name: string): boolean {
  return GATEWAY_AGENT_WAIT_TOOL_NAMES.has(name);
}

function isCommandExecutionToolName(name: string): boolean {
  return name === "exec"
    || name === "exec_command"
    || name === "shell_command"
    || name.endsWith("__exec_command")
    || name.endsWith("__shell_command");
}

function isComputerUseFastPathToolName(name: string): boolean {
  return name === "mcp__node_repl__js"
    || name === "node_repl__js"
    || name === "node_repl"
    || name.startsWith(WINDOWS_COMPUTER_USE_WIRE_PREFIX);
}

function isWriteStdinToolName(name: string): boolean {
  return name === "write_stdin" || name.endsWith("__write_stdin");
}

export function chatGptWriteStdinYieldMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.min(value, CHATGPT_WEB_WRITE_STDIN_YIELD_MAX_MS);
}

export function chatGptCommandYieldMs(value: number | undefined): number {
  return value === undefined
    ? CHATGPT_WEB_COMMAND_YIELD_MAX_MS
    : Math.min(value, CHATGPT_WEB_COMMAND_YIELD_MAX_MS);
}

function isExecCommandToolName(name: string): boolean {
  return name === "exec_command" || name.endsWith("__exec_command");
}

function normalizeStructuredToolArguments(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (isExecCommandToolName(name)) {
    return {
      ...args,
      yield_time_ms: chatGptCommandYieldMs(
        typeof args.yield_time_ms === "number" ? args.yield_time_ms : undefined,
      ),
    };
  }
  if (name === "shell_command" || name.endsWith("__shell_command")) {
    return {
      ...args,
      timeout_ms: Math.min(
        typeof args.timeout_ms === "number" ? args.timeout_ms : CHATGPT_WEB_COMMAND_YIELD_MAX_MS,
        CHATGPT_WEB_COMMAND_YIELD_MAX_MS,
      ),
    };
  }
  if (!isWriteStdinToolName(name) || typeof args.yield_time_ms !== "number") return args;
  return {
    ...args,
    yield_time_ms: Math.min(args.yield_time_ms, CHATGPT_WEB_WRITE_STDIN_YIELD_MAX_MS),
  };
}
function browserToolDescription(tool: CodexTool): string {
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE} This rule is enforced for wait_agent calls made inside exec; recursive raw exec is unavailable.\n\n${COMMAND_SAFETY_TRANSPORT_RULE}`;
  }
  const rules: string[] = [];
  if (isAgentWaitTool(tool)) rules.push(AGENT_WAIT_TRANSPORT_RULE);
  if (isCommandExecutionToolName(wireName(tool))) {
    rules.push(COMMAND_SAFETY_TRANSPORT_RULE);
    rules.push(COMMAND_SESSION_TRANSPORT_RULE);
  }
  if (isComputerUseFastPathToolName(wireName(tool))) rules.push(COMPUTER_USE_FAST_PATH_RULE);
  if (isWriteStdinToolName(wireName(tool))) rules.push(WRITE_STDIN_TRANSPORT_RULE);
  return rules.length > 0 ? `${tool.description}\n\n${rules.join("\n\n")}` : tool.description;
}

function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  const name = wireName(tool);
  const agentWait = isAgentWaitTool(tool);
  const writeStdin = isWriteStdinToolName(name);
  const execCommand = isExecCommandToolName(name);
  const shellCommand = name === "shell_command" || name.endsWith("__shell_command");
  if (!agentWait && !writeStdin && !execCommand && !shellCommand) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {};
  if (agentWait) {
    const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
      ? properties.timeout_ms as Record<string, unknown>
      : {};
    delete timeout.default;
    const required = Array.isArray(parameters.required)
      ? parameters.required.filter((value): value is string => typeof value === "string")
      : [];
    return {
      ...parameters,
      properties: {
        ...properties,
        timeout_ms: {
          ...timeout,
          type: "number",
          const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
          minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
          maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
          description: "Required transport-safe polling interval. Use exactly 30000; a timed-out wait does not mean the agents have finished.",
        },
      },
      required: [...new Set([...required, "timeout_ms"])],
    };
  }
  if (execCommand) {
    const yieldTime = properties.yield_time_ms && typeof properties.yield_time_ms === "object" && !Array.isArray(properties.yield_time_ms)
      ? properties.yield_time_ms as Record<string, unknown>
      : {};
    delete yieldTime.default;
    return {
      ...parameters,
      properties: {
        ...properties,
        yield_time_ms: {
          ...yieldTime,
          type: "number",
          minimum: 250,
          maximum: CHATGPT_WEB_COMMAND_YIELD_MAX_MS,
          description: "Transport-safe command yield. Use at most 30000 ms; continue a returned session_id with write_stdin if the process is still running.",
        },
      },
    };
  }
  if (shellCommand) {
    const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
      ? properties.timeout_ms as Record<string, unknown>
      : {};
    delete timeout.default;
    return {
      ...parameters,
      properties: {
        ...properties,
        timeout_ms: {
          ...timeout,
          type: "number",
          minimum: 250,
          maximum: CHATGPT_WEB_COMMAND_YIELD_MAX_MS,
          description: "Transport-safe command interval. Use at most 30000 ms so one native call cannot outlive the bridge deadline.",
        },
      },
    };
  }
  const yieldTime = properties.yield_time_ms && typeof properties.yield_time_ms === "object" && !Array.isArray(properties.yield_time_ms)
    ? properties.yield_time_ms as Record<string, unknown>
    : {};
  return {
    ...parameters,
    properties: {
      ...properties,
      yield_time_ms: {
        ...yieldTime,
        type: "number",
        minimum: 250,
        maximum: CHATGPT_WEB_WRITE_STDIN_YIELD_MAX_MS,
        description: "Transport-safe poll duration. Use at most 60000 ms and poll the same session again if it remains active.",
      },
    },
  };
}
function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (!isAgentWaitTool(tool)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

function assertGatewayToolArguments(name: string, args: Record<string, unknown>): void {
  if (!isGatewayAgentWaitTool(name)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

export function chatGptMcpInvocationTimeout(
  environment: ChatGptTurnEnvironment & { expiresAt?: number },
  now = Date.now(),
): number {
  const remaining = environment.expiresAt === undefined
    ? CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS
    : Math.max(1, environment.expiresAt - now);
  return Math.min(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, remaining);
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

interface GatewayToolDescriptor {
  name: string;
  description: string;
}

interface GatewayToolCatalogPage {
  tools: GatewayToolDescriptor[];
  total: number;
}

function gatewayToolDescription(tool: GatewayToolDescriptor): string {
  const rules: string[] = [];
  if (isGatewayAgentWaitTool(tool.name)) rules.push(AGENT_WAIT_TRANSPORT_RULE);
  if (isCommandExecutionToolName(tool.name)) {
    rules.push(COMMAND_SAFETY_TRANSPORT_RULE);
    rules.push(COMMAND_SESSION_TRANSPORT_RULE);
  }
  if (isComputerUseFastPathToolName(tool.name)) rules.push(COMPUTER_USE_FAST_PATH_RULE);
  if (isWriteStdinToolName(tool.name)) rules.push(WRITE_STDIN_TRANSPORT_RULE);
  return rules.length > 0 ? `${tool.description}\n\n${rules.join("\n\n")}` : tool.description;
}

function gatewayToolCatalogProgram(options: {
  query?: string;
  offset: number;
  limit: number;
  excludedNames: string[];
  marker: string;
}): string {
  const needle = options.query?.trim().toLowerCase() ?? "";
  return [
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const excludedNames = new Set(${JSON.stringify(options.excludedNames)});`,
    `const needle = ${JSON.stringify(needle)};`,
    "const visibleName = name => {",
    "  return typeof name === \"string\" && /^[A-Za-z0-9_$]+$/.test(name) && !excludedNames.has(name);",
    "};",
    "const matches = ALL_TOOLS",
    "  .filter(tool => visibleName(tool?.name))",
    "  .map(tool => ({ name: tool.name, description: typeof tool.description === \"string\" ? tool.description : \"\" }))",
    "  .filter(tool => !needle || (tool.name + \"\\n\" + tool.description).toLowerCase().includes(needle));",
    `const page = matches.slice(${options.offset}, ${options.offset + options.limit});`,
    `text(${JSON.stringify(options.marker)} + JSON.stringify({ tools: page, total: matches.length }));`,
  ].join("\n");
}

function gatewayToolCatalogPage(response: {
  content: unknown[];
  isError?: boolean;
}, excludedNames: ReadonlySet<string>, marker: string): GatewayToolCatalogPage {
  const textBlocks = response.content
    .map(item => item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined)
    .filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text as string);
  if (response.isError) {
    throw new Error(`Native nested tool inventory failed: ${textBlocks.join("\n") || "unknown error"}`);
  }
  // exec may wrap text() output with timing/status text. Only the single record
  // emitted for this inventory request is a catalog, never arbitrary surrounding JSON.
  const records = textBlocks.flatMap(text => text.split(/\r?\n/))
    .filter(line => line.startsWith(marker));
  if (records.length !== 1) {
    throw new Error("Native nested tool inventory did not return one matching catalog record");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(records[0]!.slice(marker.length));
  } catch {
    throw new Error("Native nested tool inventory returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native nested tool inventory returned an invalid catalog");
  }
  const catalog = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(catalog.total) || (catalog.total as number) < 0 || !Array.isArray(catalog.tools)) {
    throw new Error("Native nested tool inventory returned invalid pagination");
  }
  const tools = catalog.tools.map((value): GatewayToolDescriptor => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native nested tool inventory returned an invalid tool entry");
    }
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string"
      || typeof tool.description !== "string"
      || !gatewayToolNameIsValid(tool.name)
      || excludedNames.has(tool.name)) {
      throw new Error("Native nested tool inventory returned an invalid tool descriptor");
    }
    return { name: tool.name, description: tool.description };
  });
  return { tools, total: catalog.total as number };
}

function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
    GATEWAY_FAILURE_LINE,
  ].join("\n");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
  excludedNames: string[],
): string {
  if (!gatewayToolNameIsValid(nestedToolName) || excludedNames.includes(nestedToolName)) {
    throw new Error(`Codex nested tool is not available in this turn: ${nestedToolName}`);
  }
  const gatewayName = gatewayNestedToolName(nestedToolName);
  if (gatewayName !== nestedToolName) {
    throw new Error(`Codex nested tool name is invalid: ${nestedToolName}`);
  }
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const nestedToolName = ${JSON.stringify(gatewayName)};`,
    `const excludedNames = new Set(${JSON.stringify(excludedNames)});`,
    "if (excludedNames.has(nestedToolName)) throw new Error(\"Native nested tool is not callable through the structured gateway\");",
    "if (!ALL_TOOLS.some(tool => tool?.name === nestedToolName)) throw new Error(\"Native nested tool is not listed in this turn\");",
    "const nestedTool = tools[nestedToolName];",
    "if (typeof nestedTool !== \"function\") throw new Error(\"Native nested tool is listed but unavailable\");",
    `const result = await nestedTool(${JSON.stringify(nestedInput)});`,
  ]);
}

/**
 * Preserve the native freeform exec surface while applying the same wait_agent deadline contract
 * as direct calls. The model still owns its JavaScript; only the tool registry it receives is a
 * transparent proxy whose native wait functions validate their transport-bound argument before dispatch.
 */
function transportBoundRawExecProgram(input: string, blockedExecName: string): string {
  return [
    "await (async (tools) => {",
    input,
    "})((() => {",
    "  const source = tools;",
    `  const waitNames = new Set(${JSON.stringify([...GATEWAY_AGENT_WAIT_TOOL_NAMES])});`,
    `  const blockedExecName = ${JSON.stringify(blockedExecName)};`,
    `  const pollMs = ${CHATGPT_WEB_AGENT_WAIT_POLL_MS};`,
    "  const registryNames = new Set(Reflect.ownKeys(source));",
    "  if (typeof ALL_TOOLS !== \"undefined\" && Array.isArray(ALL_TOOLS)) {",
    "    for (const tool of ALL_TOOLS) if (typeof tool?.name === \"string\") registryNames.add(tool.name);",
    "  }",
    "  const wrappers = new Map();",
    "  const expose = name => {",
    "    if (wrappers.has(name)) return wrappers.get(name);",
    "    const value = Reflect.get(source, name, source);",
    "    let exposed = value;",
    "    if (typeof value === \"function\" && name === blockedExecName) {",
    "      exposed = () => { throw new Error(\"Nested raw exec is unavailable inside ChatGPT Web exec\"); };",
    "    } else if (typeof value === \"function\" && typeof name === \"string\" && waitNames.has(name)) {",
    "      exposed = args => {",
    "        if (!args || typeof args !== \"object\" || Array.isArray(args) || args.timeout_ms !== pollMs) {",
    "          throw new Error(\"ChatGPT Web wait_agent requires timeout_ms=\" + pollMs + \" so the shared MCP channel remains available to spawned Web agents\");",
    "        }",
    "        return Reflect.apply(value, source, [args]);",
    "      };",
    "    } else if (typeof value === \"function\") {",
    "      exposed = (...args) => Reflect.apply(value, source, args);",
    "    }",
    "    wrappers.set(name, exposed);",
    "    return exposed;",
    "  };",
    "  return new Proxy(Object.create(null), {",
    "    get: (_target, name) => expose(name),",
    "    has: (_target, name) => registryNames.has(name) || Reflect.has(source, name),",
    "    ownKeys: () => [...registryNames],",
    "    getOwnPropertyDescriptor: (_target, name) =>",
    "      registryNames.has(name) || Reflect.has(source, name)",
    "        ? { configurable: true, enumerable: true, writable: false, value: expose(name) }",
    "        : undefined,",
    "    set: () => false,",
    "    defineProperty: () => false,",
    "    deleteProperty: () => false,",
    "    setPrototypeOf: () => false,",
    "    getPrototypeOf: () => null,",
    "    preventExtensions: () => false,",
    "  });",
    "})());",
  ].join("\n");
}

function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
): string {
  const execCommandName = gatewayNestedToolName("exec_command");
  const shellCommandName = gatewayNestedToolName("shell_command");
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native command tool registry is unavailable\");",
    "const nativeCommandNames = new Set(ALL_TOOLS.map(tool => tool?.name));",
    `const nativeCommandCandidates = ${JSON.stringify([execCommandName, shellCommandName])}.filter(name => nativeCommandNames.has(name));`,
    "if (nativeCommandCandidates.length !== 1) throw new Error(\"Expected exactly one native command tool; found \" + (nativeCommandCandidates.join(\", \") || \"none\"));",
    "const nativeCommandName = nativeCommandCandidates[0];",
    "const nativeCommand = tools[nativeCommandName];",
    "if (typeof nativeCommand !== \"function\") throw new Error(\"Native command tool \" + nativeCommandName + \" is listed but unavailable\");",
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await nativeCommand(nativeCommandInput);",
  ]);
}

export async function runChatGptMcpServer(options: {
  brokerSocketPath: string;
  contract?: ChatGptMcpContract;
}): Promise<void> {
  const contract = options.contract ?? "native";
  const server = new McpServer(
    { name: contract === "safe" ? "codex-safe" : "codex-native", version: VERSION },
    { instructions: chatGptMcpInstructions(contract) },
  );

  const claimTurn = async (
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
  ): Promise<ClaimedTurn> => {
    console.error(`[chatgpt-web-mcp] ${toolName} scope=${requestScopeSummary(extra)}`);
    const activityId = `activity_${randomBytes(18).toString("base64url")}`;
    try {
      const claimed = await callTurnBroker<Omit<ClaimedTurn, "activityId">>(
        options.brokerSocketPath,
        { method: "claim", token: turnToken, activityId, contract },
        contract === "safe" ? null : 5_000,
        extra.signal,
      );
      return { ...claimed, activityId };
    } catch (error) {
      try {
        await settleTurnActivity(turnToken, activityId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Codex Native claim failed: ${error instanceof Error ? error.message : String(error)}. Its broker activity could not be retired.`,
          { cause: error },
        );
      }
      throw error;
    }
  };

  const settleTurnActivity = async (turnToken: string, activityId: string): Promise<void> => {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await callTurnBroker(options.brokerSocketPath, {
          method: "activity_complete",
          token: turnToken,
          activityId,
        }, 5_000);
        return;
      } catch (error) {
        firstError ??= error;
      }
    }
    throw new AggregateError(
      [firstError],
      "Codex Native broker activity cleanup failed after an idempotent retry",
    );
  };

  const withClaimedTurn = async <T>(
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
    action: (claimed: ClaimedTurn) => Promise<T> | T,
  ): Promise<T> => {
    const claimed = await claimTurn(toolName, turnToken, extra);
    try {
      return await action(claimed);
    } finally {
      // The broker's terminal fence treats even a fully local inventory lookup as live MCP work.
      // Settle the lease without the request AbortSignal: cancellation must not strand activity
      // and silently prevent every later completion candidate from committing.
      await settleTurnActivity(turnToken, claimed.activityId);
    }
  };

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_start",
      {
        title: "Connect a Codex Zero Risk request",
        description: "Connect the request_id included in the pasted Codex Web GPT request so its Codex tools can be used.",
        inputSchema: {
          request_id: turnTokenSchema,
        },
        outputSchema: {
          started: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_start scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ started: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_start",
          token: request_id,
        }, 5_000, extra.signal);
        return result(response);
      },
    );
  }

  const inventoryCache = new Map<string, { registry: string; createdAt: number; pages: Map<string, GatewayToolCatalogPage> }>();

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string; requestedTool?: string;
      semanticArguments?: Record<string, unknown>; semanticInput?: string; operationIntent?: NativeOperationIntent; gatewayResult?: boolean },
    signal?: AbortSignal,
  ) => {
    const timeoutMs = chatGptMcpInvocationTimeout(bound);
    // Client-owned identity lets a transport timeout retract exactly one call while it is still
    // queued. The broker is authoritative about whether Codex ever received that call.
    const callId = `call_${randomBytes(24).toString("base64url")}`;
    const requestedTool = payload.requestedTool ?? wireName(tool);
    const semanticArguments = payload.semanticArguments ?? payload.arguments;
    const semanticInput = payload.requestedTool ? payload.semanticInput : payload.input;
    const failureMarker = payload.gatewayResult ? JSON.stringify({ __codex_native_failure_v1: randomBytes(24).toString("hex") }) : undefined;
    if (failureMarker && !payload.input?.endsWith(GATEWAY_FAILURE_LINE)) {
      throw new Error("Native gateway result framing is missing");
    }
    const nativeInput = failureMarker
      ? payload.input!.slice(0, -GATEWAY_FAILURE_LINE.length)
        + `if (result?.isError === true) text(${JSON.stringify(failureMarker)});`
      : payload.input;
    // A search/reset may change a deferred registry even when the outer descriptors stay equal.
    if (tool.toolSearch || /tool_search|node_repl.*reset/.test(requestedTool)) inventoryCache.delete(bindingId);
    try {
      const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
        method: "invoke",
        bindingId,
        callId,
        wireName: wireName(tool),
        freeform: tool.freeform === true,
        ...(tool.freeform ? { input: nativeInput ?? "" } : { arguments: payload.arguments ?? {} }),
        requestedTool,
        operationIntent: payload.operationIntent ?? classifyNativeOperation(requestedTool, semanticArguments),
        operationFingerprint: operationFingerprint(requestedTool, semanticArguments, semanticInput),
        registryGeneration: createHash("sha256").update(JSON.stringify(bound.tools)).digest("hex").slice(0, 12),
        ...(failureMarker ? { failureMarker } : {}),
      }, timeoutMs, signal);
      return asMcpResult(response);
    } catch (error) {
      if (error instanceof TurnBrokerTimeoutError) {
        const toolName = wireName(tool);
        let abandoned: {
          cancelled: boolean;
          delivered: boolean;
          pending: boolean;
          completed?: boolean;
          toolResult?: BrokerToolResult;
        };
        try {
          abandoned = await callTurnBroker<{
            cancelled: boolean;
            delivered: boolean;
            pending: boolean;
            completed?: boolean;
            toolResult?: BrokerToolResult;
          }>(
            options.brokerSocketPath,
            {
              method: "cancel_invoke",
              bindingId,
              callId,
            },
          );
        } catch (cancelError) {
          // If the turn deadline expired at the same instant as the invocation deadline, broker
          // pruning may have retired the binding before cancel_invoke can inspect delivery state.
          // Once release is confirmed (including its idempotent retired-binding result), the state
          // is fail-closed and can still be reported as the ordinary structured timeout.
          try {
            await callTurnBroker(options.brokerSocketPath, { method: "release", bindingId });
          } catch (releaseError) {
            throw new AggregateError(
              [error, cancelError, releaseError],
              "Codex Native invocation timed out and its delivery state could not be made safe",
            );
          }
          console.error(
            `[chatgpt-web-mcp] ${toolName} timed out while its binding was already retiring; preserved fail-closed timeout semantics`,
          );
          return result({
            code: "codex_tool_timeout",
            tool: toolName,
            timeout_ms: timeoutMs,
            retryable: false,
            message: `Codex tool ${toolName} did not complete before the MCP transport deadline. The current turn binding is retired; do not retry it in this ChatGPT response.`,
          }, true);
        }
        if (abandoned.cancelled && !abandoned.delivered) {
          console.error(
            `[chatgpt-web-mcp] ${toolName} waited ${timeoutMs}ms without an outer Codex observer; abandoned only its queued invocation and retained the turn binding`,
          );
          return result({
            code: "codex_tool_delivery_timeout",
            tool: toolName,
            timeout_ms: timeoutMs,
            retryable: true,
            turn_binding_retained: true,
            message: `Codex did not claim ${toolName} before the MCP transport deadline. This invocation was cancelled before delivery, the current turn remains valid, and the operation may be retried.`,
          }, true);
        }
        // A completion can race the transport timer by a few milliseconds. If the broker already
        // has the terminal result, return it instead of inventing a timeout or requiring a poll.
        if (abandoned.completed && abandoned.toolResult) {
          console.error(
            `[chatgpt-web-mcp] ${toolName} completed while its ${timeoutMs}ms transport deadline was being reconciled; returning retained result`,
          );
          return asMcpResult(abandoned.toolResult);
        }

        // Delivered calls may already be executing side effects. The 90-second budget belongs only
        // to this MCP response transport; it is not permission to revoke the browser turn or kill
        // the native operation. The broker marks the call detached, retains the eventual result,
        // and completion fences remain blocked until ChatGPT consumes it through codex_tool_wait.
        if (abandoned.delivered && abandoned.pending) {
          console.error(
            `[chatgpt-web-mcp] ${toolName} exceeded ${timeoutMs}ms after delivery; native operation remains active call=${callId.slice(0, 17)} bindingRetained=true`,
          );
          return result({
            code: "codex_tool_in_progress",
            tool: toolName,
            call_id: callId,
            timeout_ms: timeoutMs,
            retryable: false,
            turn_binding_retained: true,
            operation_may_still_be_running: true,
            poll_tool: "codex_tool_wait",
            message: `Codex tool ${toolName} exceeded the MCP response deadline after it was already delivered. Do not retry the operation. The current turn remains valid and the native call continues; poll codex_tool_wait with call_id=${callId} until its terminal result is available.`,
          }, true);
        }

        // If delivery state is neither pending nor safely cancelled, preserve fail-closed semantics
        // without revoking an otherwise healthy turn. A later explicit user stop still owns turn
        // cancellation.
        console.error(
          `[chatgpt-web-mcp] ${toolName} transport timeout had ambiguous delivery state call=${callId.slice(0, 17)} bindingRetained=true`,
        );
        return result({
          code: "codex_tool_timeout_unknown_state",
          tool: toolName,
          call_id: callId,
          timeout_ms: timeoutMs,
          retryable: false,
          turn_binding_retained: true,
          message: `Codex tool ${toolName} reached the MCP response deadline with an ambiguous delivery state. Do not retry the operation automatically; the current turn binding remains valid.`,
        }, true);
      }

      // Non-timeout cancellation has no reliable evidence that the native call stayed queued.
      // Keep the existing fail-closed behavior.
      try {
        await callTurnBroker(options.brokerSocketPath, { method: "release", bindingId });
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "Codex Native invocation failed and its abandoned broker binding could not be retired",
        );
      }
      throw error;
    }
  };

  const runParallelCommands = async (
    claimed: ClaimedTurn,
    commands: ParallelCommand[],
    signal?: AbortSignal,
  ) => {
    const bound = claimed.environment;
    const directTool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
    const gateway = directTool ? undefined : execGateway(bound);
    if (!directTool && !gateway) {
      throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
    }
    const runOne = async (command: ParallelCommand, index: number) => {
      const execCommandArguments = {
        cmd: command.cmd,
        ...(command.workdir ? { workdir: command.workdir } : {}),
        ...(command.yield_time_ms !== undefined ? { yield_time_ms: command.yield_time_ms } : {}),
        ...(command.max_output_tokens !== undefined ? { max_output_tokens: command.max_output_tokens } : {}),
        ...(command.tty !== undefined ? { tty: command.tty } : {}),
      };
      const shellCommandArguments = {
        command: command.cmd,
        ...(command.workdir ? { workdir: command.workdir } : {}),
        ...(command.yield_time_ms !== undefined ? { timeout_ms: command.yield_time_ms } : {}),
      };
      try {
        const output = directTool
          ? await invoke(
              claimed.bindingId,
              bound,
              directTool,
              { arguments: directTool.name === "exec_command" ? execCommandArguments : shellCommandArguments },
              signal,
            )
          : await invoke(
              claimed.bindingId,
              bound,
              gateway!,
              { input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments), gatewayResult: true,
                requestedTool: "exec_command", semanticArguments: execCommandArguments },
              signal,
            );
        return {
          index,
          ok: output.isError !== true,
          content: output.content,
          ...(output.structuredContent !== undefined ? { structured_content: output.structuredContent } : {}),
        };
      } catch (error) {
        return {
          index,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };
    const startedAt = Date.now();
    const results = await Promise.all(commands.map((command, index) => runOne(command, index)));
    const failedCount = results.filter(item => item.ok === false).length;
    return result({
      parallel: true,
      command_count: commands.length,
      elapsed_ms: Date.now() - startedAt,
      succeeded: results.length - failedCount,
      failed: failedCount,
      results,
    }, failedCount === results.length);
  };

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload, bound.tools.map(wireName)),
      gatewayResult: true, requestedTool: nestedToolName, semanticArguments: payload.arguments, semanticInput: payload.input,
    }, signal);
  };

  const runComputerUse = async (claimed: ClaimedTurn, request: ComputerUseOperation, signal?: AbortSignal) => {
    const bound = claimed.environment;
    const generation = createHash("sha256").update(JSON.stringify({ tools: bound.tools, cwd: bound.cwd,
      roots: bound.roots, writableRoots: bound.writableRoots, sandboxPolicy: bound.sandboxPolicy })).digest("hex");
    const code = computerUseProgram(request, generation);
    const direct = bound.tools.find(tool => ["mcp__node_repl__js", "node_repl__js"].includes(wireName(tool)) && !tool.freeform);
    const payload = { arguments: { code }, operationIntent: computerUseIntent(request.operation),
      requestedTool: `computer_use.${request.operation}`, semanticArguments: { ...request, generation } };
    const finish = new BackendPerfTrace(claimed.bindingId).start(computerUseIntent(request.operation).readOnly
      ? "computer_structured_observe" : "computer_action");
    if (direct) {
      try { const value = await invoke(claimed.bindingId, bound, direct, payload, signal); finish(value.isError ? "error" : "ok", { screenshot_used: false }); return value; }
      catch (error) { finish("error"); throw error; }
    }
    const gateway = execGateway(bound);
    if (!gateway) throw new Error("This turn has no native node_repl capability or exec gateway; discover Computer Use first");
    try {
      const value = await invoke(claimed.bindingId, bound, gateway, { ...payload, arguments: undefined,
        input: execGatewayProgram("mcp__node_repl__js", false, { arguments: { code } }, bound.tools.map(wireName)), gatewayResult: true }, signal);
      finish(value.isError ? "error" : "ok", { screenshot_used: false }); return value;
    } catch (error) { finish("error"); throw error; }
  };

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: afterSafeStart(contract, [
        "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id.",
        COMMAND_SAFETY_TRANSPORT_RULE,
        "For codex_exec inspection/probing, send exactly one logical OS operation per call. In particular, do not combine Get-Content, git status, git rev-parse, hashing, parser probes, or similar reads with semicolon/&&/|| chains or Write-Output section separators; make separate codex_exec calls instead.",
        "When several such operations are independent, use codex_parallel_exec instead of serial codex_exec calls.",
      ].join(" ")),
      inputSchema: {
        ...turnReferenceInput(contract),
        cmd: z.string().min(1).max(100_000).describe(
          "One logical OS operation per call. For inspection/probing, do not combine multiple reads, git queries, hashes, parser probes, or section-marker output in one shell/PowerShell command; use separate codex_exec calls.",
        ),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
        sandbox_permissions: z.enum(["use_default", "require_escalated"]).optional()
          .describe("Native Codex sandbox request, only when the current command tool supports it. Codex decides whether to approve."),
        justification: z.string().optional()
          .describe("Approval question for a native require_escalated request; omit otherwise."),
        prefix_rule: z.array(z.string()).optional()
          .describe("Optional native approval prefix for require_escalated; Codex owns its approval and persistence."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_exec",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { cmd, workdir, yield_time_ms, max_output_tokens, tty, sandbox_permissions, justification, prefix_rule } = input;
        const bound = claimed.environment;
        const permissions = {
          ...(sandbox_permissions !== undefined ? { sandbox_permissions } : {}),
          ...(justification !== undefined ? { justification } : {}),
          ...(prefix_rule !== undefined ? { prefix_rule } : {}),
        };
        const inspections = Object.keys(permissions).length === 0 && tty !== true ? splitIndependentInspections(cmd) : undefined;
        if (inspections) return runParallelCommands(claimed, inspections.map(cmd => ({ cmd,
          ...(workdir ? { workdir } : {}), ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        })), extra.signal);
        const execCommandArguments = {
          cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
          ...(tty !== undefined ? { tty } : {}),
          ...permissions,
        };
        const shellCommandArguments = {
          command: cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
          ...permissions,
        };
        const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
        if (tool) {
          // Never silently discard an approval request on a native registry that cannot express it.
          const properties = tool.parameters.properties;
          for (const key of Object.keys(permissions)) {
            if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) {
              throw new Error(`The current native ${tool.name} tool does not support ${key}`);
            }
          }
          const args = tool.name === "exec_command" ? execCommandArguments : shellCommandArguments;
          return invoke(claimed.bindingId, bound, tool, { arguments: args }, extra.signal);
        }
        const gateway = execGateway(bound);
        if (!gateway) {
          throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
        }
        return invoke(claimed.bindingId, bound, gateway, {
          input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
          gatewayResult: true, requestedTool: "exec_command", semanticArguments: execCommandArguments,
        }, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_parallel_exec",
    {
      title: "Run independent native Codex commands concurrently",
      description: afterSafeStart(contract, [
        "Run 2 to 8 independent command operations concurrently as separate native Codex command tool calls.",
        PARALLEL_COMMAND_RULE,
        ...(contract === "native" ? [PARALLEL_COMMAND_STABLE_ABI_RULE] : []),
        COMMAND_SAFETY_TRANSPORT_RULE,
        "Parallel calls always use the default sandbox. If a command needs escalation/approval, ordering, shared mutable state, or another command's output, use serial codex_exec instead.",
      ].join(" ")),
      inputSchema: {
        ...turnReferenceInput(contract),
        commands: parallelCommandBatchSchema.shape.commands,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_parallel_exec",
      turnReference(contract, input),
      extra,
      async claimed => runParallelCommands(claimed, input.commands, extra.signal),
    ),
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: afterSafeStart(contract, "Write characters to, or poll, a session_id returned by codex_exec."),
      inputSchema: {
        ...turnReferenceInput(contract),
        session_id: z.number().int().nonnegative(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(CHATGPT_WEB_WRITE_STDIN_YIELD_MAX_MS).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_write_stdin",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { session_id, chars, yield_time_ms, max_output_tokens } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "write_stdin");
        const safeYieldTimeMs = chatGptWriteStdinYieldMs(yield_time_ms);
        const payload = { arguments: {
          session_id,
          ...(chars !== undefined ? { chars } : {}),
          ...(safeYieldTimeMs !== undefined ? { yield_time_ms: safeYieldTimeMs } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        } };
        return tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.bindingId, bound, "write_stdin", false, payload, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: afterSafeStart(contract, "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task."),
      inputSchema: { ...turnReferenceInput(contract), patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_apply_patch",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { patch } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "apply_patch");
        if (!tool) return invokeNestedNative(claimed.bindingId, bound, "apply_patch", true, { input: patch }, extra.signal);
        return tool.freeform
          ? invoke(claimed.bindingId, bound, tool, { input: patch }, extra.signal)
          : invoke(claimed.bindingId, bound, tool, { arguments: { input: patch } }, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: afterSafeStart(contract, "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response."),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_view_image",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { path, detail } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "view_image");
        const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
        return tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: contract === "safe"
        ? "List tools available to the connected Zero Risk request, including configured MCP and app tools."
        : "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
      inputSchema: {
        ...turnReferenceInput(contract),
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_tool_inventory",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { query, offset, limit, include_schema } = input;
        const bound = claimed.environment;
        const needle = query?.trim().toLowerCase();
        const visibleTools = safeVisibleTools(bound, contract);
        const directMatches = visibleTools.filter(tool => !needle || [
          wireName(tool),
          tool.name,
          tool.namespace ?? "",
          tool.description,
        ].join("\n").toLowerCase().includes(needle));
        const directPage = directMatches.slice(offset, offset + limit).map(tool => ({
          wire_name: wireName(tool),
          name: tool.name,
          namespace: tool.namespace ?? null,
          description: browserToolDescription(tool),
          kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
          ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
        }));
        let nestedTotal = 0;
        let nestedPage: Array<Record<string, unknown>> = [];
        const gateway = execGateway(bound);
        const exactDirectHit = needle && directMatches.some(tool => wireName(tool).toLowerCase() === needle);
        if (gateway && !exactDirectHit) {
          const excludedGatewayNames = bound.tools.map(wireName);
          const marker = `codex-tool-catalog:${randomBytes(16).toString("hex")}:`;
          const nestedOffset = Math.max(0, offset - directMatches.length);
          const nestedLimit = Math.max(0, limit - directPage.length);
          const registry = createHash("sha256").update(JSON.stringify(bound)).digest("hex");
          let cache = inventoryCache.get(claimed.bindingId);
          if (!cache || cache.registry !== registry || Date.now() - cache.createdAt > 60_000) {
            cache = { registry, createdAt: Date.now(), pages: new Map() };
            inventoryCache.set(claimed.bindingId, cache);
            if (inventoryCache.size > 64) inventoryCache.delete(inventoryCache.keys().next().value!);
          }
          const cacheKey = JSON.stringify([query, nestedOffset, nestedLimit]);
          let catalog = cache.pages.get(cacheKey);
          if (!catalog) {
            const response = await invoke(claimed.bindingId, bound, gateway, {
              input: gatewayToolCatalogProgram({
                query,
                offset: nestedOffset,
                limit: nestedLimit,
                // Never reopen outer tools deliberately hidden by the contract.
                excludedNames: excludedGatewayNames,
                marker,
              }),
            }, extra.signal);
            catalog = gatewayToolCatalogPage(response, new Set(excludedGatewayNames), marker);
            if (cache.pages.size < 64) cache.pages.set(cacheKey, catalog);
          }
          nestedTotal = catalog.total;
          nestedPage = catalog.tools.map(tool => ({
            wire_name: tool.name,
            name: tool.name,
            namespace: null,
            description: gatewayToolDescription(tool),
            kind: "gateway",
            ...(include_schema ? {
              parameters: {
                type: "object",
                additionalProperties: true,
                description: "Pass the exact structured arguments declared in this tool's description. For a declared freeform tool, use codex_tool_call.input instead.",
              },
            } : {}),
          }));
        }
        const page = [...directPage, ...nestedPage];
        const total = directMatches.length + nestedTotal;
        // A filtered registry miss does not mean deferred tools are unavailable. Expose the
        // actual native discovery entry separately; it is not a query match or an automatic call.
        const discoveryTools = needle && total === 0
          ? visibleTools.filter(tool => tool.toolSearch).map(tool => ({
            wire_name: wireName(tool),
            name: tool.name,
            namespace: tool.namespace ?? null,
            description: browserToolDescription(tool),
            kind: "tool_search",
            ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
          }))
          : [];
        return result({
          tools: page,
          total,
          next_offset: offset + page.length < total ? offset + page.length : null,
          ...(discoveryTools.length > 0 ? { discovery_tools: discoveryTools } : {}),
        });
      },
    ),
  );

  server.registerTool(
    "codex_tool_wait",
    {
      title: "Poll a detached Codex Native tool result",
      description: afterSafeStart(
        contract,
        "Poll the call_id returned by codex_tool_in_progress. This never starts or repeats the original operation. If it is still running, wait briefly before polling again; when complete, the original terminal tool result is returned and consumed.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        call_id: z.string().regex(/^call_[A-Za-z0-9_-]{16,128}$/),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_tool_wait",
      turnReference(contract, input),
      extra,
      async claimed => {
        const response = await callTurnBroker<{
          state?: unknown;
          delivered?: unknown;
          detached?: unknown;
          toolResult?: BrokerToolResult;
        }>(
          options.brokerSocketPath,
          {
            method: "invoke_status",
            bindingId: claimed.bindingId,
            callId: input.call_id,
          },
          5_000,
          extra.signal,
        );
        if (response.state === "completed" && response.toolResult) {
          return asMcpResult(response.toolResult);
        }
        if (response.state === "running") {
          return result({
            code: "codex_tool_still_running",
            call_id: input.call_id,
            delivered: response.delivered === true,
            detached: response.detached === true,
            retryable: true,
            retry_after_ms: 30_000,
            message: "The original Codex Native operation is still running. Do not repeat it; poll codex_tool_wait with the same call_id again after about 30 seconds.",
          });
        }
        if (response.state === "completed_elsewhere") {
          return result({
            code: "codex_tool_result_already_consumed",
            call_id: input.call_id,
            retryable: false,
            message: "This Codex Native call already completed through its original response path; no detached result remains to consume.",
          }, true);
        }
        return result({
          code: "codex_tool_call_unknown",
          call_id: input.call_id,
          retryable: false,
          message: "No pending or detached Codex Native result exists for this call_id in the current turn.",
        }, true);
      },
    ),
  );

  if (contract === "native") {
    for (const [name, schema, readOnly] of [
      ["codex_computer_use_observe", computerUseObserveSchema, true],
      ["codex_computer_use_action", computerUseActionSchema, false],
    ] as const) {
      server.registerTool(name, {
        title: readOnly ? "Observe native Windows state" : "Act on an observed native Windows window",
        description: readOnly
          ? "Finite Sky list_apps, list_windows or window_state. Fresh native structured state, no activation or screenshot. Supply knownObservationId only when its full prior observation remains in context; unchanged evidence then returns a compact verified delta. Reuses persistent module/window bindings."
          : "Finite Sky activate_window, type_text or activate_and_observe on an enumerated exact app/window. Sky enforces safety and foreground checks. Input activates its own window. activate_and_observe activates once then returns fresh structured evidence. No retries, saving, confirmation or arbitrary JavaScript.",
        inputSchema: { turn_token: turnTokenSchema, ...schema.shape },
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly },
      }, async (input: ComputerUseOperation & { turn_token: string }, extra: McpRequestExtra) => withClaimedTurn(name, input.turn_token, extra,
        claimed => runComputerUse(claimed, schema.parse(input), extra.signal)));
    }
    server.registerTool(
      "codex_windows_computer_use_observe",
      {
        title: "Deprecated Windows CU observation stub",
        description: "Deprecated ABI compatibility stub. It never routes Windows desktop work and always fails fast. Use official node_repl + @oai/sky for native Windows Computer Use.",
        inputSchema: {
          turn_token: turnTokenSchema,
          operation: z.enum([
            "health",
            "list_windows",
            "snapshot",
            "accessibility_tree",
            "find",
            "element_info",
            "wait",
          ]),
          arguments: jsonArgumentsSchema.optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => result({
        code: "legacy_windows_computer_use_disabled",
        retryable: false,
        message: "This legacy Windows Computer Use bridge is disabled. Use official mcp__node_repl__js with @oai/sky for native Windows Computer Use.",
      }, true),
    );

    server.registerTool(
      "codex_readonly_tool_call",
    {
      title: "Call a read-only Codex tool",
      description: afterSafeStart(
        contract,
        "Invoke a conservatively allowlisted read-only tool from the current outer Codex turn. This bridge is intentionally narrow: it currently supports Windows Computer Use observation tools and rejects foreground activation.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (toolInput, extra) => withClaimedTurn(
      "codex_readonly_tool_call",
      turnReference(contract, toolInput),
      extra,
      async claimed => {
        const args = toolInput.arguments ?? {};
        assertWindowsComputerUseReadOnlyCall(toolInput.wire_name, args);
        const tool = exactVisibleStructuredTool(claimed.environment, contract, toolInput.wire_name);
        return invoke(claimed.bindingId, claimed.environment, tool, { arguments: args }, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_windows_computer_use_action",
    {
      title: "Deprecated Windows CU action stub",
      description: "Deprecated ABI compatibility stub. It never performs Windows UI actions and always fails fast. Use official node_repl + @oai/sky for native Windows Computer Use.",
      inputSchema: {
        turn_token: turnTokenSchema,
        operation: z.enum([
          "click",
          "double_click",
          "move",
          "drag",
          "scroll",
          "type_text",
          "keypress",
          "focus",
          "invoke",
          "set_value",
          "activate_window",
        ]),
        arguments: jsonArgumentsSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({
      code: "legacy_windows_computer_use_disabled",
      retryable: false,
      message: "This legacy Windows Computer Use bridge is disabled. Use official mcp__node_repl__js with @oai/sky for native Windows Computer Use.",
    }, true),
  );

  server.registerTool(
    "codex_windows_computer_use_call",
    {
      title: "Deprecated Windows CU compatibility stub",
      description: afterSafeStart(
        contract,
        "Deprecated ABI compatibility stub. It never routes Windows desktop work and always fails fast. Use official node_repl + @oai/sky for native Windows Computer Use.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({
      code: "legacy_windows_computer_use_disabled",
      retryable: false,
      message: "This legacy Windows Computer Use bridge is disabled. Use official mcp__node_repl__js with @oai/sky for native Windows Computer Use.",
    }, true),
  );

  }

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: afterSafeStart(contract, [
        "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.",
        "When wire_name is exec_command or shell_command (including a namespaced variant), apply the command-safety compatibility rule from that inventory entry and keep inspection/probing to one logical OS operation per call.",
        ...(contract === "native" ? [
          `A pending context-compaction request can also provide the reserved ${CODEX_COMPACTION_CONTROL_WIRE_NAME} operation, which is not listed by inventory.`,
          `A passive recovery checkpoint may similarly provide ${CODEX_RECOVERY_CHECKPOINT_WIRE_NAME}; both controls accept only the issued one-shot token and {handoff_id, summary}.`,
          `If the current connector does not expose codex_turn_complete, the reserved ${CODEX_COMPLETION_CONTROL_WIRE_NAME} operation submits its receipt through this stable ABI; pass turn_token at the top level and the receipt fields in arguments.`,
          "These controls store summaries for continuation/recovery; they do not execute commands, access files, or invoke other tools.",
          PARALLEL_COMMAND_STABLE_ABI_RULE,
          `Enhanced tool-capable turns may also bind the reserved ${CODEX_OUTPUT_CONTROL_WIRE_NAME} operation. It is supplied by the prompt, not inventory, and accepts only {kind, text}.`,
        ] : []),
      ].join(" ")),
      inputSchema: {
        ...turnReferenceInput(contract),
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (toolInput, extra) => {
      const { wire_name, arguments: args, input } = toolInput;
      const requestId = turnReference(contract, toolInput);
      if (contract === "native" && wire_name === CODEX_OUTPUT_CONTROL_WIRE_NAME) {
        return result(await submitNativeOutputControl(
          options.brokerSocketPath, requestId, args, input, extra.signal,
        ));
      }
      if (contract === "native" && (wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME
        || wire_name === CODEX_RECOVERY_CHECKPOINT_WIRE_NAME)) {
        if (input !== undefined) {
          throw new Error("Checkpoint control handoff does not accept freeform input");
        }
        const handoffId = args?.handoff_id;
        const summary = args?.summary;
        if (typeof handoffId !== "string" || handoffId.length === 0) {
          throw new Error("Checkpoint control handoff requires handoff_id");
        }
        if (typeof summary !== "string") {
          throw new Error("Checkpoint control handoff requires summary");
        }
        await callTurnBroker(options.brokerSocketPath, {
          method: wire_name === CODEX_RECOVERY_CHECKPOINT_WIRE_NAME
            ? "submit_recovery_checkpoint"
            : "submit_compaction_handoff",
          token: requestId,
          handoffId,
          summary,
        }, 5_000, extra.signal);
        return result({ submitted: true });
      }
      return withClaimedTurn("codex_tool_call", requestId, extra, async claimed => {
        if (contract === "native" && wire_name === CODEX_COMPLETION_CONTROL_WIRE_NAME) {
          if (input !== undefined) {
            throw new Error("Completion receipt does not accept freeform input");
          }
          const receipt = args ?? {};
          const state = receipt.state;
          const summary = receipt.summary;
          const completedRequirements = receipt.completed_requirements;
          const blockedRequirements = receipt.blocked_requirements;
          const remainingActionableRequirements = receipt.remaining_actionable_requirements;
          const blocker = receipt.blocker;
          const stringArray = (value: unknown, name: string): string[] => {
            if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim().length === 0)) {
              throw new Error(`Completion receipt ${name} must be an array of non-empty strings`);
            }
            return value;
          };
          if (state !== "complete" && state !== "blocked") {
            throw new Error("Completion receipt state must be complete or blocked");
          }
          if (typeof summary !== "string" || summary.trim().length === 0) {
            throw new Error("Completion receipt summary must be a non-empty string");
          }
          if (blocker !== undefined && (typeof blocker !== "string" || blocker.trim().length === 0)) {
            throw new Error("Completion receipt blocker must be a non-empty string when present");
          }
          const response = await callTurnBroker<{ accepted: true }>(options.brokerSocketPath, {
            method: "native_complete",
            token: requestId,
            activityId: claimed.activityId,
            completionState: state,
            completionSummary: summary,
            completedRequirements: stringArray(completedRequirements ?? [], "completed_requirements"),
            blockedRequirements: stringArray(blockedRequirements ?? [], "blocked_requirements"),
            remainingActionableRequirements: stringArray(
              remainingActionableRequirements ?? [],
              "remaining_actionable_requirements",
            ),
            ...(typeof blocker === "string" ? { blocker } : {}),
          }, 5_000, extra.signal);
          return result(response);
        }
        if (contract === "native" && wire_name === CODEX_PARALLEL_COMMAND_CONTROL_WIRE_NAME) {
          if (input !== undefined) {
            throw new Error("Parallel command fallback does not accept freeform input");
          }
          const parsed = parallelCommandBatchSchema.safeParse(args ?? {});
          if (!parsed.success) {
            throw new Error(`Parallel command fallback arguments are invalid: ${parsed.error.message}`);
          }
          return runParallelCommands(claimed, parsed.data.commands, extra.signal);
        }
        if (contract === "native" && (wire_name === CODEX_COMPUTER_USE_OBSERVE || wire_name === CODEX_COMPUTER_USE_ACTION)) {
          if (input !== undefined) throw new Error("Structured Computer Use does not accept freeform input");
          const parsed = (wire_name === CODEX_COMPUTER_USE_OBSERVE ? computerUseObserveSchema : computerUseActionSchema).parse(args ?? {});
          return runComputerUse(claimed, parsed, extra.signal);
        }
        const bound = claimed.environment;
        const tool = safeVisibleTools(bound, contract)
          .find(candidate => wireName(candidate) === wire_name);
        if (!tool) {
          const gateway = execGateway(bound);
          const hiddenOuterTool = bound.tools.some(candidate => wireName(candidate) === wire_name);
          if (!gateway || hiddenOuterTool || !gatewayToolNameIsValid(wire_name)) {
            throw new Error(`Codex tool is not available in this turn: ${wire_name}`);
          }
          if (input !== undefined && args && Object.keys(args).length > 0) {
            throw new Error(`Codex nested tool ${wire_name} accepts either arguments or freeform input, not both`);
          }
          if (isGatewayAgentWaitTool(wire_name) && input !== undefined) {
            throw new Error(`ChatGPT Web wait_agent requires structured arguments and timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`);
          }
          const invocationArguments = normalizeStructuredToolArguments(wire_name, args ?? {});
          assertGatewayToolArguments(wire_name, invocationArguments);
          return invoke(claimed.bindingId, bound, gateway, {
            input: execGatewayProgram(wire_name, input !== undefined, {
              ...(input !== undefined ? { input } : { arguments: invocationArguments }),
            }, bound.tools.map(wireName)),
            gatewayResult: true, requestedTool: wire_name, semanticArguments: input === undefined ? invocationArguments : undefined, semanticInput: input,
          }, extra.signal);
        }
        if (tool.freeform) {
          if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
          if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
          return invoke(claimed.bindingId, bound, tool, {
            input: tool === execGateway(bound) ? transportBoundRawExecProgram(input, wireName(tool)) : input,
          }, extra.signal);
        }
        if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
        const invocationArguments = normalizeStructuredToolArguments(wire_name, args ?? {});
        assertBrowserToolArguments(tool, invocationArguments);
        return invoke(claimed.bindingId, bound, tool, { arguments: invocationArguments }, extra.signal);
      });
    },
  );

  if (contract === "native") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Acknowledge Codex task completion",
        description: `Internal control-plane acknowledgement only. This tool does not run commands, modify files, contact external services, or change user data. Submit the mandatory Full Harness completion receipt when this tool is callable on the current connector surface. If the current connector reports codex_turn_complete is not callable or missing, use codex_tool_call with wire_name ${CODEX_COMPLETION_CONTROL_WIRE_NAME}, keeping turn_token at the top level and the receipt fields in arguments; do not search the outer Codex registry or retry the unavailable direct tool. Use state=complete only with no blocked requirements and no blocker. Use state=blocked only with at least one blocked requirement and a concrete blocker. remaining_actionable_requirements must always be empty.`,
        inputSchema: {
          turn_token: turnTokenSchema,
          state: z.enum(["complete", "blocked"]),
          summary: z.string().min(1).max(100_000),
          completed_requirements: z.array(z.string().min(1).max(20_000)).max(200).default([]),
          blocked_requirements: z.array(z.string().min(1).max(20_000)).max(200).default([]),
          remaining_actionable_requirements: z.array(z.string().min(1).max(20_000)).max(200).default([]),
          blocker: z.string().min(1).max(100_000).optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input, extra) => withClaimedTurn(
        "codex_turn_complete",
        input.turn_token,
        extra,
        async claimed => {
          console.error(`[chatgpt-web-mcp] codex_turn_complete entered scope=${requestScopeSummary(extra)} state=${input.state}`);
          if (input.remaining_actionable_requirements.length > 0) {
            throw new Error(
              "Completion rejected: actionable requirements remain: "
              + input.remaining_actionable_requirements.join("; "),
            );
          }
          if (input.state === "complete") {
            if (input.blocked_requirements.length > 0 || input.blocker !== undefined) {
              throw new Error("Completion rejected: complete status cannot include blocked requirements or a blocker");
            }
          } else {
            if (input.blocked_requirements.length === 0) {
              throw new Error("Completion rejected: blocked completion must identify blocked requirements");
            }
            if (!input.blocker?.trim()) {
              throw new Error("Completion rejected: blocked completion requires a concrete blocker");
            }
          }
          const response = await callTurnBroker<{ accepted: true }>(options.brokerSocketPath, {
            method: "native_complete",
            token: input.turn_token,
            activityId: claimed.activityId,
            completionState: input.state,
            completionSummary: input.summary,
            completedRequirements: input.completed_requirements,
            blockedRequirements: input.blocked_requirements,
            remainingActionableRequirements: input.remaining_actionable_requirements,
            ...(input.blocker !== undefined ? { blocker: input.blocker } : {}),
          }, 5_000, extra.signal);
          return result(response);
        },
      ),
    );
  }

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Acknowledge result completion",
        description: "Internal control-plane acknowledgement only. This tool does not run commands, modify files, contact external services, or change user data. Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
        inputSchema: {
          request_id: turnTokenSchema,
          final_answer: z.string().min(1).max(5_000_000),
        },
        outputSchema: {
          completed: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id, final_answer }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_complete scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ completed: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_complete",
          token: request_id,
          finalAnswer: final_answer,
        }, null, extra.signal);
        return result(response);
      },
    );
  }

  await server.connect(filterMcpAdvertisements(
    observeMcpToolCalls(new StdioServerTransport(), BRIDGE_TOOL_NAMES), DEPRECATED_MCP_TOOLS,
  ));
}
