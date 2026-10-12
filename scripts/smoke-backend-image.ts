import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin } from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_CHATGPT_CONNECTOR_NAME, loadConfig } from "../src/config";
import { inspectLauncherBrowserHost } from "../src/launcher-browser-host";
import { responseRequest } from "../src/server";
import { DEV_CHAT_TOOLS, createLauncherDevAdapter } from "../src/dev-chat/driver";
import { startDevChatTransport } from "../src/dev-chat/transport";
import { activateDevProfileEnvironment, resolveDevProfilePaths } from "../src/dev-chat/profile";
import { DEV_LAUNCHER_PROFILE, DEV_CONFIG_PURPOSE } from "../src/dev-chat/constants";
import { closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import type { AdapterEvent } from "../src/types";

// Reads one JSON line from stdin: { data, mimeType, mcpElapsedMs?, prompt? }.
// `data` is the base64 field of a real MCP image content block and stays in memory throughout.
const MODEL = "chatgpt-web/gpt-6-sol";

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
  prompt?: unknown;
  threadId?: unknown;
};
if (typeof source.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.data) || source.data.length % 4 !== 0) {
  throw new Error("Input must contain a base64 screenshot from an MCP image content block");
}
if (source.mimeType !== "image/png" && source.mimeType !== "image/jpeg") {
  throw new Error("Only the PNG/JPEG image MIME types returned by desktop.observe are supported");
}
const screenshotBytes = Buffer.from(source.data, "base64");
if (!screenshotBytes.length || screenshotBytes.length > 20_000_000) throw new Error("Screenshot must be between 1 byte and 20 MB");
const prompt = typeof source.prompt === "string" && source.prompt.trim()
  ? source.prompt.trim()
  : "Read the exact verification phrase visible in the attached screenshot. Reply with only that phrase.";
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
const callId = `call_mcp_image_${randomUUID().replaceAll("-", "")}`;
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
const environmentText = `<environment_context>\n  <cwd>${cwd}</cwd>\n  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n  <codex_dev_mode>Image transport smoke test; all local app actions were authorized by the user.</codex_dev_mode>\n</environment_context>`;

try {
  const response = await responseRequest(new Request("http://codex-web-gpt.dev/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      instructions: "You are GPT-6 Sol. The immediately preceding MCP function result contains an actual screenshot as an attached image. Inspect that image directly and answer the user's visual question. Do not ask for a file path or use a shell, PowerShell, or another tool to inspect the image.",
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
          content: [{ type: "input_text", text: prompt }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        { type: "function_call", call_id: callId, name: "mcp__computer_use_swift__desktop_observe", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: callId,
          output: [
            { type: "input_text", text: "ComputerUseSwift-MCP desktop.observe screenshot; the image is attached directly below." },
            { type: "input_image", image_url: `data:${source.mimeType};base64,${source.data}`, detail: "high" },
          ],
        },
      ],
      tools: runtimeConfig.mode === "full" ? DEV_CHAT_TOOLS : [],
      tool_choice: "none",
      reasoning: { effort: "high" },
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
  console.log(JSON.stringify({
    ok: true,
    model: MODEL,
    thread_id: threadId,
    mime_type: source.mimeType,
    screenshot_bytes: screenshotBytes.length,
    mcp_elapsed_ms: typeof source.mcpElapsedMs === "number" ? source.mcpElapsedMs : undefined,
    response_id: envelope.id,
    duration_ms: Math.round(performance.now() - startedAt),
    first_reasoning_event_ms: firstReasoningMs,
    first_text_event_ms: firstTextMs,
    usage: envelope.usage,
    answer: outputText(envelope.output),
  }));
} finally {
  await Promise.allSettled([closeChatGptBrowserWorkers(), transport?.close() ?? Promise.resolve()]);
}
