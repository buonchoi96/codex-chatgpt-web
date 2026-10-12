import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin } from "node:process";
import { resolve } from "node:path";
import { DEV_CHATGPT_CONNECTOR_NAME, loadConfig } from "../src/config";
import { inspectLauncherBrowserHost } from "../src/launcher-browser-host";
import { responseRequest } from "../src/server";
import { DEV_CHAT_TOOLS, createLauncherDevAdapter } from "../src/dev-chat/driver";
import { startDevChatTransport } from "../src/dev-chat/transport";
import { activateDevProfileEnvironment, resolveDevProfilePaths } from "../src/dev-chat/profile";
import { DEV_LAUNCHER_PROFILE, DEV_CONFIG_PURPOSE } from "../src/dev-chat/constants";
import { closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import type { AdapterEvent } from "../src/types";
import {
  BACKEND_IMAGE_SMOKE_MODELS,
  buildImageSelfAssessmentPrompt,
  buildImageSmokeToolHistory,
  evaluateImageSelfAssessment,
  resolveBackendImageSmokeModel,
  type BackendImageSmokeObservation,
  type BackendImageSmokeTool,
} from "./backend-image-smoke-contract";

// Reads one JSON line from stdin with either `observations` or the legacy singular image fields.
// `data` is the base64 field of a real MCP image content block and stays in memory throughout.

function readOneLine(): Promise<string> {
  const reader = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
  return new Promise((resolveLine, reject) => {
    reader.once("line", line => {
      reader.close();
      resolveLine(line);
    });
    reader.once("error", reject);
  });
}

function outputText(items: unknown[]): string {
  return items.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as { type?: unknown; phase?: unknown; content?: unknown };
    if (record.type !== "message" || record.phase === "commentary" || !Array.isArray(record.content)) return [];
    return record.content.flatMap(block => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return [];
      const text = block as { type?: unknown; text?: unknown };
      return text.type === "output_text" && typeof text.text === "string" ? [text.text] : [];
    });
  }).join("");
}

const source = JSON.parse(await readOneLine()) as {
  data?: unknown;
  mimeType?: unknown;
  mcpElapsedMs?: unknown;
  expectedMarker?: unknown;
  expectedMarkers?: unknown;
  model?: unknown;
  observations?: unknown;
  threadId?: unknown;
  tool?: unknown;
};
const model = resolveBackendImageSmokeModel(source.model);
const rawObservations = Array.isArray(source.observations)
  ? source.observations
  : [{
    tool: source.tool ?? "mcp__computer_use_swift__desktop_observe",
    data: source.data,
    mimeType: source.mimeType,
    mcpElapsedMs: source.mcpElapsedMs,
    expectedMarkers: source.expectedMarkers ?? (source.expectedMarker === undefined ? [] : [source.expectedMarker]),
  }];
if (rawObservations.length < 1 || rawObservations.length > 4) {
  throw new Error("Image smoke requires between one and four MCP observations");
}
const validTools = new Set<BackendImageSmokeTool>([
  "mcp__computer_use_swift__desktop_observe",
  "mcp__computer_use_swift__desktop_execute_and_observe",
]);
const observations: BackendImageSmokeObservation[] = rawObservations.map((value, index) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Observation ${index + 1} must be an object`);
  const item = value as Record<string, unknown>;
  if (!validTools.has(item.tool as BackendImageSmokeTool)) throw new Error(`Observation ${index + 1} must come from desktop.observe or desktop.execute_and_observe`);
  if (typeof item.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data) || item.data.length % 4 !== 0) {
    throw new Error(`Observation ${index + 1} must contain base64 from a native MCP image content block`);
  }
  if (item.mimeType !== "image/png" && item.mimeType !== "image/jpeg") throw new Error(`Observation ${index + 1} must be PNG or JPEG`);
  const bytes = Buffer.from(item.data, "base64");
  if (!bytes.length || bytes.length > 20_000_000) throw new Error(`Observation ${index + 1} image must be between 1 byte and 20 MB`);
  if (!Array.isArray(item.expectedMarkers) || item.expectedMarkers.length < 1
    || item.expectedMarkers.some(marker => typeof marker !== "string" || !/^\d{2,32}$/.test(marker))) {
    throw new Error(`Observation ${index + 1} must include one or more numeric expectedMarkers for host-side verification`);
  }
  if (item.mcpElapsedMs !== undefined && (typeof item.mcpElapsedMs !== "number" || !Number.isFinite(item.mcpElapsedMs) || item.mcpElapsedMs < 0)) {
    throw new Error(`Observation ${index + 1} has an invalid mcpElapsedMs value`);
  }
  return {
    tool: item.tool as BackendImageSmokeTool,
    data: item.data,
    mimeType: item.mimeType,
    expectedMarkers: item.expectedMarkers as string[],
    ...(typeof item.mcpElapsedMs === "number" ? { mcpElapsedMs: item.mcpElapsedMs } : {}),
  };
});
if (source.threadId !== undefined && (typeof source.threadId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(source.threadId))) {
  throw new Error("threadId must be 8-128 ASCII letters, digits, underscores, or hyphens");
}

const paths = activateDevProfileEnvironment(resolveDevProfilePaths());
const config = loadConfig();
if (config.purpose !== DEV_CONFIG_PURPOSE || config.browserHost !== "launcher" || !config.browserHostDescriptorPath) {
  throw new Error("Image smoke tests require the isolated DEV launcher profile");
}
if (config.mode === "full" && config.appName !== DEV_CHATGPT_CONNECTOR_NAME) {
  throw new Error("Image smoke tests require the isolated DEV connector identity");
}
await inspectLauncherBrowserHost(config.browserHostDescriptorPath, { expectedProfile: DEV_LAUNCHER_PROFILE });

const helperPath = resolve(import.meta.dir, "../.launcher-runtime/browser-helper.cjs");
if (!existsSync(helperPath)) throw new Error("The DEV browser helper is missing; start launcher:dev first");
const transport = config.mode === "full" ? await startDevChatTransport(config, paths.runtimePath) : undefined;
const runtimeConfig = transport?.config ?? config;
const runtime = createLauncherDevAdapter(runtimeConfig, paths.runtimePath, {
  ...(transport ? { broker: transport.broker } : {}),
  browserHelperScriptPath: helperPath,
});
const threadId = typeof source.threadId === "string"
  ? source.threadId
  : `dev_mcp_image_${randomUUID().replaceAll("-", "")}`;
const turnId = `turn_mcp_image_${randomUUID().replaceAll("-", "")}`;
const cwd = resolve(process.cwd());
const startedAt = performance.now();
let firstReasoningMs: number | undefined;
let firstTextMs: number | undefined;
const turnMetadata = JSON.stringify({
  thread_id: threadId,
  turn_id: turnId,
  request_kind: "turn",
  sandbox: "none",
  workspaces: { [cwd]: {} },
});
const environmentText = `<environment_context>\n  <cwd>${cwd}</cwd>\n  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n  <codex_dev_mode>Image transport self-assessment smoke test; all local app actions were authorized by the user.</codex_dev_mode>\n</environment_context>`;

try {
  const response = await responseRequest(new Request("http://codex-web-gpt.dev/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      instructions: `You are ${model.label}. Inspect the MCP image attachments directly and answer only from the pixels you can see. Do not ask for a file path or use a shell, PowerShell, or another tool to inspect an image.`,
      input: [
        {
          type: "message",
          id: `msg_mcp_image_environment_${randomUUID().replaceAll("-", "")}`,
          role: "user",
          content: [{ type: "input_text", text: environmentText }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message",
          id: `msg_mcp_image_question_${randomUUID().replaceAll("-", "")}`,
          role: "user",
          content: [{ type: "input_text", text: buildImageSelfAssessmentPrompt(observations) }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        ...buildImageSmokeToolHistory(observations, index => `call_mcp_image_${index + 1}_${randomUUID().replaceAll("-", "")}`),
      ],
      tools: runtimeConfig.mode === "full" ? DEV_CHAT_TOOLS : [],
      tool_choice: "none",
      reasoning: { effort: model.effort },
      stream: false,
      store: false,
      prompt_cache_key: threadId,
      client_metadata: { "x-codex-turn-metadata": turnMetadata },
      metadata: { codex_chatgpt_web_mcp_image_smoke: true },
    }),
  }), runtimeConfig, runtime.adapterFactory, {
    rememberState: false,
    onAdapterEvent: (event: AdapterEvent) => {
      const elapsed = Math.round(performance.now() - startedAt);
      if (event.type === "thinking_delta" && firstReasoningMs === undefined) firstReasoningMs = elapsed;
      if (event.type === "text_delta" && event.phase !== "commentary" && firstTextMs === undefined) firstTextMs = elapsed;
    },
  });
  const envelope = await response.json() as {
    id?: string;
    status?: string;
    output?: unknown[];
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    error?: { message?: string; code?: string };
    incomplete_details?: { reason?: string; message?: string };
  };
  if (!response.ok || envelope.status !== "completed" || !Array.isArray(envelope.output)) {
    throw new Error(envelope.error?.message ?? envelope.incomplete_details?.message ?? envelope.incomplete_details?.reason ?? `Responses returned HTTP ${response.status} / ${envelope.status ?? "unknown"}`);
  }
  const answer = outputText(envelope.output);
  const selfAssessment = evaluateImageSelfAssessment(answer, observations);
  const result = {
    ok: selfAssessment.pass,
    model: model.id,
    model_label: model.label,
    thread_id: threadId,
    observations: observations.map(observation => ({
      tool: observation.tool,
      mime_type: observation.mimeType,
      screenshot_bytes: Buffer.from(observation.data, "base64").length,
      mcp_elapsed_ms: observation.mcpElapsedMs,
    })),
    response_id: envelope.id,
    duration_ms: Math.round(performance.now() - startedAt),
    first_reasoning_event_ms: firstReasoningMs,
    first_text_event_ms: firstTextMs,
    usage: envelope.usage,
    self_assessment: selfAssessment,
    answer,
  };
  console.log(JSON.stringify(result));
  if (!selfAssessment.pass) process.exitCode = 1;
} finally {
  await Promise.allSettled([closeChatGptBrowserWorkers(), transport?.close() ?? Promise.resolve()]);
}
