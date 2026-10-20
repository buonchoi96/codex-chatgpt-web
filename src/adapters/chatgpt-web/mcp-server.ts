import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { VERSION } from "../../version";
import {NativeAsyncToolJobs,NATIVE_ASYNC_AUTO_WAIT_MS,NATIVE_ASYNC_POLL_MAX_CHARS,nativeAsyncToolScope} from "./native-async-tools";
import type { ChatGptTurnEnvironment } from "./environment";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME, CODEX_RECOVERY_CHECKPOINT_WIRE_NAME } from "./native-compaction-control";
import { callTurnBroker, TurnBrokerTimeoutError, type BrokerRetirementDiagnostics, type BrokerToolResult } from "./turn-broker";
import { observeMcpToolCalls } from "./mcp-observation";
import {ARCHIVE_READ_CONTROL_WIRE_NAME,assertArchiveReadProof} from './archive-read-proof';
import {gatewayMetadataProgram,restoreGatewayResultMetadata} from './gateway-result-metadata';
import {nativeCommandRegistryProgram,resolveNativeCommandDescriptor,nativeCommandDescriptorGuard} from './native-command-schema';
import {classifyChatGptToolFailure} from './tool-failure-classification';
import { BlockedOperationLedger } from './blocked-operation-ledger';
import {readBlockedOperationReview,SAFETY_REVIEW_CONTROL_WIRE_NAME,type BlockedOperationReviewOptions} from './blocked-operation-review';
import {CODEX_PARALLEL_COMMAND_CONTROL_WIRE_NAME,parallelCommandBatchSchema,NativeCommandCapacity,runParallelNativeCommands,isIndependentLiteralRead,type ParallelCommand} from './parallel-native-commands';
import {ScreenObservationRegistry,screenObserveArguments,NativeScreenObservationError,NativeScreenPublishedFrameStaleError,type NativeScreenProvider} from './screen-observation';
import {appendUnverifiedObserverCompatibility} from './legacy-observation-routing';

interface ClaimedTurn {
  bindingId: string;
  activityId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number; commandOwnerId?:string };
  commandAdmission?: 'active' | 'control_only';
  commandOwnerId?:string;
}

export type ChatGptMcpContract = "native" | "safe";

const BRIDGE_TOOL_NAMES = new Set([
  "codex_turn_start",
  "codex_exec",
  "codex_parallel_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_screen_observe",
  "codex_safety_review",
  "codex_tool_inventory",
  "codex_tool_call",
  "codex_tool_start",
  "codex_tool_poll",
  "codex_turn_complete",
]);

const GATEWAY_AGENT_WAIT_TOOL_NAMES = new Set([
  "multi_agent_v1__wait_agent",
  "multi_agent_v2__wait_agent",
  "collaboration__wait_agent",
]);

const turnTokenSchema = z.string().min(20).max(256);
// Native task capabilities are turn_<32>; strictly one-shot compaction/recovery
// handoffs have control_<32 hex> tokens, authenticated again by the exact
// broker transaction and wire name. Never accept arbitrary token strings.
const nativeTurnTokenSchema = z.string().regex(/^(?:turn_[A-Za-z0-9_-]{32}|control_[a-f0-9]{32})$/,
  "Copy the exact current turn_token or one-shot control token; never guess or reuse a capability.")
  .describe("Opaque, exact capability from the current request: turn_ + 32 characters, or a one-shot control_ + 32 lowercase hex characters. Do not alter its case or infer one from earlier turns.");
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
const safetyReviewShape={offset:z.number().int().min(0).max(10_000).optional(),
  limit:z.number().int().min(1).max(50).optional(),snapshot_sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()};
const safetyReviewArgumentsSchema=z.strictObject(safetyReviewShape);
// Match Codex's default wait interval while returning before the MCP invocation deadline.
export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 30_000;
const AGENT_WAIT_TRANSPORT_RULE = `ChatGPT Web transport rule: wait for exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS / 1_000} seconds per call, matching the Codex default, then release the MCP channel so spawned Web agents can use their own tools. A wait timeout is not task completion; check agent progress and wait again if needed. Keep the native tool's declared arguments.`;
// The OpenAI tunnel currently owns a two-minute command-response deadline. The local MCP server
// must settle first so an abandoned native tool call is returned as an MCP error instead of
// letting the tunnel tear down and poison its long-lived stdio transport.
export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000;

/**
 * Native exec_command is expected to yield a session_id for slow commands.
 * Waiting inside the initial native tool RPC for an unbounded command can
 * consume the entire 90s MCP transport budget and retire the Codex goal turn
 * despite a live browser. Supply a short default ONLY when the exact native
 * registry advertises yield_time_ms and the caller did not choose a value.
 * This never replays or cancels a dispatched command, and does not reinterpret
 * shell_command's timeout_ms (which is an execution deadline).
 */
export const CHATGPT_WEB_NATIVE_EXEC_DEFAULT_YIELD_MS = 1_000;

export function withShortNativeExecYield(
  tool: Pick<CodexTool, "name" | "parameters">,
  payload: { arguments?: Record<string, unknown>; input?: string },
): typeof payload {
  if (tool.name !== "exec_command" || payload.arguments === undefined
    || Object.hasOwn(payload.arguments, "yield_time_ms")) return payload;
  const properties = tool.parameters?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)
    || !Object.hasOwn(properties, "yield_time_ms")) return payload;
  return { ...payload, arguments: {
    ...payload.arguments,
    yield_time_ms: CHATGPT_WEB_NATIVE_EXEC_DEFAULT_YIELD_MS,
  } };
}


const ZERO_RISK_MCP_INSTRUCTIONS = [
  "For each pasted Codex Web GPT request, begin with codex_turn_start using the request_id in its request block.",
  "Use that request_id with the Codex tools needed for the task.",
  "When the task is finished, send the complete answer with codex_turn_complete.",
  "If a tool returns an error, report that error instead of changing the request_id.",
].join(" ");

function turnReferenceInput(contract: ChatGptMcpContract): Record<string, z.ZodString> {
  return contract === "safe"
    ? { request_id: turnTokenSchema }
    : { turn_token: nativeTurnTokenSchema };
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
    && wireName(tool) !== CODEX_RECOVERY_CHECKPOINT_WIRE_NAME
    && !BRIDGE_TOOL_NAMES.has(tool.name)
    // Zero Risk does not expose model-authored JavaScript. Automatic Full mode keeps the native
    // Codex exec surface and applies its transport guard at invocation time below.
    && (tool.namespace !== undefined || tool.name !== "exec")
    && (!tool.namespace || !bridgeNamespaces.has(tool.namespace))
  ));
}

function isAgentWaitTool(tool: CodexTool): boolean {
  return isGatewayAgentWaitTool(wireName(tool));
}

function isGatewayAgentWaitTool(name: string): boolean {
  return GATEWAY_AGENT_WAIT_TOOL_NAMES.has(name);
}

function browserToolDescription(tool: CodexTool): string {
  if (isAgentWaitTool(tool)) return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE} This rule is enforced for wait_agent calls made inside exec; recursive raw exec is unavailable.`;
  }
  return tool.description;
}

function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  if (!isAgentWaitTool(tool)) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown>
    : {};
  // The cloned native schema must not advertise a default that contradicts our required interval.
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
        description: `Required transport-safe polling interval. Use exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS}; a timed-out wait does not mean the agents have finished.`,
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
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
  const assessment=classifyChatGptToolFailure(value);
  if(assessment.classification!=='NO_FAILURE')console.error(`[chatgpt-web-mcp] tool_failure ${JSON.stringify({
    classification:assessment.classification,allowTechnicalFallback:assessment.allowTechnicalFallback,
  })}`);
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError !== undefined ? { isError: value.isError } : {}),
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
  if (!isGatewayAgentWaitTool(tool.name)) return tool.description;
  return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
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

function execGatewayResultProgram(invocation: string[],metadataMarker?:string): string {
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
    // Some native connector wrappers expose multimodal blocks in content_items
    // while content is only the string "Tool returned multimodal content."
    // Never stringify that wrapper: it loses image items and leaks their base64.
    "    if (Array.isArray(value.content_items)) { for (const item of value.content_items) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
    ...(metadataMarker?gatewayMetadataProgram(metadataMarker):[]),
  ].join("\n");
}

export function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
  excludedNames: string[],
  metadataMarker?:string,
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
  ],metadataMarker);
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
  metadataMarker?: string,
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
  ],metadataMarker);
}

export async function createChatGptMcpServer(options: {
  brokerSocketPath: string;
  contract?: ChatGptMcpContract;
  transport: Transport;
  screenObserver?:{provider:NativeScreenProvider;grantWireName:string};
  blockedOperationLedger?: BlockedOperationLedger;
}): Promise<McpServer> {
  const contract = options.contract ?? "native";
  const blockedOperationLedger = options.blockedOperationLedger ?? new BlockedOperationLedger();
  const commandCapacity = new NativeCommandCapacity();
  type NativeToolResponse=ReturnType<typeof asMcpResult>|ReturnType<typeof result>;
  const asyncTools = new NativeAsyncToolJobs<NativeToolResponse>();
  const screenObservers=options.screenObserver?new ScreenObservationRegistry(options.screenObserver.provider):undefined;
  const legacyObserverNotices=new Set<string>();
  const server = new McpServer(
    { name: contract === "safe" ? "codex-safe" : "codex-native", version: VERSION },
    contract === "safe" ? { instructions: ZERO_RISK_MCP_INSTRUCTIONS } : undefined,
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
      return { ...claimed, activityId,environment:{...claimed.environment,commandOwnerId:claimed.commandOwnerId} };
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

  const safetyReview=(claimed:ClaimedTurn,input:BlockedOperationReviewOptions)=>{
    const review=readBlockedOperationReview(blockedOperationLedger,claimed.environment,input);
    const isError=['unavailable','snapshot_changed','invalid_cursor'].includes(review.status);
    return result({...review,...(isError?{error:{code:`safety_review_${review.status}`,retryable:false,
      message:'The unresolved-operation review could not complete. Preserve the original blocker; no native operation was executed or retried.'}}:{})},isError);
  };
  server.registerTool('codex_safety_review',{
    title:'Review unresolved native operation records',
    description:afterSafeStart(contract,'Read one page of local unresolved-operation bookkeeping for the current workspace. No command execution, retry, approval or resolution is performed. Complete pagination using next_offset and snapshot_sha256; changed snapshots require a fresh review. Local records do not prove execution or grant permission.'+(contract==='native'?' The same read-only operation is available through codex_tool_call wire_name codex.control.safety_review.':'')),
    inputSchema:z.strictObject({...turnReferenceInput(contract),...safetyReviewShape}),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async(input,extra)=>withClaimedTurn('codex_safety_review',turnReference(contract,input),extra,
    claimed=>safetyReview(claimed,{offset:input.offset,limit:input.limit,snapshot_sha256:input.snapshot_sha256})));

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

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number; commandOwnerId?:string },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
    metadataMarker?:string,
    commandCapacityReserved=false,
    trustedNestedWireName?:string,
    timeoutOverride?:number|null,
  ) => {
    // Admission failure precedes dispatch and must not retire siblings already in flight.
    const commandOwner=bound.commandOwnerId??bindingId;
    payload = withShortNativeExecYield(tool, payload);
    const nativeCommand=['exec_command','shell_command'].includes(tool.name);
    const opaqueGateway=tool.name==='exec'&&tool.freeform===true;
    const cmd=payload.arguments?.cmd??payload.arguments?.command;
    const read=nativeCommand&&typeof cmd==='string'&&isIndependentLiteralRead({cmd,tty:payload.arguments?.tty===true});
    const releaseCommand=!commandCapacityReserved&&(nativeCommand||opaqueGateway)
      ?commandCapacity.acquire(commandOwner,1,read?'read':'exclusive'):undefined;
    const timeoutMs = timeoutOverride === undefined ? chatGptMcpInvocationTimeout(bound) : timeoutOverride;
    const observationId = randomBytes(16).toString("hex");
    let safetyObservationRecorded = false;
    let safetyLedgerFailure = false;
    const recordSafetyRefusal = (): void => {
      if (safetyObservationRecorded) return;
      safetyObservationRecorded = true;
      // A refusal is not proof that native dispatch never happened. Persist an unresolved
      // prerequisite without command text, images, tokens or other raw arguments.
      try {
        const blocker = blockedOperationLedger.recordSafetyRefusal({
          tool: wireName(tool),
          arguments: tool.freeform ? payload.input : payload.arguments,
          owner: bindingId,
          targetScope: { cwd: bound.cwd, roots: bound.roots },
          observationId,
        });
        console.error(`[chatgpt-web-mcp] safety_blocker_recorded ${JSON.stringify({
          blocker_id: blocker.blocker_id, tool: wireName(tool), resolution: blocker.resolution,
        })}`);
      } catch (journalError) {
        safetyLedgerFailure = true;
        console.error(`[chatgpt-web-mcp] safety_blocker_persistence_failed ${journalError instanceof Error ? journalError.name : "UnknownError"}`);
      }
    };
    const ledgerFailure = () => ({
      code: "safety_blocker_persistence_failed",
      classification: "SAFETY_STATUS_UNDETERMINED",
      resolution: "PENDING_RECEIPT_RECONCILIATION",
      execution_state: "unknown",
      retryable: false,
      message: "The safety refusal remains binding. Its persistent record could not be verified; retain this receipt for review. Do not retry or switch tools.",
    });
    try {
      const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
        method: "invoke",
        bindingId,
        wireName: wireName(tool),
        freeform: tool.freeform === true,
        ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
      }, timeoutMs, signal);
      const restoredResponse = metadataMarker ? restoreGatewayResultMetadata(response, metadataMarker) : response;
      // A nested name is supplied only by our locally generated exact-tool
      // gateway program; arbitrary model-authored exec is never a grant source.
      if(screenObservers&&(trustedNestedWireName??wireName(tool))===options.screenObserver?.grantWireName)
        screenObservers.remember(bindingId,commandOwner,restoredResponse);
      if(releaseCommand)releaseCommand.observeResult(restoredResponse);
      else if((nativeCommand||commandCapacityReserved)&&!(commandCapacityReserved&&
        (nativeCommand||trustedNestedWireName==='exec_command'||trustedNestedWireName==='shell_command'))){
        // Parallel children are attributed by their batch's exact lease in
        // runParallelNativeCommands. Owner-wide observation can consume a
        // sibling batch's reservation when responses finish out of order.
        // Keep owner observation for reserved nested write_stdin receipts.
        commandCapacity.observeResult(commandOwner,restoredResponse);
      }
      if(tool.name==='write_stdin'&&typeof payload.arguments?.session_id==='number')commandCapacity.observeResult(commandOwner,restoredResponse,payload.arguments.session_id);
      const assessment = classifyChatGptToolFailure(restoredResponse);
      if (assessment.classification === "SAFETY_STATUS_UNKNOWN_OR_BLOCKED") {
        const failure = { code: "safety_status_unknown_or_blocked" as const, tool: wireName(tool) };
        recordSafetyRefusal();
        try {
          await callTurnBroker(options.brokerSocketPath, { method: "release", bindingId, failure });
        } catch (releaseError) {
          throw new AggregateError(
            [releaseError],
            "OpenAI safety refusal was returned by Codex Native but its browser turn capability could not be retired",
          );
        }
      }
      // Keep the exact native error, structured payload, metadata and images. Persistence
      // failure is an additional unresolved receipt, never a successful/forgotten blocker.
      const original=safetyLedgerFailure ? {
        ...restoredResponse,
        content: [...restoredResponse.content, { type: "text", text: JSON.stringify(ledgerFailure()) }],
      } : restoredResponse;
      const legacyWire=trustedNestedWireName??wireName(tool);
      const noticeKey=`${bindingId}:${legacyWire}`;
      const annotated=assessment.classification==='NO_FAILURE'&&!safetyLedgerFailure&&!legacyObserverNotices.has(noticeKey)
        ?appendUnverifiedObserverCompatibility(legacyWire,original):original;
      if(annotated!==original){
        // Rate-limit advice per current turn binding and legacy tool. A fresh
        // binding after compaction/token rotation naturally rechecks status.
        if(legacyObserverNotices.size>=256)legacyObserverNotices.delete(legacyObserverNotices.values().next().value!);
        legacyObserverNotices.add(noticeKey);
      }
      return asMcpResult(annotated);
    } catch (error) {
      releaseCommand?.retainUncertain();
      const thrownSafetyRefusal = classifyChatGptToolFailure({ isError: true, error }).classification
        === "SAFETY_STATUS_UNKNOWN_OR_BLOCKED";
      if (thrownSafetyRefusal) recordSafetyRefusal();
      // A cancelled/timed-out MCP request no longer has a consumer for the native result. Revoke
      // the whole turn capability so the broker drops the pending invocation and every later call
      // from that abandoned ChatGPT response fails explicitly against its retired binding.
      let diagnostics: BrokerRetirementDiagnostics | undefined;
      try {
        const retired = await callTurnBroker<{ released: boolean; diagnostics?: BrokerRetirementDiagnostics }>(options.brokerSocketPath, {
          method: "release",
          bindingId,
          ...(error instanceof TurnBrokerTimeoutError ? {
            failure: { code: "codex_tool_timeout" as const, tool: wireName(tool), timeoutMs: timeoutMs ?? CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS },
          } : thrownSafetyRefusal ? {
            failure: { code: "safety_status_unknown_or_blocked" as const, tool: wireName(tool) },
          } : {}),
        });
        diagnostics = retired.diagnostics;
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "Codex Native invocation failed and its abandoned broker binding could not be retired",
        );
      }
      if (error instanceof TurnBrokerTimeoutError) {
        const toolName = wireName(tool);
        console.error(
          `[chatgpt-web-mcp] ${toolName} did not complete within ${timeoutMs}ms; retired its turn binding`
          + ` broker_state_at_retirement=${JSON.stringify(diagnostics ?? null)}`,
        );
        return result({
          code: "codex_tool_timeout",
          tool: toolName,
          timeout_ms: timeoutMs,
          retryable: false,
          ...(diagnostics === undefined ? {} : { broker_state_at_retirement: diagnostics }),
          message: `Codex tool ${toolName} did not complete before the MCP transport deadline. The current turn binding was retired; do not retry it in this ChatGPT response. Delivery confirms handoff to Codex; execution and approval status are unknown.`,
        }, true);
      }
      if (thrownSafetyRefusal) {
        return result({
          code: "safety_status_unknown_or_blocked", tool: wireName(tool), retryable: false,
          ...(safetyLedgerFailure ? { safety_ledger: ledgerFailure() } : {}),
          message: "Codex Native reported an explicit OpenAI safety refusal. Execution is unverified; do not replay this operation or switch tools to bypass the refusal.",
        }, true);
      }
      throw error;
    } finally { releaseCommand?.(); }
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
    const marker=`codex-tool-result:${randomBytes(24).toString('hex')}:`;
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload, bound.tools.map(wireName),marker),
    }, signal,marker,nestedToolName==='write_stdin',nestedToolName);
  };

  const parallelCommands = async (claimed: ClaimedTurn, commands: ParallelCommand[], signal?: AbortSignal) => {
    if(claimed.commandAdmission!=='active')throw new Error('Parallel native task admission is unavailable or control-only; no command was dispatched');
    const bound=claimed.environment;
    const execCandidates=bound.tools.filter(tool=>!tool.namespace&&tool.name==='exec_command');
    const shellCandidates=bound.tools.filter(tool=>!tool.namespace&&tool.name==='shell_command');
    const selected=execCandidates.length?execCandidates:shellCandidates;
    if(selected.length>1)throw new Error('This Codex turn advertises duplicate native command interfaces; parallel dispatch is ambiguous and no command was dispatched');
    const direct=selected[0];
    const gateway=direct?undefined:execGateway(bound);
    if(!direct&&!gateway)throw new Error('This Codex turn does not expose a native command interface; no command was dispatched');
    // Validate read-only admission before even the metadata inventory request.
    if(commands.some(command=>!isIndependentLiteralRead(command)))throw new Error('Parallel commands require independent literal reads; no command was dispatched');
    let selectedCommand=direct;
    if(!selectedCommand){
      const marker=`codex-tool-catalog:${randomBytes(16).toString('hex')}:`;
      const response=await invoke(claimed.bindingId,bound,gateway!,{input:nativeCommandRegistryProgram(marker)},signal);
      const catalog=gatewayToolCatalogPage(response,new Set(),marker);
      selectedCommand=resolveNativeCommandDescriptor(catalog.tools);
    }
    const commandArguments=(command:ParallelCommand):Record<string,unknown>=>{
      const properties=selectedCommand.parameters.properties&&typeof selectedCommand.parameters.properties==='object'&&!Array.isArray(selectedCommand.parameters.properties)
        ?selectedCommand.parameters.properties as Record<string,unknown>:{};
      const args:Record<string,unknown>={ [selectedCommand.name==='exec_command'?'cmd':'command']:command.cmd };
      for(const field of ['workdir','yield_time_ms','max_output_tokens','tty'] as const){
        const value=command[field];
        if(value===undefined)continue;
        if(!Object.prototype.hasOwnProperty.call(properties,field)){
          const semanticNote=field==='yield_time_ms'&&selectedCommand.name==='shell_command'
            ?' A shell_command timeout_ms is not equivalent to yield_time_ms.' : '';
          throw new Error(`Native ${selectedCommand.name} does not advertise ${field}; the parallel batch was rejected before dispatch.${semanticNote}`);
        }
        args[field]=value;
      }
      const commandField=selectedCommand.name==='exec_command'?'cmd':'command';
      if(!Object.prototype.hasOwnProperty.call(properties,commandField))
        throw new Error(`Native ${selectedCommand.name} does not advertise ${commandField}; the parallel batch was rejected before dispatch`);
      for(const field of Array.isArray(selectedCommand.parameters.required)?selectedCommand.parameters.required:[])
        if(typeof field!=='string'||!Object.hasOwn(args,field))throw new Error('Native command schema requires an unsupported or missing argument; no command was dispatched');
      return args;
    };
    // Validate every item's requested options before scheduling the first native call.
    const mappedCommands=commands.map(command=>commandArguments(command));
    return runParallelNativeCommands({owner:claimed.commandOwnerId??claimed.bindingId,commands,capacity:commandCapacity,signal,
      invoke:async (_command,index)=>{
        if(direct)return invoke(claimed.bindingId,bound,direct,{arguments:mappedCommands[index]!},signal,undefined,true);
        const marker=`codex-tool-result:${randomBytes(24).toString('hex')}:`;
        const input=nativeCommandDescriptorGuard(selectedCommand)+'\n'+execGatewayProgram(selectedCommand.name,false,
          {arguments:mappedCommands[index]!},bound.tools.map(wireName),marker);
        return invoke(claimed.bindingId,bound,gateway!,{input},signal,marker,true,selectedCommand.name);
      }}).then(asMcpResult);
  };

  if(contract==='native')server.registerTool('codex_parallel_exec',{
    title:'Run independent native commands concurrently',
    description:'Run 2–8 independent literal read commands as separate native invocations. Recognized single-purpose reads only; mutable/shared-state, compound, interactive or approval-requiring commands use serial codex_exec. No retry after cancellation, safety rejection or uncertain execution. If this interface is absent from the connector, use codex_tool_call with wire_name codex.control.parallel_exec and arguments {commands:[...]}; a safety rejection never authorizes switching interfaces.',
    inputSchema:{...turnReferenceInput(contract),commands:parallelCommandBatchSchema.shape.commands},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true},
  },async(input,extra)=>withClaimedTurn('codex_parallel_exec',turnReference(contract,input),extra,
    claimed=>parallelCommands(claimed,input.commands,extra.signal)));

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: afterSafeStart(contract, "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id."),
      inputSchema: {
        ...turnReferenceInput(contract),
        cmd: z.string().min(1).max(100_000),
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
        const releaseCommand = commandCapacity.acquire(claimed.commandOwnerId??claimed.bindingId,1,
          isIndependentLiteralRead({cmd,tty})?'read':'exclusive');
        let commandDispatched=false;
        try {
        const permissions = {
          ...(sandbox_permissions !== undefined ? { sandbox_permissions } : {}),
          ...(justification !== undefined ? { justification } : {}),
          ...(prefix_rule !== undefined ? { prefix_rule } : {}),
        };
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
          commandDispatched=true;
          const response=await invoke(claimed.bindingId, bound, tool, { arguments: args }, extra.signal,undefined,true);
          releaseCommand.observeResult(response);
          if(response.isError===true)releaseCommand.retainUncertain();
          return response;
        }
        const gateway = execGateway(bound);
        if (!gateway) {
          // Capability absence is not a failed or uncertain command execution.
          // Never dispatch through a different transport or retain an unused command slot.
          console.warn(`[chatgpt-web-mcp] native_command_unavailable scope=${requestScopeSummary(extra)} advertised_tools=${bound.tools.length}`);
          return result({
            code: "native_command_unavailable",
            retryable: false,
            command_dispatched: false,
            advertised_tool_count: bound.tools.length,
            message: "This Codex turn did not advertise exec_command, shell_command, or a freeform exec gateway. No command was dispatched. Do not reuse previous-turn command authority or substitute another tool. Continue only with capabilities independently declared in this turn.",
          }, true);
        }
        commandDispatched=true;
        const response=await invoke(claimed.bindingId, bound, gateway, {
          input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
        }, extra.signal,undefined,true);
        releaseCommand.observeResult(response);
        if(response.isError===true)releaseCommand.retainUncertain();
        return response;
        } catch(error) { if(commandDispatched)releaseCommand.retainUncertain(); throw error; }
        finally { releaseCommand(); }
      },
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
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
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
        const payload = { arguments: {
          session_id,
          ...(chars !== undefined ? { chars } : {}),
          ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        } };
        if(yield_time_ms!==undefined&&yield_time_ms>60000)throw new Error('Native command polling must yield within 60000ms; poll the same session again if needed');
        const response=await (tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.bindingId, bound, "write_stdin", false, payload, extra.signal));
        commandCapacity.observeResult(claimed.commandOwnerId??claimed.bindingId,response,session_id);
        return response;
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

  if(contract==='native'&&screenObservers)server.registerTool('codex_screen_observe',{
    title:'Observe the delegated native screen target',
    description:'Read the exact target authorized by a fresh Swift reader grant in this turn. One bounded native final-frame observation returns local CV/UIA/OCR metadata. Optional tree_format adds a bounded source-tagged compact/JSON tree without raw provider-node duplication. In json mode, an explicit latest ack_snapshot_id plus prefer_diff may return a complete UIA-only delta. Separately opt into prefer_mixed_diff to receive UIA provider deltas alongside a complete replace-all-current-frame set of ephemeral OCR/CV nodes; otherwise full snapshots preserve correctness. Stable IDs require a valid grant and untruncated source metadata. UIA pixel correspondence remains unverified and observed patterns grant no input permission. Image delivery is UNAVAILABLE; semantic readiness and OCR may be PARTIAL. No input, screenshots, composer attachments or viewer fallback.',
    inputSchema:{...turnReferenceInput(contract),...screenObserveArguments},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },async(input,extra)=>withClaimedTurn('codex_screen_observe',turnReference(contract,input),extra,async claimed=>{
    if(claimed.commandAdmission!=='active')throw new Error('Screen observation requires the active turn');
    const grantWireName=options.screenObserver!.grantWireName;
    const grantTool=claimed.environment.tools.find(tool=>wireName(tool)===grantWireName);
    if(!grantTool){
      const gateway=execGateway(claimed.environment);
      if(!gateway||!gatewayToolNameIsValid(grantWireName))
        throw new Error('SCREEN_READER_NOT_AVAILABLE: current inventory lacks the configured grant tool');
      // Recheck the real nested registry within this observation invocation.
      // A historical catalog or a model-supplied grant cannot establish it.
      const excludedNames=claimed.environment.tools.map(wireName);
      const marker=`codex-tool-catalog:${randomBytes(16).toString('hex')}:`;
      const response=await invoke(claimed.bindingId,claimed.environment,gateway,{input:gatewayToolCatalogProgram({
        query:grantWireName,offset:0,limit:2,excludedNames,marker,
      })},extra.signal);
      const catalog=gatewayToolCatalogPage(response,new Set(excludedNames),marker);
      if(catalog.tools.filter(tool=>tool.name===grantWireName).length!==1)
        throw new Error('SCREEN_READER_NOT_AVAILABLE: current nested inventory lacks the configured grant tool');
    }
    const owner=claimed.commandOwnerId??claimed.bindingId;
    const validate=async()=>{
      const proof=await callTurnBroker<{bindingId:string;commandOwnerId:string}>(options.brokerSocketPath,
        {method:'screen_observer_validate',bindingId:claimed.bindingId,activityId:claimed.activityId},5000,extra.signal);
      if(proof.bindingId!==claimed.bindingId||proof.commandOwnerId!==owner)throw new Error('SCREEN_READER_OWNER_MISMATCH');
    };
    let dispatched=false;
    try {
      return result(await screenObservers.observe(claimed.bindingId,owner,input,validate,extra.signal,()=>{dispatched=true;}));
    } catch(error) {
      // An obsolete read-only frame is a normal out-of-order completion.
      // Reject its receipt without revoking the newer, valid turn authority.
      // Other dispatched failures retain the existing fail-closed retirement.
      const staleFrame=error instanceof NativeScreenPublishedFrameStaleError;
      if(dispatched&&!staleFrame)await callTurnBroker(options.brokerSocketPath,{method:'release',bindingId:claimed.bindingId},5000);
      if(error instanceof NativeScreenObservationError)
        return result({status:'error',error:{code:error.code},image_delivery_status:'UNAVAILABLE'},true);
      throw error;
    }
  }));

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
        if (gateway) {
          const excludedGatewayNames = bound.tools.map(wireName);
          const marker = `codex-tool-catalog:${randomBytes(16).toString("hex")}:`;
          const nestedOffset = Math.max(0, offset - directMatches.length);
          const nestedLimit = Math.max(0, limit - directPage.length);
          const response = await invoke(claimed.bindingId, bound, gateway, {
            input: gatewayToolCatalogProgram({
              query,
              offset: nestedOffset,
              limit: nestedLimit,
              // A gateway-discovered entry may supplement the outer registry, but it must never
              // duplicate or reopen an outer tool that this contract deliberately hid (including
              // our own MCP namespace in Zero Risk).
              excludedNames: excludedGatewayNames,
              marker,
            }),
          }, extra.signal);
          const catalog = gatewayToolCatalogPage(response, new Set(excludedGatewayNames), marker);
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


  // Original native authorization/argument checks, shared by direct and async.
  const dispatchBoundTool=async(
    claimed:ClaimedTurn,wire_name:string,
    args:Record<string,unknown>|undefined,input:string|undefined,
    signal?:AbortSignal,unbounded=false,
  ):Promise<NativeToolResponse>=>{

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
          const invocationArguments = args ?? {};
          assertGatewayToolArguments(wire_name, invocationArguments);
          const marker=`codex-tool-result:${randomBytes(24).toString('hex')}:`;
          return invoke(claimed.bindingId, bound, gateway, {
            input: execGatewayProgram(wire_name, input !== undefined, {
              ...(input !== undefined ? { input } : { arguments: invocationArguments }),
            }, bound.tools.map(wireName),marker),
          }, signal,marker,false,wire_name,unbounded?null:undefined);
        }
        if (tool.freeform) {
          if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
          if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
          return invoke(claimed.bindingId, bound, tool, {
            input: tool === execGateway(bound) ? transportBoundRawExecProgram(input, wireName(tool)) : input,
          }, signal,undefined,false,undefined,unbounded?null:undefined);
        }
        if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
        const invocationArguments = args ?? {};
        assertBrowserToolArguments(tool, invocationArguments);
        return invoke(claimed.bindingId, bound, tool, { arguments: invocationArguments }, signal,undefined,false,undefined,unbounded?null:undefined);

  };

  const runBoundTool=async(
    turnToken:string,wire:string,args:Record<string,unknown>|undefined,
    input:string|undefined,extra:McpRequestExtra,mode:"auto"|"start",
  )=>{
    const claimed=await claimTurn(mode==="start"?"codex_tool_start":"codex_tool_call",turnToken,extra);
    let background=false;
    try{
      const found=safeVisibleTools(claimed.environment,contract).find(tool=>wireName(tool)===wire);
      const mcpTool=(found?.namespace!==undefined||wire.startsWith("mcp__"))
        && !isGatewayAgentWaitTool(wire);
      if(mode==="start"&&!mcpTool)
        throw Error("Async start only accepts MCP tools from this native Codex turn");
      const scope=nativeAsyncToolScope(wire,found?.namespace);
      if(!mcpTool){
        return await dispatchBoundTool(claimed,wire,args,input,extra.signal);
      }
      const ticket=asyncTools.start(turnToken,scope,wire,async()=>{
        try{
          return await dispatchBoundTool(claimed,wire,args,input,undefined,true);
        }finally{
          await settleTurnActivity(turnToken,claimed.activityId);
        }
      });
      background=true;
      if(mode==="start")return result({...ticket});
      const quick=await asyncTools.quick(turnToken,ticket.job_id,NATIVE_ASYNC_AUTO_WAIT_MS);
      return "job_id" in quick ? result({...quick}) : quick;
    }finally{
      if(!background)await settleTurnActivity(turnToken,claimed.activityId);
    }
  };

  if(contract==="native"){
    server.registerTool("codex_tool_poll",{
      title:"Poll one in-flight Codex MCP tool",
      description:"Read the same-turn job returned by codex_tool_call or codex_tool_start without redispatching it. Reassemble JSON from chunks using next_offset. Unknown does not prove native execution stopped. No auto-retry.",
      inputSchema:{...turnReferenceInput(contract),
        job_id:z.string().regex(/^native_job_[a-f0-9]{48}$/),
        offset:z.number().int().nonnegative().default(0),
        max_chars:z.number().int().min(1).max(NATIVE_ASYNC_POLL_MAX_CHARS).default(8000)},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    },async(input,extra)=>withClaimedTurn("codex_tool_poll",turnReference(contract,input),extra,
      ()=>result(asyncTools.poll(turnReference(contract,input),input.job_id,input.offset,input.max_chars))));
    server.registerTool("codex_tool_start",{
      title:"Start a potentially long-running Codex MCP tool",
      description:"Dispatch an exact MCP wire_name in the current Codex turn and immediately return job_id. Poll with codex_tool_poll. Applies to every configured MCP server without a separate proxy. Never retries or bypasses permission.",
      inputSchema:{...turnReferenceInput(contract),
        wire_name:z.string().min(1).max(1000),
        arguments:jsonArgumentsSchema.optional(),input:z.string().max(5000000).optional()},
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true},
    },async(input,extra)=>runBoundTool(turnReference(contract,input),input.wire_name,input.arguments,input.input,extra,"start"));
  }

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: afterSafeStart(contract, [
        "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle. MCP calls automatically yield a same-turn job receipt after 8 seconds; when status=pending and job_id is returned, call codex_tool_poll with the identical turn_token until completion. Never rerun the original call to poll. Use codex_tool_call with wire_name=codex.control.async_poll and arguments {job_id,offset?,max_chars?} if codex_tool_poll is not advertised; codex.control.async_start accepts {wire_name,arguments?,input?} for explicit immediate start. No per-server setup is required.",
        ...(contract === "native" ? [
          `A pending context-compaction request can also provide the reserved ${CODEX_COMPACTION_CONTROL_WIRE_NAME} operation, which is not listed by inventory.`,
          "Use only that request's issued control token and arguments {handoff_id, summary}. This operation submits the conversation summary to the pending Codex task; it does not execute commands, access files, or invoke other tools.",
          'This connector also implements reserved codex.control.safety_review with arguments {offset?,limit?,snapshot_sha256?}. It uses the same read-only scoped journal review as codex_safety_review; it cannot execute, retry, approve or resolve an operation.',
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
      // Already installed Native2 plugins may not yet list the new poll/start
      // tools. Keep a same-turn fallback inside codex_tool_call itself.
      if(contract==="native"&&wire_name==="codex.control.async_poll"){
        if(input!==undefined)throw Error("Async poll accepts structured arguments only");
        const parsed=z.strictObject({
          job_id:z.string().regex(/^native_job_[a-f0-9]{48}$/),
          offset:z.number().int().nonnegative().default(0),
          max_chars:z.number().int().min(1).max(NATIVE_ASYNC_POLL_MAX_CHARS).default(8000),
        }).parse(args??{});
        return withClaimedTurn("codex_tool_poll",requestId,extra,
          ()=>result(asyncTools.poll(requestId,parsed.job_id,parsed.offset,parsed.max_chars)));
      }
      if(contract==="native"&&wire_name==="codex.control.async_start"){
        if(input!==undefined)throw Error("Async start accepts structured arguments only");
        const parsed=z.strictObject({
          wire_name:z.string().min(1).max(1000),
          arguments:jsonArgumentsSchema.optional(),
          input:z.string().max(5000000).optional(),
        }).parse(args??{});
        return runBoundTool(requestId,parsed.wire_name,parsed.arguments,parsed.input,extra,"start");
      }
      if(contract==='native'&&wire_name===SAFETY_REVIEW_CONTROL_WIRE_NAME){
        if(input!==undefined)throw new Error('Safety review does not accept freeform input');
        const parsed=safetyReviewArgumentsSchema.parse(args??{});
        return withClaimedTurn('codex_safety_review',requestId,extra,claimed=>safetyReview(claimed,parsed));
      }
      if(contract==='native'&&wire_name===CODEX_PARALLEL_COMMAND_CONTROL_WIRE_NAME){
        if(input!==undefined)throw new Error('Parallel command control does not accept freeform input');
        const parsed=parallelCommandBatchSchema.parse(args??{});
        return withClaimedTurn('codex_parallel_exec',requestId,extra,claimed=>parallelCommands(claimed,parsed.commands,extra.signal));
      }
      if(contract==='native'&&wire_name===ARCHIVE_READ_CONTROL_WIRE_NAME){
        if(input!==undefined)throw new Error('Archive read control does not accept freeform input');
        assertArchiveReadProof(args);
        return result(await callTurnBroker(options.brokerSocketPath,{method:'archive_confirm',token:requestId,arguments:args},5000,extra.signal));
      }
      if (contract === "native" && (wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME
        || wire_name === CODEX_RECOVERY_CHECKPOINT_WIRE_NAME)) {
        if (input !== undefined) {
          throw new Error("Compaction control handoff does not accept freeform input");
        }
        const handoffId = args?.handoff_id;
        const summary = args?.summary;
        if (typeof handoffId !== "string" || handoffId.length === 0) {
          throw new Error("Compaction control handoff requires handoff_id");
        }
        if (typeof summary !== "string") {
          throw new Error("Compaction control handoff requires summary");
        }
        await callTurnBroker(options.brokerSocketPath, {
          method: wire_name === CODEX_RECOVERY_CHECKPOINT_WIRE_NAME
            ? "submit_recovery_checkpoint" : "submit_compaction_handoff",
          token: requestId,
          handoffId,
          summary,
        }, 5_000, extra.signal);
        return result({ submitted: true });
      }
      return runBoundTool(requestId,wire_name,args,input,extra,"auto");
    },
  );

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Return the result to Codex",
        description: "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
        inputSchema: {
          request_id: turnTokenSchema,
          final_answer: z.string().min(1).max(5_000_000),
        },
        outputSchema: {
          completed: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

  await server.connect(observeMcpToolCalls(options.transport, BRIDGE_TOOL_NAMES));
  return server;
}

export async function runChatGptMcpServer(options: {
  brokerSocketPath: string;
  contract?: ChatGptMcpContract;
  screenObserver?:{provider:NativeScreenProvider;grantWireName:string};
}): Promise<void> {
  await createChatGptMcpServer({ ...options, transport: new StdioServerTransport() });
}
