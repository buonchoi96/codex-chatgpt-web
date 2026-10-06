import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnhancedRecoveryCheckpointStore } from "../src/adapters/chatgpt-web/enhanced-recovery-checkpoint";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

test.each([true, false])("delta compaction sends reduced input and canonicalizes original evidence (launcher=%s)", async launcher => {
  const root = mkdtempSync(join(tmpdir(), "cgd-input-"));
  const path = join(root, "checkpoint.json");
  const evidence = "x".repeat(180_000) + " EXACT_SENTINEL_A9";
  const source: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
    context: { messages: [
      { role: "user", content: "Inspect the file and preserve the probe.", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "inspect", arguments: { path: "src/original.ts" } }], timestamp: 2 },
      { role: "toolResult", toolCallId: "read-1", toolName: "inspect", content: evidence, isError: false, timestamp: 3 },
    ] }, _rawBody: { input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the file and preserve the probe." }] },
      { type: "function_call", call_id: "read-1", name: "inspect", arguments: JSON.stringify({ path: "src/original.ts" }) },
      { type: "function_call_output", call_id: "read-1", output: evidence },
    ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `delta-input-${launcher}-${Date.now()}`, turn_id: "source" }) } } };
  new EnhancedRecoveryCheckpointStore(path).commit(source, "Objective: preserve probe. Evidence inspected. Pending: validate.");
  const compact = structuredClone(source);
  compact._compactionRequest = true;
  compact.context.messages.push({ role: "user", content: "LATEST_REQUIREMENT_B7: validate after compaction", timestamp: 4 });
  (compact._rawBody as { input: unknown[] }).input.push({ type: "message", role: "user",
    content: [{ type: "input_text", text: "LATEST_REQUIREMENT_B7: validate after compaction" }],
    internal_chat_message_metadata_passthrough: { turn_id: "source" } }, { type: "compaction_trigger" });
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://${root}`, chatgptWeb: {
    ...(launcher ? { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json") } : {}),
    enhancedRecoveryCheckpointStatePath: path, brokerSocketPath: defaultBrokerEndpoint(root),
    localToolsEnabled: launcher, solAvailable: true, extraHighAvailable: true, proAvailable: true } };
  expect(compileChatGptWebPrompt(compact, { localToolsEnabled: false, solAvailable: true,
    extraHighAvailable: true, proAvailable: true }).archive).toBeDefined();
  const worker = ChatGptBrowserWorker.forProvider(provider), original = worker.run;
  let runs = 0;
  worker.run = async (turn: BrowserTurn) => {
    runs++;
    expect(turn.compaction).toBeTrue();
    expect(turn.conversationKey).toBeUndefined();
    const prepared = await turn.prepare();
    expect(prepared.archive).toBeUndefined();
    const text = prepared.contextFile?.text ?? prepared.text;
    expect(text).not.toContain("x".repeat(1000));
    expect(text).toContain("LATEST_REQUIREMENT_B7");
    expect(text).toContain("EXACT_SENTINEL_A9");
    prepared.release();
    turn.onTextDelta("Semantic continuation: finish validation.");
    return "Semantic continuation: finish validation.";
  };
  try {
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider, { launcherAutomationSecurityStatus: async () => ({ version: 1, paused: false,
      revision: 0, signal: null, detectedAt: null, resumedAt: null }) }).runTurn!(compact, { headers: new Headers() }, event => events.push(event));
    const output = events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("");
    expect(runs).toBe(1);
    expect(output).toContain('"prefixLength":4');
    expect(output).toContain('"callId":"read-1"');
    expect(output).toContain("src/original.ts");
    expect(output).toContain("EXACT_SENTINEL_A9");
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally {
    worker.run = original;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});
