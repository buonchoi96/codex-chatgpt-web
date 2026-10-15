import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { defaultBrokerEndpoint } from "../src/config";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { createChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import { BlockedOperationLedger } from "../src/adapters/chatgpt-web/blocked-operation-ledger";
import { chatGptWebBrokerResult } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
const cwd = process.cwd();
const environmentXml = `<environment_context>
<cwd>${cwd}</cwd>
<filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

function testRequest() {
  const threadId = `safety-${process.pid}-${Date.now()}`;
  const turnId = `turn-${Date.now()}`;
  const tools = [
    { name: "desktop_observe", namespace: "mcp__computer_use_swift", description: "Observe desktop", parameters: { type: "object" } },
    { name: "exec_command", description: "Run command", parameters: { type: "object" } },
  ];
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools,
      messages: [{ role: "user", content: "Use the native observation tool.", timestamp: 2 }],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId, request_kind: "turn", sandbox: "none" }),
      },
      input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Follow task instructions." }] },
      { type: "message", role: "user", id: "msg_environment", content: [
        { type: "input_text", text: "<recommended_plugins>none</recommended_plugins>" },
        { type: "input_text", text: environmentXml },
      ] },
      {
        type: "message", role: "user", id: "msg_instruction",
        content: [{ type: "input_text", text: "Use the native observation tool." }],
      },
      ],
    },
  } as CodexParsedRequest;
}

function waitForAbort(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("browser owner did not receive safety retirement")), timeoutMs);
    const onAbort = () => finish();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

test("native MCP envelopes preserve explicit false and reject malformed content blocks", () => {
  const parseOutput = (callId: string, output: string) => {
    const parsed = parseRequest({
      model: CHATGPT_WEB_MODEL_ID,
      input: [
        { type: "function_call", call_id: callId, name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: callId, output },
      ],
    });
    const message = parsed.context.messages.find(item => item.role === "toolResult");
    if (!message) throw new Error("Responses parser omitted function_call_output");
    return chatGptWebBrokerResult(message);
  };

  expect(parseOutput("call_native_false", JSON.stringify({
    isError: false,
    content: [{ type: "text", text: "completed" }],
    structuredContent: { receipt: "native-false" },
  }))).toMatchObject({
    isError: false,
    content: [{ type: "text", text: "completed" }],
    structuredContent: { receipt: "native-false" },
  });

  const malformed = parseOutput("call_native_malformed", JSON.stringify({
    isError: true,
    content: [{ type: "image", data: 7, mimeType: "image/png" }],
  }));
  expect(malformed.isError).toBe(false);
  expect(malformed.content[0]).toMatchObject({ type: "text" });
  expect((malformed.content[0] as { text: string }).text).toContain('"isError":true');
  expect(parseOutput('call_empty_safety',JSON.stringify({isError:true,content:[],
    structuredContent:{error:{code:'safety_status_unknown_or_blocked'}}})))
    .toMatchObject({isError:true,content:[],structuredContent:{error:{code:'safety_status_unknown_or_blocked'}}});
});

test('a nested successful envelope cannot clear an actual outer tool error',()=>{
 const result=chatGptWebBrokerResult({role:'toolResult',toolCallId:'outer_error_fixture',toolName:'fixture',
  timestamp:1,isError:true,content:JSON.stringify({isError:false,content:[{type:'text',text:'Outer error remains authoritative'}]})});
 expect(result.isError).toBe(true);
});

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("a code-only safety result is returned once, retires broker and browser authority, and rejects later effects", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "cgw-safety-ledger-"));
  const ledger = new BlockedOperationLedger(join(ledgerDir, "blocked.json"));
  const socketPath = defaultBrokerEndpoint(join(tmpdir(), `cgw-safety-retirement-${process.pid}-${Date.now()}`), process.platform);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://safety-retirement-${Date.now()}`,
    chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  };
  const broker = TurnBroker.forSocket(socketPath);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await createChatGptMcpServer({ brokerSocketPath: socketPath, transport: serverTransport, blockedOperationLedger: ledger });
  const client = new Client({ name: "safety-retirement-test", version: "1" });
  await client.connect(clientTransport);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let token = "";
  let sendCount = 0;
  let originalResult: unknown;
  let backupResult: unknown;
  let browserAbortReason: unknown;
  let fakeOwnerPromise: Promise<string> | undefined;
  let firstRoundPromise: Promise<void> | undefined;
  const tokenReady = Promise.withResolvers<string>();
  const originalResultReady = Promise.withResolvers<void>();
  const backupResultReady = Promise.withResolvers<void>();
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
    const owner = (async (): Promise<string> => {
    const prepared = await turn.prepare();
    const abortSignal = turn.abortSignal;
    if (!abortSignal) throw new Error("browser fixture has no abort signal");
    token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1] ?? "";
    if (!token) throw new Error("prepared message omitted its turn token");
    turn.onSendActivated?.();
    sendCount += 1;
    await turn.onSubmitted?.();
    tokenReady.resolve(token);

    const pending = client.callTool({ name: "codex_tool_call", arguments: {
      turn_token: token,
      wire_name: "mcp__computer_use_swift__desktop_observe",
      arguments: {},
    } });
    const progress = turn.externalProgress;
    if (!progress) throw new Error("tool-capable browser fixture has no progress reader");
    let snapshot = progress.snapshot();
    while (snapshot.lastToolBatchRevision === 0) snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
    await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
    try { originalResult = await pending; }
    catch (error) { originalResult = { thrown: error }; }
    originalResultReady.resolve();
    await waitForAbort(abortSignal, 5_000);
    browserAbortReason = abortSignal.reason;

    try {
      backupResult = await client.callTool({ name: "codex_tool_call", arguments: {
        turn_token: token,
        wire_name: "exec_command",
        arguments: { cmd: "must-not-run" },
      } });
    } catch (error) {
      backupResult = error;
    }
    backupResultReady.resolve();
    throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("safety retirement aborted the browser owner");
    })();
    fakeOwnerPromise = owner;
    return owner;
  };

  const adapter = createChatGptWebAdapter(provider);
  const request = testRequest();
  const events: AdapterEvent[] = [];
  const toolCallIds: string[] = [];
  const onEvent = (event: AdapterEvent) => {
    events.push(event);
    if (event.type === "tool_call_start") toolCallIds.push(event.id);
  };
  try {
    const firstRound = adapter.runTurn!(request, { headers: new Headers() }, onEvent);
    firstRoundPromise = firstRound;
    token = await within(tokenReady.promise, 5_000, "browser capability registration");
    const deadline = Date.now() + 5_000;
    while (toolCallIds.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(toolCallIds).toHaveLength(1);
    const callId = toolCallIds[0]!;
    const serializedMcpResult = JSON.stringify({
      isError: true,
      content: [{ type: "text", text: "Native operation may have started; completion is uncertain." }],
      structuredContent: { error: { code: "safety_status_unknown_or_blocked" } },
      _meta: { receipt: "uncertain-execution-fixture" },
    });
    const splitAt = serializedMcpResult.indexOf(',"structuredContent"');
    expect(splitAt).toBeGreaterThan(0);
    const parsedNativeOutput = parseRequest({
      model: CHATGPT_WEB_MODEL_ID,
      input: [
        { type: "function_call", call_id: callId, name: "mcp__computer_use_swift__desktop_observe", arguments: "{}" },
        { type: "function_call_output", call_id: callId, output: [
          { type: "output_text", text: "" },
          { type: "output_text", text: serializedMcpResult.slice(0, splitAt) },
          { type: "input_image", image_url: `data:image/png;base64,${png}` },
          { type: "output_text", text: serializedMcpResult.slice(splitAt) },
        ] },
      ],
    });
    const nativeToolResult = parsedNativeOutput.context.messages.find(message => message.role === "toolResult");
    expect(nativeToolResult).toBeDefined();
    const refusalResult: BrokerToolResult = chatGptWebBrokerResult(nativeToolResult!);
    expect(refusalResult).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: "Native operation may have started; completion is uncertain." },
        { type: "image", data: png, mimeType: "image/png" },
      ],
      structuredContent: { error: { code: "safety_status_unknown_or_blocked" } },
      _meta: { receipt: "uncertain-execution-fixture" },
    });
    broker.completeTool(token, toolCallIds[0]!, refusalResult);
    await within(originalResultReady.promise, 5_000, "original MCP refusal result");
    await within(firstRound, 5_000, "adapter turn settlement");
    await within(backupResultReady.promise, 5_000, "rejected follow-up MCP call");

    expect(originalResult).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: "Native operation may have started; completion is uncertain." },
        { type: "image", data: png, mimeType: "image/png" },
      ],
      structuredContent: { error: { code: "safety_status_unknown_or_blocked" } },
      _meta: { receipt: "uncertain-execution-fixture" },
    });
    expect(browserAbortReason).toMatchObject({
      name: "ChatGptWebAdapterError",
      status: 403,
      errorType: "permission_error",
      code: "safety_status_unknown_or_blocked",
      retryable: false,
    });
    expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
    expect(backupResult).toMatchObject({ isError: true });
    expect(JSON.stringify(backupResult)).toMatch(/already finished|invalid, expired, or revoked/);
    expect(toolCallIds).toHaveLength(1);
    expect(sendCount).toBe(1);
    expect(ledger.unresolved()).toHaveLength(1);
    expect(new BlockedOperationLedger(ledger.filePath).unresolved()[0]).toMatchObject({
      exact_tool_name: "mcp__computer_use_swift__desktop_observe",
      classification: "SAFETY_STATUS_UNDETERMINED", resolution: "PENDING_SAFETY_REVIEW",
      dispatch_state: "unknown", attempts: 1,
    });
    await expect(broker.nextToolBatch(token)).rejects.toThrow(/invalid or expired/);
  } finally {
    if (token) broker.revoke(token, new Error("safety retirement fixture cleanup"));
    if (fakeOwnerPromise) await within(fakeOwnerPromise.then(() => undefined, () => undefined), 5_000, "fake browser owner cleanup").catch(() => {});
    if (firstRoundPromise) await within(firstRoundPromise, 5_000, "adapter observer cleanup").catch(() => {});
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await client.close().catch(() => {});
    await mcp.close();
    await broker.close();
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
